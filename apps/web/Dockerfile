# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/spiffe/package.json packages/spiffe/
COPY packages/auth-curity/package.json packages/auth-curity/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile=false --filter "@ai-agents-demo/web..."
COPY packages/spiffe packages/spiffe
COPY packages/auth-curity packages/auth-curity
COPY apps/web apps/web
RUN pnpm --filter "@ai-agents-demo/spiffe" build \
 && pnpm --filter "@ai-agents-demo/auth-curity" build \
 && pnpm --filter "@ai-agents-demo/web" build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
# Next.js standalone trace puts the monorepo layout under the standalone dir
# because we set outputFileTracingRoot to the repo root. The server.js entry
# point lives at /app/apps/web/server.js after this layout.
COPY --from=build /app/apps/web/.next/standalone /app/
COPY --from=build /app/apps/web/.next/static /app/apps/web/.next/static
COPY --from=build /app/apps/web/public /app/apps/web/public
WORKDIR /app/apps/web
EXPOSE 3000
USER node
CMD ["node", "server.js"]
