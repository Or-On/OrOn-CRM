FROM node:24.20.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @or-on/auth build \
    && pnpm --filter @or-on/web build

FROM node:24.20.0-bookworm-slim AS runtime

ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
