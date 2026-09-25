# syntax=docker/dockerfile:1

# ---- 基础：源码（零 npm 依赖，无需安装） ----
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json ./
COPY index.html styles.css ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts

# ---- verify：一次性服务，测试 + 构建 + 业务冒烟，以退出码报告结果 ----
FROM base AS verify
CMD ["node", "scripts/verify.mjs"]

# ---- build：产出静态站点 ----
FROM base AS build
RUN node scripts/build.mjs

# ---- web：nginx 静态站点，含健康检查 ----
FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1/health || exit 1
