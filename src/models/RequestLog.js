/**
 * src/models/RequestLog.js
 * ---------------------------------------------------------------------
 * 请求日志模型 —— 记录每一次 AI 请求的「谁 / 何时 / 花了多少 Token」。
 *
 * 作用（也是本脚手架防刷卖点的审计基础）：
 *  1. 运营侧：统计每个 IP / 用户消耗了多少 Token，用于对账与成本核算。
 *  2. 安全侧：被限流拦截的请求也会写一条 blocked=true 的记录，
 *     方便你在后台快速定位「谁在刷接口」。
 *  3. 数据量控制：通过 TTL 索引让日志自动过期，避免 Atlas 存储无限膨胀。
 */
import mongoose from 'mongoose';

// 日志保留天数（配置驱动，默认 30 天；可在 .env 中覆盖）
const REQUEST_LOG_TTL_DAYS = parseInt(process.env.REQUEST_LOG_TTL_DAYS || '30', 10);

const requestLogSchema = new mongoose.Schema(
  {
    // 请求来源 IP（限流与审计的关键维度）
    ip: { type: String, required: true, index: true },

    // 登录用户 ID。
    // TODO: 当前尚未接入认证；后续在 auth.middleware.js 中解析 JWT 后，
    //       由控制器写入 req.user.id，此处即可自动关联到具体用户。
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    // 请求方法 / 路径 / 目标模型
    method: { type: String, default: 'POST' },
    endpoint: { type: String, required: true },
    model: { type: String, default: '' },

    // HTTP 状态码（200 成功 / 429 限流 / 4xx 5xx 等）
    statusCode: { type: Number, default: 200, index: true },

    // 是否被限流/防刷拦截（true 表示这是一条被拒绝的请求）
    blocked: { type: Boolean, default: false },

    // Token 消耗量（来自 DeepSeek 返回的 usage 字段）
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },

    // 本次请求耗时（毫秒），便于观察延迟
    durationMs: { type: Number, default: 0 },

    // 出错原因（无错误则为空字符串）
    errorMessage: { type: String, default: '' },
  },
  {
    // 只保留 createdAt（创建时间），不需要 updatedAt
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// TTL 索引：让日志在保留 N 天后自动被 MongoDB 清理，控制存储成本
requestLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: REQUEST_LOG_TTL_DAYS * 24 * 60 * 60 }
);

// 使用「已存在则复用」的判断，避免 nodemon 热重载时触发 OverwriteModelError
export default mongoose.models.RequestLog || mongoose.model('RequestLog', requestLogSchema);
