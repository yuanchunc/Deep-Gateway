/**
 * src/config/db.js
 * ---------------------------------------------------------------------
 * MongoDB Atlas 数据库连接模块（配置驱动 + 稳健连接）
 *
 * 设计要点：
 *  1. 所有连接参数一律从 process.env 读取，绝不硬编码（配置驱动原则）。
 *  2. 首次连接失败时执行「指数退避」重试，避免 Atlas 短暂不可用时进程直接崩溃。
 *  3. 运行时断线由 Mongoose 底层自动重连，这里只监听事件做日志与监控埋点。
 *  4. 导出 disconnectDB()，供进程优雅退出（SIGINT / SIGTERM）时调用。
 *
 * 使用方式（在 src/server.js 中）：
 *   import { connectDB, disconnectDB } from './config/db.js';
 *   await connectDB();
 */
import mongoose from 'mongoose';
import 'dotenv/config'; // 确保直接运行本文件也能加载 .env

// ---------------------------------------------------------------------
// 1. 从环境变量读取配置（配置驱动原则：绝不硬编码）
//    —— 每个值都提供安全的默认值，未在 .env 中设置时也能正常运行
// ---------------------------------------------------------------------
const config = {
  uri: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB_NAME || 'deepseek_saas_starter',
  connectTimeoutMS: parseInt(process.env.MONGODB_CONNECT_TIMEOUT_MS || '10000', 10),
  serverSelectionTimeoutMS: parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || '5000', 10),
  socketTimeoutMS: parseInt(process.env.MONGODB_SOCKET_TIMEOUT_MS || '45000', 10),
  maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE || '10', 10),
  maxRetries: parseInt(process.env.MONGODB_MAX_RETRIES || '5', 10),
  retryDelayMs: parseInt(process.env.MONGODB_RETRY_DELAY_MS || '5000', 10),
};

// ---------------------------------------------------------------------
// 2. 极简内部日志
//    TODO: 后续步骤将替换为统一的 src/config/logger.js（pino 结构化日志），
//          届时只需把下面的 log 对象改为 import 即可，调用方无需改动。
// ---------------------------------------------------------------------
const log = {
  info: (msg) => console.log(`[MongoDB] ✅ ${msg}`),
  warn: (msg) => console.warn(`[MongoDB] ⚠️ ${msg}`),
  error: (msg) => console.error(`[MongoDB] ❌ ${msg}`),
};

// 仅开发环境打印 mongoose 的底层 query 日志，生产环境关闭以提升性能
mongoose.set('debug', process.env.NODE_ENV === 'development');

// ---------------------------------------------------------------------
// 3. 运行时事件监听（初始连接建立之后生效）
//    Mongoose 会自动重连，这里只负责记录，方便排障与后续接入监控告警。
// ---------------------------------------------------------------------
function registerConnectionListeners() {
  mongoose.connection.on('connected', () => log.info('MongoDB 连接已建立'));
  mongoose.connection.on('disconnected', () => log.warn('MongoDB 连接断开，等待自动重连…'));
  mongoose.connection.on('reconnected', () => log.info('MongoDB 自动重连成功'));
  mongoose.connection.on('error', (err) => log.error(`连接异常: ${err.message}`));
}

// ---------------------------------------------------------------------
// 4. 工具：休眠（用于重试间隔）
// ---------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------
// 5. 核心：连接数据库（带指数退避重试）
// ---------------------------------------------------------------------
export async function connectDB() {
  // 缺少连接串时直接抛错并给出明确指引，避免带着 undefined 继续运行
  if (!config.uri) {
    throw new Error(
      '未检测到 MONGODB_URI 环境变量。请在 .env 中配置 MongoDB Atlas 连接串。'
    );
  }

  const options = {
    dbName: config.dbName,
    connectTimeoutMS: config.connectTimeoutMS,
    serverSelectionTimeoutMS: config.serverSelectionTimeoutMS,
    socketTimeoutMS: config.socketTimeoutMS,
    maxPoolSize: config.maxPoolSize,
    // TODO: 生产环境建议关闭自动建索引，改为通过迁移脚本手动建索引，
    //       避免启动瞬间对生产库加写锁：
    // autoIndex: process.env.NODE_ENV !== 'production',
  };

  // 先注册事件监听，确保重连日志不丢失
  registerConnectionListeners();

  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      await mongoose.connect(config.uri, options);
      log.info(`数据库连接成功（库: ${config.dbName}）`);
      return mongoose.connection;
    } catch (err) {
      lastError = err;
      log.error(`第 ${attempt}/${config.maxRetries} 次连接失败: ${err.message}`);
      // 最后一次尝试失败后不再等待，直接跳出并把错误抛给上层处理
      if (attempt === config.maxRetries) break;
      // 指数退避：第 N 次重试等待 retryDelayMs * N 毫秒（1x → 2x → 3x …）
      const delay = config.retryDelayMs * attempt;
      log.warn(`${delay / 1000} 秒后重试…`);
      await sleep(delay);
    }
  }

  throw new Error(
    `MongoDB 连接失败（已重试 ${config.maxRetries} 次）: ${lastError?.message}`
  );
}

// ---------------------------------------------------------------------
// 6. 断开连接（供进程优雅退出时调用）
// ---------------------------------------------------------------------
export async function disconnectDB() {
  try {
    await mongoose.disconnect();
    log.info('MongoDB 连接已安全关闭');
  } catch (err) {
    log.error(`关闭 MongoDB 连接时出错: ${err.message}`);
  }
}

export default mongoose.connection;
