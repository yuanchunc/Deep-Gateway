/**
 * src/routes/aiRoutes.js
 * ---------------------------------------------------------------------
 * AI 路由 —— 把「限流中间件」与「AI 控制器」绑定在一起。
 *
 * 挂载前缀见 src/app.js：app.use('/api/v1/ai', aiRoutes)
 * 因此实际访问路径为：
 *   POST /api/v1/ai/chat/completions   （对话补全，SSE 流式 / JSON）
 *   GET  /api/v1/ai/models             （列出可用模型）
 */
import { Router } from 'express';
import { deepSeekRateLimiter } from '../middleware/rateLimiter.js';
import { chatCompletion, listModels } from '../controllers/aiController.js';

const router = Router();

// 列出可用模型
router.get('/models', listModels);

// 对话补全 —— 挂载双重限流（同一 IP：每分钟 5 次 + 每天 100 次）
// ...deepSeekRateLimiter 展开为 [minuteLimiter, dayLimiter]，顺序执行：任一超限即拦截
router.post('/chat/completions', ...deepSeekRateLimiter, chatCompletion);

export default router;
