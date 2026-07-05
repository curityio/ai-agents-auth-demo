# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/auth-curity/package.json packages/auth-curity/
COPY packages/spiffe/package.json packages/spiffe/
COPY apps/exchange-shim/package.json apps/exchange-shim/
RUN pnpm install --frozen-lockfile=false --filter "@ai-agents-demo/exchange-shim..."
COPY packages/auth-curity packages/auth-curity
COPY packages/spiffe packages/spiffe
COPY apps/exchange-shim apps/exchange-shim
RUN pnpm --filter "@ai-agents-demo/auth-curity" build \
 && pnpm --filter "@ai-agents-demo/spiffe" build \
 && pnpm --filter "@ai-agents-demo/exchange-shim" build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/exchange-shim
EXPOSE 8090
USER node
CMD ["node", "dist/server.js"]
