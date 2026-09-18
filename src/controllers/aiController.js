/**
 * src/controllers/aiController.js
 * ---------------------------------------------------------------------
 * DeepSeek API 调用控制器（服务端代理，本脚手架的核心业务代码）。
 *
 * 为什么必须走「服务端代理」而不是让前端直连 DeepSeek？
 *  1. API Key 只存在于 .env（服务端），绝不暴露给浏览器。
 *  2. 可以在服务端统一做输入校验、Token 上限、超时兜底、用量审计。
 *  3. 未来接入 Stripe 计费时，可在此层按 Token 消耗扣费（解耦点）。
 *
 * 支持两种返回模式：
 *  - stream=true（默认）：SSE 流式输出，边生成边返回，体验更佳。
 *  - stream=false       ：普通 JSON，一次性返回完整结果。
 */
import RequestLog from '../models/RequestLog.js';

// ---------------------------------------------------------------------
// 1. 从 .env 读取全部配置（配置驱动原则：绝不硬编码）
// ---------------------------------------------------------------------
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_BASE_URL = (process.env.DEEPSEEK_API_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
// 默认使用 deepseek-v4-flash（旧别名 deepseek-chat/deepseek-reasoner 已于 2026-07 弃用）
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const DEEPSEEK_TIMEOUT_MS = parseInt(process.env.DEEPSEEK_TIMEOUT_MS || '60000', 10);
const DEEPSEEK_CONNECT_TIMEOUT_MS = parseInt(process.env.DEEPSEEK_CONNECT_TIMEOUT_MS || '15000', 10);
// 服务端强制限制的最大输出 token，防止恶意请求烧钱（安全卖点）
const DEEPSEEK_MAX_TOKENS = parseInt(process.env.DEEPSEEK_MAX_TOKENS || '4096', 10);
const DEEPSEEK_TEMPERATURE = parseFloat(process.env.DEEPSEEK_TEMPERATURE || '0.7');
const MAX_INPUT_MESSAGES = parseInt(process.env.MAX_INPUT_MESSAGES || '50', 10);
const MAX_INPUT_CHARS = parseInt(process.env.MAX_INPUT_CHARS || '20000', 10);

// ---------------------------------------------------------------------
// 2. 基础工具函数
// ---------------------------------------------------------------------

// 构建请求上游的 HTTP 头（密钥只在这里出现，且仅存在于服务端内存）
function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
  };
}

// 统一 JSON 错误响应格式
function sendJsonError(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

// 把上游（DeepSeek）的错误映射为我们自己的状态码与友好文案
function parseUpstreamError(status, data) {
  const upstreamMsg = data?.error?.message || data?.message || '未知上游错误';
  if (status === 401) return { status: 502, code: 'UPSTREAM_AUTH_FAILED', message: 'DeepSeek API Key 无效或已过期' };
  if (status === 402) return { status: 502, code: 'UPSTREAM_INSUFFICIENT_BALANCE', message: 'DeepSeek 账户余额不足' };
  if (status === 429) return { status: 429, code: 'UPSTREAM_RATE_LIMITED', message: '上游模型请求过多，请稍后重试' };
  if (status >= 500) return { status: 502, code: 'UPSTREAM_ERROR', message: '上游大模型服务暂时不可用' };
  return { status: 502, code: 'UPSTREAM_ERROR', message: upstreamMsg };
}

// 严格校验请求体（防刷：在请求到达上游之前先做输入侧限制）
function validateChatRequest(body) {
  if (!body || typeof body !== 'object') return '请求体必须为 JSON 对象';
  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) return 'messages 必须是非空数组';
  if (messages.length > MAX_INPUT_MESSAGES) return `消息数量超过上限（${MAX_INPUT_MESSAGES} 条）`;

  let totalChars = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') return '每条消息必须是对象';
    if (typeof msg.role !== 'string' || !msg.role) return '每条消息必须包含有效的 role 字段';
    const content = msg.content;
    if (typeof content === 'string') totalChars += content.length;
    else if (Array.isArray(content)) totalChars += JSON.stringify(content).length;
    else return '消息 content 必须为字符串或数组';
  }
  if (totalChars > MAX_INPUT_CHARS) return `输入总长度超过上限（${MAX_INPUT_CHARS} 字符）`;
  return null;
}

// 记录请求日志（含 Token 消耗）。日志失败不影响主流程，故整体 try/catch。
async function logRequest(req, { statusCode, usage, errorMessage, model, startedAt }) {
  try {
    await RequestLog.create({
      ip: req.ip,
      userId: req.user?.id ?? null, // TODO: 接入 JWT 后自动填充
      method: req.method,
      endpoint: req.originalUrl,
      model: model || DEEPSEEK_MODEL,
      statusCode,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      durationMs: Date.now() - startedAt,
      errorMessage: errorMessage || '',
    });
  } catch (err) {
    console.error('[AI] ⚠️ 记录请求日志失败:', err.message);
  }
}

// ---------------------------------------------------------------------
// 3. 控制器方法
// ---------------------------------------------------------------------

// GET /models —— 返回当前可用模型（供前端/客户端发现）
export function listModels(_req, res) {
  res.json({ success: true, data: [{ id: DEEPSEEK_MODEL, object: 'model' }] });
}

// POST /chat/completions —— 主入口：校验 -> 组装 -> 分流（SSE / JSON）
export async function chatCompletion(req, res) {
  const startedAt = Date.now();

  // 3.1 严格校验请求体
  const validationError = validateChatRequest(req.body);
  if (validationError) {
    await logRequest(req, { statusCode: 400, errorMessage: validationError, startedAt });
    return sendJsonError(res, 400, 'INVALID_REQUEST', validationError);
  }

  // 3.2 检查 API Key 是否已配置
  if (!DEEPSEEK_API_KEY) {
    const msg = '服务端未配置 DEEPSEEK_API_KEY，请在 .env 中设置。';
    await logRequest(req, { statusCode: 500, errorMessage: msg, startedAt });
    return sendJsonError(res, 500, 'MISSING_API_KEY', msg);
  }

  const { messages, stream = true, temperature, max_tokens } = req.body;

  // 3.3 夹紧参数，防止客户端传入越界值（烧钱/异常）
  const safeTemperature = Math.min(Math.max(0, Number.isFinite(temperature) ? temperature : DEEPSEEK_TEMPERATURE), 2);
  const safeMaxTokens = Math.min(
    Math.max(1, Number.isInteger(max_tokens) ? max_tokens : DEEPSEEK_MAX_TOKENS),
    DEEPSEEK_MAX_TOKENS
  );

  // 3.4 组装上游请求体（model 强制使用服务端配置，忽略客户端传入值，防越权）
  const payload = {
    model: DEEPSEEK_MODEL,
    messages,
    stream,
    temperature: safeTemperature,
    max_tokens: safeMaxTokens,
  };

  // DeepSeek V4 支持 thinking.type 控制思考模式（disabled / enabled），
  // 在 .env 中配置 DEEPSEEK_THINKING_TYPE 才会携带，留空则使用模型默认。
  if (process.env.DEEPSEEK_THINKING_TYPE) {
    payload.thinking = { type: process.env.DEEPSEEK_THINKING_TYPE };
  }

  // 流式模式下请求上游在最后一个 chunk 附带 usage，用于精确统计 Token
  if (stream) {
    payload.stream_options = { include_usage: true };
  }

  // 3.5 分流
  if (stream) {
    return handleStreaming(req, res, payload, startedAt);
  }
  return handleNonStreaming(req, res, payload, startedAt);
}

// ---------------------------------------------------------------------
// 4. 非流式（普通 JSON）处理
// ---------------------------------------------------------------------
async function handleNonStreaming(req, res, payload, startedAt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS);

  try {
    const upstream = await fetch(`${DEEPSEEK_API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await upstream.json().catch(() => null);

    // 上游返回非 2xx
    if (!upstream.ok) {
      const { status, code, message } = parseUpstreamError(upstream.status, data);
      await logRequest(req, { statusCode: status, errorMessage: message, startedAt });
      return sendJsonError(res, status, code, message);
    }

    // 成功：记录 Token 消耗后原样返回
    await logRequest(req, { statusCode: 200, usage: data?.usage, model: payload.model, startedAt });
    return res.json({ success: true, data });
  } catch (err) {
    if (err.name === 'AbortError') {
      await logRequest(req, { statusCode: 504, errorMessage: '上游响应超时', startedAt });
      return sendJsonError(res, 504, 'UPSTREAM_TIMEOUT', '大模型响应超时，请稍后重试。');
    }
    await logRequest(req, { statusCode: 502, errorMessage: err.message, startedAt });
    return sendJsonError(res, 502, 'UPSTREAM_ERROR', '调用大模型失败，请稍后重试。');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------
// 5. SSE 流式处理
//    归一化的 SSE 事件格式（方便前端统一解析）：
//      data: {"type":"delta","content":"...","reasoning_content":"...","finish_reason":null}
//      data: {"type":"done","usage":{...}}
//      data: [DONE]
// ---------------------------------------------------------------------
async function handleStreaming(req, res, payload, startedAt) {
  // 5.1 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 关闭 nginx 等反向代理缓冲，避免 SSE 卡顿
  res.flushHeaders();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS);

  // 客户端中途断开时，立即中止上游请求，避免泄漏连接
  const onClose = () => controller.abort();
  req.on('close', onClose);

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;

  // 在头部已发出的前提下，统一用 SSE 事件把错误/结束信息推给前端
  const emitError = (message) => {
    res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    res.write('data: [DONE]\n\n');
  };

  try {
    const upstream = await fetch(`${DEEPSEEK_API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    // 上游在返回首字节前就报错（鉴权失败 / 余额不足 / 4xx 等）
    if (!upstream.ok || !upstream.body) {
      const data = await upstream.json().catch(() => null);
      const { message } = parseUpstreamError(upstream.status, data);
      emitError(message);
      await logRequest(req, { statusCode: upstream.status, errorMessage: message, startedAt });
      return res.end();
    }

    // 5.2 逐行解析上游 SSE 数据流
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔；最后一行可能不完整，留在 buffer 中下次继续
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue; // 结束标记，交由循环外的 done 事件统一收尾

        try {
          const chunk = JSON.parse(data);
          const choice = chunk.choices?.[0] ?? {};
          const delta = choice.delta ?? {};

          // DeepSeek V4 思考模式会额外返回 reasoning_content，一并透传
          const content = delta.content ?? '';
          const reasoning = delta.reasoning_content ?? '';
          const finishReason = choice.finish_reason ?? null;

          // 捕获 usage：开启 include_usage 后，最后一个数据 chunk 会携带完整统计
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
            completionTokens = chunk.usage.completion_tokens ?? completionTokens;
            totalTokens = chunk.usage.total_tokens ?? totalTokens;
          }

          if (content || reasoning || finishReason) {
            res.write(
              `data: ${JSON.stringify({ type: 'delta', content, reasoning_content: reasoning, finish_reason: finishReason })}\n\n`
            );
          }
        } catch {
          // 忽略无法解析的行（如 SSE 注释行 / 心跳行）
        }
      }
    }

    // 5.3 正常结束：发送 done 事件与 [DONE]
    res.write(
      `data: ${JSON.stringify({ type: 'done', usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } })}\n\n`
    );
    res.write('data: [DONE]\n\n');

    await logRequest(req, {
      statusCode: 200,
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
      model: payload.model,
      startedAt,
    });
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') {
      emitError('大模型响应超时，请稍后重试。');
      await logRequest(req, { statusCode: 504, errorMessage: '上游响应超时', startedAt });
    } else {
      emitError('流式响应中断，请稍后重试。');
      await logRequest(req, { statusCode: 502, errorMessage: err.message, startedAt });
    }
    res.end();
  } finally {
    clearTimeout(timer);
    req.off('close', onClose);
  }
}
