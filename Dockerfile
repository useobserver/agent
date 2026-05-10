# Observer agent — public mirror image (Bun + distroless).
#
# This is the public-mirror Dockerfile. The monorepo's
# apps/agent/Dockerfile uses workspace paths (apps/agent/, packages/);
# the public repo lives in a flat layout (src/, packages/*) so this
# file's COPY lines reflect the mirrored structure.

FROM oven/bun:1.3.6-alpine AS builder
WORKDIR /repo

# Public mirror has no committed lockfile (the monorepo's bun.lock
# references private workspace members that don't exist here). Bun
# generates one during install — accept the drift.
COPY package.json ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --ignore-scripts

COPY src ./src
COPY tsconfig.json ./

FROM oven/bun:1.3.6-distroless

WORKDIR /app

COPY --from=builder /repo /app

ENV NODE_ENV=production
ENV DEBUG_DASHBOARD_PORT=10101
ENV ENABLE_DEBUG_DASHBOARD=true

EXPOSE 10101
CMD ["src/index.ts"]
