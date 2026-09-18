/**
 * src/routes/authRoutes.js
 * ---------------------------------------------------------------------
 * 认证路由 —— 绑定限流、控制器与鉴权中间件。
 *
 * 挂载前缀见 src/app.js：app.use('/api/v1/auth', authRoutes)
 * 实际访问路径：
 *   POST /api/v1/auth/register   （注册）
 *   POST /api/v1/auth/login      （登录）
 *   GET  /api/v1/auth/me         （获取当前用户，需登录）
 */
import { Router } from 'express';
import { register, login, me } from '../controllers/authController.js';
import { authGuard } from '../middleware/authGuard.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// 注册/登录专用限流：同一 IP 每小时最多 20 次，防暴力破解。
// 复用 rateLimiter 工厂（高扩展性）：任何接口都可按需生成独立限流器。
const authLimiter = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '20', 10),
  label: 'auth',
  failOpen: process.env.RATE_LIMIT_FAIL_OPEN !== 'false',
});

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);

// GET /me 需要鉴权：authGuard 验签后把用户信息注入 req.user
router.get('/me', authGuard, me);

export default router;
