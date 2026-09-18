/**
 * src/server.js
 * ---------------------------------------------------------------------
 * HTTP 服务启动入口 —— 负责进程生命周期：
 *   1. 连接数据库（失败则退出，connectDB 内部已带指数退避重试）
 *   2. 启动 HTTP 监听
 *   3. 捕获 SIGINT / SIGTERM 优雅退出（先关 HTTP，再断数据库）
 */
import app from './app.js';
import { connectDB, disconnectDB } from './config/db.js';

// 端口来自 .env（配置驱动），默认 3000
const PORT = parseInt(process.env.PORT || '3000', 10);

async function start() {
  // 1. 连接数据库
  try {
    await connectDB();
  } catch (err) {
    console.error('[Server] ❌ 数据库连接失败，进程退出:', err.message);
    process.exit(1);
  }

  // 2. 启动监听
  const server = app.listen(PORT, () => {
    console.log(`[Server] 🚀 服务已启动: http://localhost:${PORT}`);
    console.log(`[Server] 📡 健康检查: http://localhost:${PORT}/health`);
    console.log(`[Server] 🤖 AI 接口:  POST http://localhost:${PORT}/api/v1/ai/chat/completions`);
  });

  // 3. 优雅退出
  const shutdown = async (signal) => {
    console.log(`[Server] 收到 ${signal}，开始优雅退出…`);
    // 停止接收新连接，等待现有请求处理完毕后关闭
    server.close(async () => {
      await disconnectDB();
      console.log('[Server] 已安全退出');
      process.exit(0);
    });
    // 兜底：10 秒内未正常退出则强制结束，避免进程悬挂
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
