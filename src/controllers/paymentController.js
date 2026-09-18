/**
 * src/controllers/paymentController.js
 * ---------------------------------------------------------------------
 * 支付 Webhook 控制器（开源版为「标准接收外壳」，核心业务在商业版提供）。
 *
 * 作用：接收 Stripe 推送的异步事件（订阅开通、续费扣款、升级/降级、退订），
 *       并据此更新本地用户订阅状态。
 *
 * ⚠️ 关键部署细节（重要）：
 *   Stripe 验签必须使用「原始请求体」（raw body），因此该路由【不能】走
 *   app.js 里全局的 express.json()，而要用 express.raw() 挂载，例如：
 *
 *     app.post('/api/v1/billing/webhook',
 *              express.raw({ type: 'application/json' }),
 *              handleWebhook);
 *
 *   否则验签将因 body 被改写而失败。
 *
 * 为什么 Webhook 要立即返回 200？
 *   支付平台若在超时内未收到 2xx，会持续重试推送同一事件，导致重复回调。
 *   所以「先确认收到、再异步处理业务」是标准做法——即使业务失败也应先应答。
 */

// 支付相关密钥来自 .env（配置驱动，绝不硬编码）
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

/**
 * Stripe Webhook 接收入口（开源版外壳）。
 *
 * 开源版职责：
 *  1. 正确解析 raw body 中的事件载荷
 *  2. 记录收到的事件
 *  3. 立即返回 200 应答，避免支付平台重复推送
 *
 * 💎 PRO 版本专享：完整的一键化 Stripe 订阅扣费、升级降级逻辑
 *   与 Webhook 验签已在商业版中提供。
 */
export async function handleWebhook(req, res) {
  // -------------------------------------------------------------------
  // 1. 验签（PRO 专享完整实现）
  // -------------------------------------------------------------------
  // 💎 PRO 版本专享：完整的一键化 Stripe 订阅扣费、升级降级逻辑
  // 与 Webhook 验签已在商业版中提供。商业版使用 Stripe 官方 SDK：
  //
  //   const stripe = require('stripe')(STRIPE_SECRET_KEY);
  //   const signature = req.headers['stripe-signature'];
  //   event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  //
  // 通过 HMAC 验签可彻底杜绝伪造 Webhook 的攻击。
  // 开源版未引入 stripe SDK，因此此处仅做降级处理：
  if (STRIPE_WEBHOOK_SECRET) {
    console.warn(
      '[Payment] ⚠️ 已配置 STRIPE_WEBHOOK_SECRET，但开源版未集成验签（PRO 专享）。生产环境请购买商业授权。'
    );
  }

  // -------------------------------------------------------------------
  // 2. 解析事件载荷（express.raw 下 req.body 为 Buffer）
  // -------------------------------------------------------------------
  let event;
  try {
    if (Buffer.isBuffer(req.body)) {
      event = JSON.parse(req.body.toString('utf-8'));
    } else if (typeof req.body === 'string') {
      event = JSON.parse(req.body);
    } else {
      event = req.body;
    }
  } catch {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PAYLOAD', message: '无法解析 Webhook 载荷。' },
    });
  }

  if (!event || !event.type) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PAYLOAD', message: 'Webhook 载荷缺少事件类型。' },
    });
  }

  // -------------------------------------------------------------------
  // 3. 事件分发（PRO 专享业务逻辑）
  // -------------------------------------------------------------------
  // 💎 PRO 版本专享：以下每个事件都对应一套完整的「订阅状态机」
  //   （开通 → 扣费 → 续费 → 升级/降级 → 退订 → 暂停），
  //   并自动与本地用户表 / 订阅表同步。开源版仅记录日志，不做业务变更。
  switch (event.type) {
    case 'checkout.session.completed':
      // 💎 PRO：用户完成首笔订阅支付 → 激活订阅、写入订阅到期时间、发放高级权益
      break;

    case 'invoice.payment_succeeded':
      // 💎 PRO：续费扣款成功 → 延长订阅周期、记录扣款流水
      break;

    case 'invoice.payment_failed':
      // 💎 PRO：扣款失败 → 进入宽限期、发送催缴通知、必要时暂停权益
      break;

    case 'customer.subscription.updated':
      // 💎 PRO：订阅变更（升级/降级/暂停）→ 按差价补扣/退还并同步本地权限
      break;

    case 'customer.subscription.deleted':
      // 💎 PRO：订阅取消 → 回收高级权限、保留基础功能
      break;

    default:
      console.info(`[Payment] 收到未处理的事件类型: ${event.type}`);
  }

  // -------------------------------------------------------------------
  // 4. 立即应答 200，让支付平台停止重试
  // -------------------------------------------------------------------
  console.info(`[Payment] ✅ 已接收 Webhook 事件: ${event.type} (id=${event.id ?? 'unknown'})`);
  return res.status(200).json({ received: true });
}
