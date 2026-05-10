# Observer agent image (Bun + distroless), monorepo-aware.
#
# Build context MUST be the monorepo root, not apps/agent/. The agent
# now depends on workspace packages (@observer/protocol,
# @observer/probe-config); building from apps/agent/ alone can't see
# them. Run from repo root:
#
#   docker build -f apps/agent/Dockerfile -t observer/agent:latest .
#
# Bun runtime gives us:
#   - bun:sqlite (drops better-sqlite3 + python/make/g++ build deps)
#   - native fetch (drops axios)
#   - native scheduling via setInterval (drops node-cron)
#   - automatic .env loading (drops dotenv)
#
# Final image target: ~40MB on linux/amd64.

# Build stage — alpine for fast install + lockfile prep.
# Pinned to 1.3.6 to match the bun version that wrote bun.lock at the
# repo root. Newer 1.3.x are stricter about lockfile compatibility and
# reject "no changes detected by older bun" lockfiles in --frozen mode.
FROM oven/bun:1.3.6-alpine AS builder
WORKDIR /repo

# Workspace skeleton first so install layer caches across source edits.
# Bun resolves workspace deps from the manifests of EVERY workspace
# member (`workspaces: ["apps/*", "packages/*"]` at the root). If we
# only stage apps/agent/package.json, bun sees the lockfile as out of
# sync with the apps tree and refuses --frozen-lockfile. Copy every
# workspace manifest so the resolver sees a complete picture.
COPY package.json bun.lock* ./
COPY apps/agent/package.json ./apps/agent/
COPY apps/web/package.json ./apps/web/
COPY apps/docs/package.json ./apps/docs/
COPY packages ./packages

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Copy agent source after deps so a code edit doesn't bust the install layer.
COPY apps/agent ./apps/agent

# Runtime stage — distroless has no shell, no package manager, only the
# bun binary + libc dependencies. Smallest possible image. Pinned to
# match builder.
FROM oven/bun:1.3.6-distroless

WORKDIR /app

# Copy the agent source + every workspace symlink target. Bun's
# workspace install creates ../../packages/* symlinks under
# /repo/node_modules/@observer/*; preserving the relative layout keeps
# the symlinks resolvable inside distroless.
COPY --from=builder /repo/node_modules /repo/node_modules
COPY --from=builder /repo/packages /repo/packages
COPY --from=builder /repo/apps/agent /app

ENV NODE_ENV=production
ENV DEBUG_DASHBOARD_PORT=10101
ENV ENABLE_DEBUG_DASHBOARD=true
ENV NODE_PATH=/repo/node_modules

# bun:1-distroless's default ENTRYPOINT is `bun`, so CMD is just the
# script to run.
EXPOSE 10101
CMD ["src/index.ts"]
