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

FROM oven/bun:1.3.6-distroless

WORKDIR /app

COPY --from=builder /repo /app

ENV NODE_ENV=production
ENV DEBUG_DASHBOARD_PORT=10101
ENV ENABLE_DEBUG_DASHBOARD=true

EXPOSE 10101
CMD ["src/index.ts"]
