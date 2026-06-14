# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/auth-curity/package.json packages/auth-curity/
COPY packages/otel-bootstrap/package.json packages/otel-bootstrap/
COPY packages/spiffe/package.json packages/spiffe/
COPY apps/mcp-observability/package.json apps/mcp-observability/
RUN pnpm install --frozen-lockfile=false --filter "@ai-agents-demo/mcp-observability..."
COPY packages/auth-curity packages/auth-curity
COPY packages/otel-bootstrap packages/otel-bootstrap
COPY packages/spiffe packages/spiffe
COPY apps/mcp-observability apps/mcp-observability
RUN pnpm --filter "@ai-agents-demo/auth-curity" build \
 && pnpm --filter "@ai-agents-demo/spiffe" build \
 && pnpm --filter "@ai-agents-demo/otel-bootstrap" build \
 && pnpm --filter "@ai-agents-demo/mcp-observability" build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/mcp-observability
EXPOSE 8080
USER node
# Wait (≤30s) for the spiffe-helper sidecar to write the SVID before starting,
# so otel-bootstrap reads a real spiffe.id at SDK init instead of "unknown"
# (the resource attribute is captured once and never re-read). `exec` keeps
# node as PID 1 so SIGTERM still reaches the OTel shutdown handler. Proceeds
# after the timeout rather than hanging if SVID issuance is broken.
CMD ["sh", "-c", "n=0; until [ -s \"${SPIFFE_SVID_PATH:-/run/spiffe/curity-actor.jwt}\" ] || [ $n -ge 60 ]; do n=$((n+1)); sleep 0.5; done; exec node --import @ai-agents-demo/otel-bootstrap dist/server.js"]
