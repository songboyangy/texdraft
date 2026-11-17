# syntax=docker/dockerfile:1
# TeXdraft：服务端 + 前端静态文件 + TeX Live（latexmk）
#   docker compose -f deploy/docker-compose.yml up -d   （见 deploy/README.md）
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ---- 构建：安装依赖并构建前端
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- 运行
FROM base AS runtime
# 可通过 --build-arg 增减 TeX Live 包（例如 texlive-full，约 5 GB）
ARG TEXLIVE_PACKAGES="latexmk biber texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended texlive-xetex texlive-luatex texlive-science texlive-bibtex-extra texlive-pictures texlive-lang-chinese texlive-lang-cjk fonts-noto-cjk"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates fontconfig $TEXLIVE_PACKAGES \
 && rm -rf /var/lib/apt/lists/*
# 编译以无特权用户执行（COMPILE_SANDBOX=uid）：读不到服务进程的环境变量与 0700 的数据目录
RUN groupadd -g 1001 texcompile && useradd -u 1001 -g 1001 -M -d /nonexistent -s /usr/sbin/nologin texcompile
COPY --from=build /app /app
ENV NODE_ENV=production \
    SERVE_WEB=1 \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    COMPILE_RUNNER=local-latexmk \
    COMPILE_SANDBOX=uid \
    COMPILE_UID=1001 \
    COMPILE_GID=1001
VOLUME /data
EXPOSE 8787
WORKDIR /app/apps/server
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/index.ts"]
