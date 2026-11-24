# syntax=docker/dockerfile:1

# Coolify（build pack = dockerfile）用。常駐スケジューラ（dist/scheduler/main.js）を動かす。
# 状態ファイルは /data（Coolify の Volume）にだけ書く。手順は DEPLOYMENT.md。

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# CI が無いので、ビルドのたびに typecheck・lint・test を通す。
FROM deps AS build
COPY . .
RUN npm run typecheck && npm run lint && npm test && npm run build

FROM node:24-slim AS runtime
# tini: PID 1 でシグナルを転送し、ゾンビを回収する。
# DL3008: tini の版は固定しない。ベースイメージの Debian の版に任せる
# （固定すると、その版が apt のリポジトリから消えたときにビルドが落ちる）。
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# 名前付き Volume は初回にイメージ側の所有者を引き継ぐので、先に node に渡しておく。
# VOLUME は書かない（マウントは Coolify 側で行う）。
RUN mkdir -p /data && chown node:node /data
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/scheduler/healthcheck.js"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/scheduler/main.js"]
