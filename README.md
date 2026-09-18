<div align="center">

# 🚀 DeepSeek-SaaS-Starter

### 5 分钟部署你的大模型 SaaS 基座

[![Node](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)](https://expressjs.com)
[![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/atlas)
[![Docker](https://img.shields.io/badge/Docker-开箱即用-2496ED?logo=docker&logoColor=white)](https://docker.com)
[![License](https://img.shields.io/badge/License-AGPLv3-important)](./LICENSE)

**开箱即用的 AI 应用脚手架** —— 内置防盗刷限流、MongoDB 用量审计、Docker 一键部署，让你把精力放在产品本身，而不是重复造轮子。

</div>

---

## ✨ 为什么选它

写一个「会聊天」的 Demo 只要半小时，但把它变成**能卖钱、能抗住恶意刷量、能对账**的 SaaS，要踩的坑远超想象。这个基座替你填平了它们：

| 能力 | 说明 |
|---|---|
| 🛡️ **自带防盗刷** | 同一 IP 每分钟 5 次、每天 100 次双重限流，基于 MongoDB 原子计数，多实例也共享额度；超限返回标准 `429`，被拦截请求自动落库审计 |
| 📊 **MongoDB 额度控制** | 每一次请求的 IP / 用户 / Token 消耗 / 耗时全量入库，TTL 自动过期，成本与用量一目了然 |
| 🐳 **Docker 开箱即用** | 多阶段镜像 + Compose 编排，一行命令启动，非 root 运行、内置健康检查 |
| 🔐 **密钥零泄漏** | API Key 只存在于服务端 `.env`，前端纯代理，杜绝密钥暴露 |
| 🌊 **SSE 流式输出** | 完整 Server-Sent Events 支持，打字机体验，超时/异常全兜底 |
| 🧩 **高扩展架构** | 中间件 / 服务层彻底解耦，为支付、多租户预留标准接口 |

## 🚀 快速开始

### 前置要求

- Node.js **20+**
- 一个 [MongoDB Atlas](https://www.mongodb.com/atlas) 免费集群（或任意 MongoDB 连接串）
- 一个 [DeepSeek API Key](https://platform.deepseek.com)

### 本地运行（3 步）

```bash
# 1. 安装依赖
npm install

# 2. 准备环境变量（填 MONGODB_URI 与 DEEPSEEK_API_KEY）
cp .env.example .env

# 3. 启动
npm run dev
```

访问 http://localhost:3000/health 看到 `{"status":"ok"}` 即成功。

### Docker 运行

```bash
cp .env.example .env   # 填好密钥
docker compose up -d --build
```

### 前端 Demo

直接双击打开 `public/index.html` 即可体验（记得把脚本顶部 `API_BASE` 改成你的后端地址）。也可把该文件拖到 [Netlify](https://netlify.com) 静态托管，开箱即用。

## 📡 API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/v1/ai/models` | 列出可用模型 |
| `POST` | `/api/v1/ai/chat/completions` | 对话补全（`stream: true` 返回 SSE，默认流式） |

```bash
curl -N -X POST http://localhost:3000/api/v1/ai/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

## 🏗️ 项目结构

```
src/
├── config/db.js            # MongoDB Atlas 连接（断线重试）
├── middleware/
│   ├── rateLimiter.js      # 基于 MongoDB 的双重限流（防刷核心）
│   └── authGuard.js        # JWT 鉴权（含 PRO 钩子）
├── controllers/
│   ├── aiController.js     # DeepSeek 服务端代理（SSE）
│   └── paymentController.js# 支付 Webhook 外壳（含 PRO 钩子）
├── routes/aiRoutes.js      # 路由绑定
├── models/RequestLog.js    # 请求审计模型
├── app.js / server.js      # 应用装配 / 启动入口
└── public/index.html       # 极简前端 Demo
```

## 💼 商业化

本项目采用 **AGPLv3** 协议开源。如果您需要在**闭源商业环境**中使用，或者想要获取自带【**完整 Stripe 支付模块**】与【**用户鉴权系统**】的 **PRO 版本**，请联系购买商业授权。

> AGPLv3 的核心约束：如果你把本项目（或衍生代码）作为网络服务对外提供，**必须开源你的全部修改**。这正是我们把「支付」「鉴权」等高价值能力留在 PRO 版的原因——开源版帮你验证想法，PRO 版助你直接变现。

**PRO 版本额外包含**：
- 💳 完整 Stripe 订阅扣费（开通 / 续费 / 升级 / 降级 / 退订 + Webhook 验签）
- 👥 用户鉴权系统（注册 / 登录 / JWT / SSO 单点登录 / 企业级 RBAC）
- 📈 用量计费面板、发票、多租户隔离

**联系方式**：邮箱 `sales@your-domain.com`（请替换为你的真实联系方式）

## 📄 License

[AGPL-3.0](./LICENSE) © 2026
