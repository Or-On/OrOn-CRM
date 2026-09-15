FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @or-on/messaging-worker... build \
    && pnpm exec tsc --project scripts/tsconfig.bootstrap-owner.json \
      --outDir /tmp/bootstrap-owner \
    && node infra/scripts/runtime-exports.mjs \
    && pnpm --filter @or-on/messaging-worker deploy --prod --legacy /runtime \
    && cp /tmp/bootstrap-owner/bootstrap_owner.js /runtime/bootstrap-owner.mjs \
    && node infra/scripts/verify-runtime-lock.mjs

FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
ARG ORON_SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision="${ORON_SOURCE_REVISION}"
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libpcre2-8-0=10.42-1+deb12u1 \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /runtime ./
USER node
CMD ["node", "dist/main.js"]
