/**
 * src/controllers/authController.js
 * ---------------------------------------------------------------------
 * 认证控制器 —— 注册 / 登录 / 获取当前用户。
 *
 * 与 authGuard.js 形成闭环：
 *   注册/登录 → 签发 JWT（sub 为用户 ID）→ 前端携带 Bearer Token
 *   → authGuard 验签并注入 req.user → 限流器按 req.user.id 精确限流。
 *
 * 所有密钥与过期时间均来自 .env（配置驱动），绝不硬编码。
 */
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// 邮箱格式校验（简单可靠的正则）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 签发 JWT：sub 使用用户 ID（与 authGuard.js 的解码约定一致）
function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// 统一响应体结构
function sendError(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

// 校验服务端是否已配置 JWT_SECRET（缺失则无法签发令牌）
function ensureJwtConfigured(res) {
  if (!process.env.JWT_SECRET) {
    sendError(res, 500, 'JWT_NOT_CONFIGURED', '服务端未配置 JWT_SECRET，请在 .env 中设置。');
    return false;
  }
  return true;
}

// POST /register —— 注册
export async function register(req, res) {
  try {
    const { email, password, name } = req.body ?? {};

    // 逐项校验，返回友好的中文提示
    if (!email || !password) {
      return sendError(res, 400, 'INVALID_INPUT', '邮箱和密码为必填项。');
    }
    const normalizedEmail = String(email).toLowerCase().trim();
    if (!EMAIL_RE.test(normalizedEmail)) {
      return sendError(res, 400, 'INVALID_EMAIL', '邮箱格式不正确。');
    }
    if (String(password).length < 8) {
      return sendError(res, 400, 'WEAK_PASSWORD', '密码长度至少 8 位。');
    }
    if (!ensureJwtConfigured(res)) return;

    // 创建用户（password 由 User 模型的 pre-save 钩子自动哈希）
    const user = await User.create({ email: normalizedEmail, password, name });

    // 注册成功即视为登录，直接返回令牌
    return res.status(201).json({
      success: true,
      data: { token: signToken(user), user: user.toSafeJSON() },
    });
  } catch (err) {
    // MongoDB 唯一索引冲突：邮箱已存在
    if (err?.code === 11000) {
      return sendError(res, 409, 'EMAIL_TAKEN', '该邮箱已注册，请直接登录。');
    }
    console.error('[Auth] ❌ 注册失败:', err.message);
    return sendError(res, 500, 'INTERNAL_ERROR', '注册失败，请稍后重试。');
  }
}

// POST /login —— 登录
export async function login(req, res) {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return sendError(res, 400, 'INVALID_INPUT', '邮箱和密码为必填项。');
    }
    if (!ensureJwtConfigured(res)) return;

    // 显式取出被 select:false 隐藏的 password 字段用于比对
    const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select('+password');

    // 用户不存在或密码错误时，统一返回同一提示，避免泄露「该邮箱是否已注册」
    if (!user || !(await user.comparePassword(String(password)))) {
      return sendError(res, 401, 'INVALID_CREDENTIALS', '邮箱或密码错误。');
    }

    return res.json({
      success: true,
      data: { token: signToken(user), user: user.toSafeJSON() },
    });
  } catch (err) {
    console.error('[Auth] ❌ 登录失败:', err.message);
    return sendError(res, 500, 'INTERNAL_ERROR', '登录失败，请稍后重试。');
  }
}

// GET /me —— 获取当前登录用户（受 authGuard 保护，req.user 已由中间件注入）
export function me(req, res) {
  res.json({
    success: true,
    data: { id: req.user.id, email: req.user.email, role: req.user.role },
  });
}
