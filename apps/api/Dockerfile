# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

# Pin the application runtime to a supported Node.js LTS image. The digest is
# the multi-platform manifest for node:24-slim observed by the release audit;
# changing it is an explicit dependency update rather than an implicit rebuild.
ARG NODE_IMAGE=node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

FROM ${NODE_IMAGE} AS build

ARG PNPM_VERSION=10.28.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /workspace

# Install from the lockfile before copying source so dependency layers remain
# reusable. Only the API and its Prisma workspace package are needed here.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

COPY packages/db/ packages/db/
COPY apps/api/ apps/api/

RUN pnpm --filter @apex/db db:generate \
    && pnpm --filter @apex/api build

# Produce a package-scoped production dependency tree. pnpm 10 requires the
# legacy deploy implementation for a workspace that does not inject workspace
# packages. The production tree intentionally omits the Prisma CLI, so resolve
# both pnpm package symlinks and copy the generated Linux client beside the
# deployed @prisma/client instance without hard-coding pnpm's peer hash.
RUN pnpm --filter @apex/api deploy --prod --legacy /opt/api \
    && src_client_dir="$(node -p "require('node:fs').realpathSync('/workspace/packages/db/node_modules/@prisma/client')")" \
    && dst_client_dir="$(node -p "require('node:fs').realpathSync('/opt/api/node_modules/@prisma/client')")" \
    && src_generated_dir="$(dirname "$(dirname "$src_client_dir")")/.prisma" \
    && dst_generated_dir="$(dirname "$(dirname "$dst_client_dir")")/.prisma" \
    && test -f "$src_generated_dir/client/default.js" \
    && mkdir -p "$dst_generated_dir" \
    && cp -a "$src_generated_dir/." "$dst_generated_dir/" \
    && test -f "$dst_generated_dir/client/default.js" \
    && test -n "$(find "$dst_generated_dir/client" -maxdepth 1 -type f -name 'libquery_engine-*.node' -print -quit)" \
    && cd /opt/api \
    && node -e "const client = require('@prisma/client'); if (typeof client.PrismaClient !== 'function') process.exit(1)"

FROM ${NODE_IMAGE} AS runtime

ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="Workforce OS API and worker" \
      org.opencontainers.image.description="Guarded Workforce OS GTM API and worker runtime" \
      org.opencontainers.image.source="https://github.com/Kloudedge-apex/apex-product" \
      org.opencontainers.image.revision="${VCS_REF}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    API_PORT=4000

COPY --from=build --chown=node:node /opt/api/package.json ./package.json
COPY --from=build --chown=node:node /opt/api/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/api/dist ./dist

USER node

EXPOSE 4000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const http=require('node:http');const req=http.get({host:'127.0.0.1',port:process.env.API_PORT||4000,path:'/api/health/live',timeout:4000},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.on('timeout',()=>req.destroy());req.on('error',()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "dist/main.js"]
