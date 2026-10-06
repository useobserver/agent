# Observer agent image (Bun + distroless).
#
# Layout: src/ holds the agent, packages/* hold its shared
# protocol/config libraries. The COPY lines below follow that shape.

FROM oven/bun:1.3.6-alpine AS builder
WORKDIR /repo

# No committed lockfile; bun generates one during install. Dependency
# versions are pinned by package.json ranges plus the image digest.
COPY package.json ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --ignore-scripts

COPY src ./src
COPY tsconfig.json ./
# Build provenance (agent 1.5.0+): CI writes build-info.json (channel
# "official", commit, source_hash) before the docker build; the agent reads
# it at boot and reports it on every heartbeat. The [n] glob makes the COPY
# a no-op for local builds without the stamp — the agent then self-reports
# channel "source".
COPY build-info.jso[n] ./

# /data holds the SQLite buffer (BUFFER_PATH below) and the heartbeat relay
# queue next to it. Distroless has no shell to mkdir in, so create it here.
# Owned by 65532 (distroless "nonroot") with group 0 so the image also works
# under runAsUser 65532 / arbitrary-uid-with-gid-0 platforms; the default
# root user can write it regardless. A named volume mounted on /data inherits
# this ownership on first use.
RUN mkdir -p /data && chown 65532:0 /data && chmod 0770 /data

FROM oven/bun:1.3.6-distroless

WORKDIR /app

COPY --from=builder /repo /app
COPY --from=builder --chown=65532:0 /data /data

ENV NODE_ENV=production
# Keep the buffer on the /data volume (mount one there), so queued samples
# survive container recreation. The heartbeat relay queue follows it
# (/data/observer-agent-buffer-relay.db). Non-container runs keep the binary
# default (./observer-agent-buffer.db).
ENV BUFFER_PATH=/data/observer-agent-buffer.db
ENV DEBUG_DASHBOARD_PORT=10101
ENV ENABLE_DEBUG_DASHBOARD=true

EXPOSE 10101
CMD ["src/index.ts"]
