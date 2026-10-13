# Kline 直播 K 线：一个容器 = 后端（HTTP + WebSocket）+ 打包好的导播台 / 直播画面
#
#   docker build -t kline .
#   docker compose up -d          # 见 docker-compose.yml
#
# 数据（行情库 + 导播状态）都在 /data，挂数据卷；配置全部走环境变量，镜像里不放 .env 和任何密钥。

# ---------- 构建：打包前端 ----------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js ./
COPY web ./web
COPY shared ./shared
RUN npm run build

# ---------- 运行 ----------
FROM node:24-alpine
# 时区必须是北京时间：交易日 → 时间戳、周K / 月K 聚合、同步时判断「今天」都按本地时区算
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_SOURCE=local \
    DB_PATH=/data/market.db \
    STATE_FILE=/data/runtime/state.json

WORKDIR /app
COPY package.json package-lock.json ./
# 运行时只需要 ws、pinyin-pro（前端依赖已打包进 dist）
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY --from=build /app/dist ./dist

# 以非 root 用户运行；/data 预先建好并归 node 用户，命名数据卷会继承这个权限
RUN mkdir -p /data/runtime && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
