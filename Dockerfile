# =====================================================================
# DeepSeek-SaaS-Starter — Node.js 应用镜像（多阶段构建）
#
# 阶段 1（deps）  ：只安装生产依赖，最大化利用 Docker 层缓存
# 阶段 2（runner）：精简运行时镜像 —— 不含 devDependencies、非 root 用户运行
# =====================================================================

# ---------- 阶段 1：依赖安装 ----------
FROM node:20-alpine AS deps
WORKDIR /app

# 先只复制依赖清单，代码未变时该层可命中缓存，大幅加快重复构建
COPY package.json package-lock.json* ./

# npm ci 要求存在 package-lock.json（可复现构建）
# 若你尚未本地 npm install 生成 lock 文件，请把下一行换成：npm install --omit=dev
RUN npm ci --omit=dev && npm cache clean --force

# ---------- 阶段 2：运行时 ----------
FROM node:20-alpine AS runner
WORKDIR /app

# 显式声明运行环境（注意：真正的配置仍由 .env / docker-compose 注入，镜像内不硬编码任何密钥）
ENV NODE_ENV=production

# 创建非 root 用户，降低容器逃逸风险
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# 从阶段 1 复制已安装的 node_modules（不含 devDependencies）
COPY --from=deps /app/node_modules ./node_modules

# 复制应用源码，并将文件属主交给非 root 用户
COPY --chown=appuser:appgroup . .

# 切换到非 root 用户
USER appuser

# 暴露应用端口（与 .env 中 PORT 保持一致）
EXPOSE 3000

# 健康检查：使用 Node 内置 fetch（Node 18+）探测 /health 接口
# 注意：/health 路由将在后续步骤（src/routes/v1/health.routes.js）中提供
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# 启动命令
CMD ["node", "src/server.js"]
