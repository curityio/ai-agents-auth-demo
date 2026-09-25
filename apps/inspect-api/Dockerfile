# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/auth-curity/package.json packages/auth-curity/
COPY packages/otel-bootstrap/package.json packages/otel-bootstrap/
COPY packages/spiffe/package.json packages/spiffe/
COPY apps/inspect-api/package.json apps/inspect-api/
RUN pnpm install --frozen-lockfile=false --filter "@ai-agents-demo/inspect-api..."
COPY packages/auth-curity packages/auth-curity
COPY packages/otel-bootstrap packages/otel-bootstrap
COPY packages/spiffe packages/spiffe
COPY apps/inspect-api apps/inspect-api
RUN pnpm --filter "@ai-agents-demo/auth-curity" build \
 && pnpm --filter "@ai-agents-demo/spiffe" build \
 && pnpm --filter "@ai-agents-demo/otel-bootstrap" build \
 && pnpm --filter "@ai-agents-demo/inspect-api" build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/inspect-api
EXPOSE 8084
USER node
CMD ["sh", "-c", "n=0; until [ -s \"${SPIFFE_SVID_PATH:-/run/spiffe/curity-actor.jwt}\" ] || [ $n -ge 60 ]; do n=$((n+1)); sleep 0.5; done; exec node --import @ai-agents-demo/otel-bootstrap dist/server.js"]
