/**
 * src/middleware/authGuard.js
 * ---------------------------------------------------------------------
 * JWT 鉴权中间件（开源版提供基础 Token 验证）。
 *
 * 设计要点：
 *  1. 从 Authorization: Bearer <token> 头中提取 JWT，用 .env 中的
 *     JWT_SECRET 验签（配置驱动，绝不硬编码密钥）。
 *  2. 验签通过后，把解码出的用户信息统一挂载到 req.user，
 *     供限流器（req.user.id）、控制器、日志模块直接使用。
 *  3. 区分「令牌缺失 / 无效 / 过期」三种情况，返回 401 与友好 JSON。
 *  4. 附带一个 requireRole(...roles) 工厂，做最基础的角色校验；
 *     企业级 RBAC（权限点、资源级授权、租户隔离）在 PRO 版提供。
 *
 * 挂载方式（在 src/routes/xxx.js 中）：
 *   import { authGuard } from '../middleware/authGuard.js';
 *   router.post('/protected', authGuard, handler);
 */
import jwt from 'jsonwebtoken';

/*
 * =====================================================================
 * 💎【PRO 版本专享】以下能力仅在商业授权版本中提供：
 *
 *   1. SSO 单点登录（OAuth 2.0 / OIDC / SAML，支持 Google、GitHub、
 *      企业微信、飞书、LDAP 等身份提供商）
 *   2. 企业级 RBAC 角色权限管理（角色 → 权限点 → 资源级授权 → 多租户隔离）
 *
 *   > PRO 版本专享：此处已集成 SSO 单点登录与企业级 RBAC 角色权限管理，
 *     购买商业授权获取。
 *   > 购买后本文件会被替换为完整实现，接口签名保持不变，
 *     你的业务代码无需任何改动即可无缝升级。
 * =====================================================================
 */

// 从请求头中提取 Bearer Token，不存在则返回 null
function extractToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim(); // 去掉 "Bearer " 前缀
}

/**
 * JWT 鉴权中间件 —— 基础 Token 验证（开源版）。
 * 验证通过后在 req.user 上挂载用户信息，失败返回 401。
 */
export function authGuard(req, res, next) {
  // 密钥每次从 .env 实时读取，避免模块加载顺序导致取到空值
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({
      success: false,
      error: { code: 'JWT_NOT_CONFIGURED', message: '服务端未配置 JWT_SECRET，请在 .env 中设置。' },
    });
  }

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      error: { code: 'AUTH_REQUIRED', message: '缺少认证令牌，请先登录。' },
    });
  }

  try {
    const payload = jwt.verify(token, secret);

    // 统一挂载到 req.user：优先取标准 claim「sub」作为用户 ID
    // TODO: 接入 User 模型后，可在此处按 id 查询并挂载完整用户文档，
    //       例如 req.user = await User.findById(id).select('-password');
    req.user = { ...payload, id: payload.sub ?? payload.id ?? payload.userId };

    // 💎 PRO 专享：此处会额外注入 SSO 返回的企业身份与租户上下文，
    //   例如 req.user.tenantId / req.user.permissions / req.user.roles。

    return next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      success: false,
      error: {
        code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: expired ? '登录已过期，请重新登录。' : '令牌无效，请重新登录。',
      },
    });
  }
}

/**
 * 基础角色校验工厂 —— 检查 req.user.role 是否在允许列表中（开源版）。
 *
 * 用法：router.delete('/admin/users/:id', authGuard, requireRole('admin'), handler)
 *
 * 💎 PRO 专享：企业级 RBAC 在此基础上扩展为「权限点 + 资源级授权 + 租户隔离」，
 *   即 requirePermission('billing:subscribe') 这类细粒度校验。
 */
export function requireRole(...roles) {
  return function roleGuard(req, res, next) {
    const userRole = req.user?.role;
    if (!userRole || !roles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: '权限不足，无法访问该资源。' },
      });
    }
    return next();
  };
}
