# 用法：
#   docker build -t gridbot .
#   docker run -d --name gridbot -v "$PWD:/data" -e SMTP_PASS=授权码 gridbot            # 定时监控
#   docker run -d -p 127.0.0.1:8686:8686 -v "$PWD:/data" gridbot serve --host 0.0.0.0  # 网页控制台
# /data 目录中需要有 gridbot.yaml；状态文件也会写在这里。

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production TZ=Asia/Shanghai GRIDBOT_CONFIG=/data/gridbot.yaml
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docs ./docs
COPY web ./web
USER node
WORKDIR /data
EXPOSE 8686
ENTRYPOINT ["node", "/app/dist/cli/index.js"]
CMD ["run"]
