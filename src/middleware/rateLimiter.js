/**
 * src/middleware/rateLimiter.js
 * ---------------------------------------------------------------------
 * 基于 MongoDB 的限流中间件（本脚手架的核心防刷卖点）。
 *
 * 设计要点：
 *  1. 使用「固定时间窗口 + 原子自增计数器」实现，数据落在 MongoDB，
 *     因此天生支持多实例水平扩展（多个 Node 进程共享同一份计数）。
 *  2. 计数通过 findOneAndUpdate + $inc 原子完成，并发下不会漏记（无竞态）。
 *  3. 每个窗口的计数文档挂 TTL 索引，窗口结束后自动清理，集合不会无限增长。
 *  4. 超限时返回标准 429 + 友好 JSON，并附标准限流响应头（Retry-After 等）。
 *  5. 被拦截的请求会写入 RequestLog（blocked=true），便于后台审计刷接口行为。
 *
 * 扩展说明：
 *  - 需要「滑动窗口」更精细的限流时，可替换 consumeWindow 内部实现，
 *    对外接口保持不变，路由层无需改动（高扩展性）。
 */
import mongoose from 'mongoose';
import RequestLog from '../models/RequestLog.js';

// ---------------------------------------------------------------------
// 1. 限流计数模型（内部专用，与业务 RequestLog 分离，避免相互污染）
// ---------------------------------------------------------------------
const rateLimitSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },          // 限流维度标识，如 "1.2.3.4:minute"
    windowStart: { type: Date, required: true },    // 当前窗口的起点（已按窗口宽度取整）
    count: { type: Number, default: 0 },            // 窗口内累计请求数
    expireAt: { type: Date, required: true },       // 到期时间（用于 TTL 自动删除）
  },
  { versionKey: false }
);

// 每个 key + windowStart 唯一，保证同一窗口内复用同一计数文档
rateLimitSchema.index({ key: 1, windowStart: 1 }, { unique: true });
// TTL 索引：文档到期后由 MongoDB 自动删除
rateLimitSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

const RateLimit = mongoose.models.RateLimit || mongoose.model('RateLimit', rateLimitSchema);

// ---------------------------------------------------------------------
// 2. 工具函数
// ---------------------------------------------------------------------

// 把当前时间向下取整到所属窗口的起点（例如 60s 窗口 -> 整分钟）
function truncateToWindow(date, windowMs) {
  return new Date(Math.floor(date.getTime() / windowMs) * windowMs);
}

/**
 * 原子地给指定窗口计数 +1，并返回递增后的值。
 * upsert + $inc 保证并发安全：不存在则创建，存在则原子自增。
 */
async function consumeWindow(key, windowStart, windowMs) {
  // 到期时间比窗口结束再多留 60s，容忍 MongoDB TTL 监控的扫描周期（约 60s 一次）
  const expireAt = new Date(windowStart.getTime() + windowMs + 60_000);
  const doc = await RateLimit.findOneAndUpdate(
    { key, windowStart },
    { $inc: { count: 1 }, $setOnInsert: { expireAt } },
    { upsert: true, new: true } // new:true 返回自增后的文档
  );
  return doc.count;
}

/**
 * 记录一条「被拦截」的请求日志，用于后台安全审计。
 * 日志写入失败绝不能影响限流本身，故整体 try/catch 吞掉错误。
 */
async function logBlockedRequest(req, { label, count, max }) {
  try {
    await RequestLog.create({
      ip: req.ip,
      userId: req.user?.id ?? null, // TODO: 接入 JWT 后自动填充
      method: req.method,
      endpoint: req.originalUrl,
      model: req.body?.model ?? '',
      statusCode: 429,
      blocked: true,
      errorMessage: `限流拦截：${label} 窗口超出上限（${count}/${max}）`,
    });
  } catch (err) {
    console.error('[RateLimit] ⚠️ 记录拦截日志失败:', err.message);
  }
}

// ---------------------------------------------------------------------
// 3. 限流中间件工厂：按需生成任意窗口 / 上限的限流器（高扩展性）
// ---------------------------------------------------------------------
/**
 * @param {Object} opts
 * @param {number} opts.windowMs  时间窗口宽度（毫秒）
 * @param {number} opts.max       窗口内允许的最大请求数
 * @param {string} opts.label     窗口名称（用于日志与错误提示，如 "minute"/"day"）
 * @param {boolean} opts.failOpen 依赖的 MongoDB 异常时是否放行（true=放行，false=拦截）
 */
export function rateLimiter({ windowMs, max, label = 'request', failOpen = true }) {
  return async function rateLimitMiddleware(req, res, next) {
    // 优先按用户限流（已登录），否则回退到 IP
    // TODO: 接入 JWT 认证后，req.user.id 由 auth.middleware.js 注入
    const identifier = req.user?.id ?? req.ip;

    const now = new Date();
    const windowStart = truncateToWindow(now, windowMs);
    const key = `${identifier}:${label}`;

    try {
      const count = await consumeWindow(key, windowStart, windowMs);
      const remaining = Math.max(0, max - count);
      const resetAt = new Date(windowStart.getTime() + windowMs);

      // 无论是否超限，都返回标准限流响应头，方便客户端/网关感知
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', Math.floor(resetAt.getTime() / 1000));

      if (count > max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
        res.setHeader('Retry-After', retryAfterSeconds);

        await logBlockedRequest(req, { label, count, max });

        // 标准 429 + 友好 JSON 错误提示
        return res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `请求过于频繁，已超出「${label}」窗口上限（${max} 次），请在 ${retryAfterSeconds} 秒后重试。`,
            retryAfter: retryAfterSeconds,
          },
        });
      }

      next();
    } catch (err) {
      // 限流依赖 MongoDB，若库异常时策略如下：
      //   failOpen=true  → 放行（优先可用性，但暂时失去防护）
      //   failOpen=false → 拦截（优先安全，宁可误伤也不放过）
      console.error('[RateLimit] ❌ 限流检查失败:', err.message);
      if (failOpen) return next();
      return res.status(503).json({
        success: false,
        error: { code: 'RATE_LIMITER_UNAVAILABLE', message: '服务繁忙，请稍后再试。' },
      });
    }
  };
}

// ---------------------------------------------------------------------
// 4. 预置的 DeepSeek 专用限流器（同一 IP：每分钟 5 次 + 每天 100 次）
//    阈值全部来自 .env，可在不改代码的情况下调整
// ---------------------------------------------------------------------
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const failOpen = process.env.RATE_LIMIT_FAIL_OPEN !== 'false'; // 默认放行（可用性优先）

export const minuteLimiter = rateLimiter({
  windowMs: MINUTE,
  max: parseInt(process.env.RATE_LIMIT_MINUTE_MAX || '5', 10),
  label: 'minute',
  failOpen,
});

export const dayLimiter = rateLimiter({
  windowMs: DAY,
  max: parseInt(process.env.RATE_LIMIT_DAY_MAX || '100', 10),
  label: 'day',
  failOpen,
});

// 组合导出：在路由中用 ...deepSeekRateLimiter 展开即可一次性挂载双重限流
export const deepSeekRateLimiter = [minuteLimiter, dayLimiter];
