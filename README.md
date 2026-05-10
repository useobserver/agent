# Observer Agent

The data-plane companion to [Observer](https://use.observer). Probes
metric sources (Prometheus, HTTP, TCP, DNS, TLS certificates, and
more) on a schedule, computes status verdicts client-side, and pushes
the results to Observer Cloud.

This repository is a one-way public mirror of the agent's source
from a private monorepo. See [`CONTRIBUTING.md`](./CONTRIBUTING.md)
for the review + merge model.

## What it does

```
┌────────────────┐   probe (5–60s)   ┌──────────────┐   push (status only)   ┌──────────────┐
│ Prometheus,    │ ─────────────────▶│ Observer     │ ──────────────────────▶│ Observer     │
│ HTTP endpoint, │                   │ Agent        │                        │ Cloud        │
│ TCP socket,    │                   │ (this repo)  │                        │              │
│ DNS resolver,  │                   │              │                        │              │
│ TLS cert, …    │                   │ src/         │                        │ status pages │
└────────────────┘                   └──────────────┘                        └──────────────┘
```

- **Stateless re: definitions.** Refetches its metric definitions
  from the cloud every 5 minutes; never persists schema-of-the-cloud
  locally beyond the cron schedule.
- **Stateful re: pending pushes.** Local SQLite write-ahead buffer
  (`bun:sqlite`) protects against transient cloud unreachability.
  See `src/buffer.ts` and `src/drain.ts`.
- **Privacy-aware.** Pushes only `{ metric_id, value, status,
  timestamp }`. Raw query strings are sha256-prefixed in any logs;
  customer data never leaves your network.
- **Self-observable.** Embedded HTTP debug dashboard on
  `:10101` (toggle via `ENABLE_DEBUG_DASHBOARD`). See `src/dashboard.ts`.

## Quick start

```bash
# 1. Install
bun install

# 2. Set env (or use a .env file)
export AGENT_KEY="obs_live_..."             # from the cloud Agents page
export CLOUD_SERVER_URL="https://your-observer-cloud"
export PROMETHEUS_SERVER_URL="http://prometheus:9090"

# 3. Run
bun run src/index.ts
```

Or via Docker:

```bash
docker build -t observer/agent:local .
docker run --env-file .env -p 10101:10101 observer/agent:local
```

## Probe types

| Type | Status | Sample value |
|---|---|---|
| `prometheus` | shipped | PromQL scalar |
| `http` | shipped | response_time_ms |
| `tcp` | shipped | connect_time_ms |
| `dns` | shipped | resolve_time_ms |
| `tls_cert` | shipped | days_until_expiry |
| `icmp` | stubbed (raw socket privileges) | — |
| `grpc` | stubbed | — |
| `websocket` | stubbed | — |
| `mtls_http` | stubbed | — |
| `database` | stubbed | — |

Stubbed probes have schema accepted by the cloud but the runtime
returns `no_data` until shipped.

### Adding a new probe

1. Add the literal to `src/sources/<name>.ts` exporting
   `{ validateConfig, execute }` (see `src/sources/http.ts` for the
   reference shape).
2. Register in `src/sources/index.ts` `SOURCES` map.
3. Add a Bun test in `tests/probe-<name>.test.ts`.

The dispatcher contract is `ProbeSource<TConfig>` from
`@observer/protocol`. Sources never throw — network errors and
malformed input resolve to `{ status_hint: "no_data", reason }`.

## Repository layout

```
.
├── src/
│   ├── index.ts          # Entry: cron schedule + heartbeat
│   ├── buffer.ts         # bun:sqlite local queue
│   ├── drain.ts          # Drain controller w/ exp backoff
│   ├── dashboard.ts      # Embedded debug dashboard (:10101)
│   ├── status.ts         # evaluateStatus — strict <,>,= ops
│   ├── types.ts
│   └── sources/          # Probe runtimes (10 types)
├── tests/                # Bun tests
├── example/
│   └── prometheus.yml    # Reference Prom config
├── packages/
│   ├── protocol/         # Cloud↔agent wire contract (vendored)
│   ├── probe-config/     # Zod schemas (vendored)
│   └── tsconfig/         # TS presets (vendored)
├── Dockerfile
├── docker-compose.yml
├── LICENSE               # Apache-2.0
└── README.md             # this file
```

## Building from source

The agent uses Bun (>= 1.3) for both runtime and tooling. No
transpile step — Bun runs `.ts` directly.

```bash
bun install
bun --bun tsc --noEmit -p tsconfig.json   # typecheck (strict)
bun test                                   # run all tests
```

## Status evaluation

Operators are strict everywhere — `over` is `>`, `under` is `<`,
`equal` is `=`. A value exactly equal to a threshold under
`over`/`under` does NOT match. The same rule is enforced server-side
in the cloud's pgViews.

Per-metric:
- if value matches `healthy_*` → `healthy`;
- elif matches `unhealthy_*` → `unhealthy`;
- else `degraded`.

## Versioning

Tagged releases follow semver (`v1.2.3`). Breaking changes to the
heartbeat or push contracts are major bumps. Check the
[`packages/protocol/`](./packages/protocol/) version for the wire
contract version this build targets.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE).
