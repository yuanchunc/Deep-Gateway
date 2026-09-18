/**
 * src/app.js
 * ---------------------------------------------------------------------
 * Express 应用装配层 —— 负责挂载所有中间件与路由（不负责启动监听）。
 *
 * 与 server.js 分离的原因（高扩展性 / 可测试性）：
 *  - app.js 导出 app，可被 supertest 等测试框架直接 import 做集成测试，
 *    无需真正监听端口。
 *  - server.js 只负责「连数据库 + 启动监听 + 优雅退出」这一生命周期。
 *
 * 中间件挂载顺序（重要）：
 *  安全类（helmet/cors）→ 日志 → 解析 → 路由 → 404 → 全局错误处理
 */
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import aiRoutes from './routes/aiRoutes.js';
import authRoutes from './routes/authRoutes.js';

const app = express();

// 部署在反向代理（Docker / nginx / 负载均衡）后面时，需信任代理头，
// 否则 req.ip 拿到的是代理地址而非真实客户端 IP，限流会失效。
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// ---------------------------------------------------------------------
// 安全 / 基础中间件
// ---------------------------------------------------------------------

// helmet：设置一系列安全响应头，防常见 Web 攻击
app.use(helmet());

// CORS：允许的来源来自 .env（配置驱动），* 表示全部允许
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : '*';
app.use(cors({ origin: corsOrigin }));

// gzip 压缩响应，节省带宽
app.use(compression());

// 解析 JSON 请求体，限制 1MB 防止超大请求体攻击
app.use(express.json({ limit: '1mb' }));

// 结构化日志（pino 输出 JSON 到 stdout，便于 Docker / K8s 采集）
app.use(pinoHttp({ level: process.env.LOG_LEVEL || 'info' }));

// ---------------------------------------------------------------------
// 健康检查（Dockerfile 的 HEALTHCHECK 依赖此路由）
// ---------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ---------------------------------------------------------------------
// 业务路由挂载点（新增模块在此统一挂载）
// ---------------------------------------------------------------------
app.use('/api/v1/ai', aiRoutes);

// 认证路由（注册 / 登录 / 获取当前用户）
app.use('/api/v1/auth', authRoutes);

// TODO: 如需对接 Stripe 支付，请在此挂载 billingRoutes，例如：
// app.use('/api/v1/billing', billingRoutes);

// ---------------------------------------------------------------------
// 404 兜底
// ---------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '接口不存在' } });
});

// ---------------------------------------------------------------------
// 全局错误处理（必须是最后一个中间件，且带 4 个参数）
// ---------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // 请求体 JSON 解析失败
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: '请求体不是合法的 JSON' } });
  }
  console.error('[Server] ❌ 未捕获异常:', err);
  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
});

export default app;
