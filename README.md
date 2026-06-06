# Observer Agent

The data-plane companion to [Observer](https://use.observer). The agent
probes metric sources inside your network, evaluates each verdict
locally, and pushes only the result to Observer Cloud over a single
outbound HTTPS connection. Raw telemetry never leaves the network: the
agent sends `{ metric_id, value, status, timestamp }`, not your query
results or credentials.

This repository is a one-way public mirror of the agent's source from a
private monorepo. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the
review and merge model.

```
┌─────────────────┐   probe (5–60s)   ┌──────────────┐   push (status only)   ┌──────────────┐
│ Prometheus,     │ ─────────────────▶│ Observer     │ ──────────────────────▶│ Observer     │
│ HTTP, TCP, DNS, │                   │ Agent        │                        │ Cloud        │
│ TLS, databases, │                   │ (this repo)  │                        │ status pages │
│ OTLP push, …    │                   │              │                        │              │
└─────────────────┘                   └──────────────┘                        └──────────────┘
```

## Quick start

```bash
# 1. Install dependencies (Bun)
bun install

# 2. Configure (or use a .env file)
export AGENT_KEY="obs_live_..."                  # issued on the cloud Agents page
export PROMETHEUS_SERVER_URL="http://prometheus:9090"
export CLOUD_SERVER_URL="https://your-observer-cloud"

# 3. Run
bun run src/index.ts
```

`AGENT_KEY` is issued when you create an agent in Observer Cloud (the
Agents page) and is shown once. `PROMETHEUS_SERVER_URL` is required even
if you only run active probes (HTTP, TCP, DNS, …); point it at any
reachable Prometheus, or a placeholder if you have none yet.

### Docker

```bash
docker run --env-file .env ghcr.io/useobserver/agent:1.1.0
```

The debug dashboard binds to `127.0.0.1` inside the container, so
`-p 10101:10101` alone will not reach it (a published port dials the
container's external interface, not its loopback). To expose it, set
`DEBUG_DASHBOARD_HOST=0.0.0.0` and a `DEBUG_DASHBOARD_TOKEN`, then
publish the port. See [Debug dashboard](#debug-dashboard).

For the `icmp` source under Docker, add `--cap-add=NET_RAW`.

A [`docker-compose.yml`](./docker-compose.yml) is included for a
longer-lived deployment. Pin to an exact version tag rather than
`latest`; track releases on the repository's Releases page.

## Probe types

Each metric definition carries a `source_type`. The agent dispatches by
type and reports the sample value below.

| Type | Status | Sample value |
|---|---|---|
| `prometheus` | shipped | PromQL scalar |
| `http` | shipped | response_time_ms |
| `tcp` | shipped | connect_time_ms |
| `dns` | shipped | resolve_time_ms |
| `tls_cert` | shipped | days_until_expiry |
| `icmp` | shipped | latency ms / packet loss % / reachability |
| `grpc` | shipped | health state / Check latency ms |
| `websocket` | shipped | handshake ms / round-trip ms / connection |
| `database` | shipped | numeric scalar from a read-only query |
| `otlp` | shipped | aggregated OTLP data-point value |
| `cloudwatch` | shipped | latest metric value |
| `loki` | shipped | numeric scalar from a LogQL aggregation |
| `elasticsearch` | shipped | numeric scalar from an aggregation |
| `custom` | shipped | numeric scalar from a registered probe function |
| `host` | shipped | CPU / memory / filesystem / network / load-average % |
| `mtls_http` | deprecated | delegates to `http` |

`icmp` shells out to the system `ping` and needs the `CAP_NET_RAW`
capability (or equivalent) on the host. `mtls_http` is retained for
backward compatibility; configure mutual TLS on the `http` source
instead. Connection strings, AWS credentials, and client keys are read
from named host environment variables and never sent to the cloud.

## Requirements

- **Bun** >= 1.0 (the agent runs `.ts` directly; no build step). On
  other platforms `host` vitals degrade gracefully to `no_data`.
- **Linux** is first-class for the `host` source (reads `/proc`);
  macOS is supported with coarser values.
- **`CAP_NET_RAW`** on the host for the `icmp` source only.

## Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AGENT_KEY` | yes | — | Per-agent authentication credential (`obs_live_…`) |
| `PROMETHEUS_SERVER_URL` | yes | — | Reachable Prometheus endpoint |
| `CLOUD_SERVER_URL` | no | `https://localhost:3000` | Observer Cloud receiver |
| `PROMETHEUS_BASIC_AUTH_ENABLED` | no | `true` | Toggle HTTP basic auth on Prometheus |
| `PROMETHEUS_USERNAME` | no | `admin` | Basic-auth username, used when basic auth is enabled |
| `PROMETHEUS_PASSWORD` | no | — | Basic-auth password, used when basic auth is enabled |
| `VERBOSE` | no | `false` | DEBUG-level local log volume |
| `BROADCAST_LOGS` | no | `false` | Forward agent logs to the cloud for the operator dashboard |
| `LOG_BROADCAST_LEVEL` | no | `WARN` | Minimum level to forward |
| `SKIP_SSL_VERIFICATION` | no | `false` | TLS certificate verification on the cloud channel is ON by default. Set `true` only to trust self-signed certs in dev. |
| `ENABLE_DEBUG_DASHBOARD` | no | `true` | Serve the local debug dashboard |
| `DEBUG_DASHBOARD_HOST` | no | `127.0.0.1` | Dashboard bind address. Loopback-only by default; a non-loopback host requires `DEBUG_DASHBOARD_TOKEN` |
| `DEBUG_DASHBOARD_PORT` | no | `10101` | Dashboard port |
| `DEBUG_DASHBOARD_TOKEN` | no | — | Bearer token gating the dashboard. Required before it will bind a non-loopback `DEBUG_DASHBOARD_HOST` |
| `BUFFER_MAX_ROWS` | no | `10000` | Max rows in the local SQLite push buffer before oldest-row eviction |
| `BUFFER_PATH` | no | `./observer-agent-buffer.db` | Path to the local SQLite buffer file |
| `OBSERVER_OTLP_DISABLE` | no | `false` | Set `true` to disable the built-in OpenTelemetry Protocol receiver |
| `OBSERVER_OTLP_LISTEN_ADDR` | no | `127.0.0.1:4318` | OTLP/HTTP receiver bind address. A non-loopback bind requires `OBSERVER_OTLP_BEARER_TOKEN` |
| `OBSERVER_OTLP_BEARER_TOKEN` | no | — | Bearer token required when the OTLP receiver binds a non-loopback interface |
| `OBSERVER_OTLP_MAX_BODY_BYTES` | no | `16777216` | Max OTLP request body size (16 MiB; 1 MiB floor) |
| `OBSERVER_OTLP_MAX_BUFFER_POINTS` | no | `1000` | Max distinct OTLP streams buffered before oldest-stream eviction |
| `HTTPS_PROXY` | no | — | Proxy for outbound HTTPS, e.g. the cloud channel (honored by the Bun runtime). See [Restricted networks](#restricted-networks-proxy--egress-allowlist) |
| `HTTP_PROXY` | no | — | Proxy for outbound plain HTTP (honored by the Bun runtime) |
| `NO_PROXY` | no | — | Comma-separated hosts/suffixes/IPs that bypass the proxy (honored by the Bun runtime). No CIDR support |
| `NODE_EXTRA_CA_CERTS` | no | — | Path to an additional CA bundle to trust, e.g. a TLS-inspecting proxy's CA (honored by the Bun runtime) |

## Security and privacy

- **Verdicts only.** The push payload is `{ metric_id, value, status,
  timestamp }`. Query strings, credentials, and raw responses stay on
  your host; query strings are sha256-prefixed in any logs.
- **TLS on by default.** Certificate verification on the cloud channel
  is enabled unless you explicitly set `SKIP_SSL_VERIFICATION=true`.
- **Loopback by default.** The debug dashboard and the OTLP receiver
  bind to `127.0.0.1`. Each refuses to listen on a non-loopback address
  until you set its bearer token (`DEBUG_DASHBOARD_TOKEN` /
  `OBSERVER_OTLP_BEARER_TOKEN`).

## Restricted networks (proxy / egress allowlist)

The agent makes the proxy, NO_PROXY, and CA-bundle environment variables
of the Bun runtime work for you. The behavior below was verified against
**Bun 1.3.6** (the version this image and binary are built on) by running
the agent behind a local proxy, including the compiled binary.

### Egress requirements

The agent needs outbound HTTPS (port 443) to exactly **one** FQDN: the
host in `CLOUD_SERVER_URL`. Everything else it talks to (probe targets:
Prometheus, HTTP endpoints, databases, …) is on your own network. There
is no inbound requirement and no second outbound destination.

On an allowlist, permit `443/tcp` to the cloud host. A fully air-gapped
network with zero egress cannot reach the hosted cloud at all: in that
case you need a self-hosted Observer Cloud, not just a proxy.

### Proxy configuration

Set `HTTPS_PROXY` (and `HTTP_PROXY` for any plain-HTTP probe traffic).
Both the upper- and lower-case names are honored.

```bash
export HTTPS_PROXY="http://proxy.corp:3128"
# authenticated proxy:
export HTTPS_PROXY="http://user:pass@proxy.corp:3128"
```

With this set, the agent's heartbeat and verdict pushes to the cloud
host travel through the proxy (verified: they appear as `CONNECT`
entries in the proxy's access log).

### NO_PROXY for internal probe targets

`HTTPS_PROXY`/`HTTP_PROXY` are global to the process. Without `NO_PROXY`,
the agent's HTTP-based probes to your **internal** systems would also be
sent through the corporate proxy. That is usually wrong, and can be a
data-exposure concern. List your internal targets in `NO_PROXY` so they
bypass the proxy and are reached directly:

```bash
export NO_PROXY="prometheus.internal,.corp.local,10.20.30.40"
```

Verified `NO_PROXY` matching semantics on Bun 1.3.6:

| Form | Example | Matches |
|---|---|---|
| Exact host | `prometheus.internal` | that host |
| Domain suffix (leading dot) | `.corp.local` | `*.corp.local` |
| Bare suffix | `corp.local` | any host ending in `corp.local` |
| Exact IP | `10.20.30.40` | that address |
| Match-all | `*` | every host (disables the proxy) |

**Not supported** (verified to NOT match): **CIDR ranges**
(`10.0.0.0/8`) and mid-string globs (`host.*`). List internal targets by
hostname, domain suffix, or exact IP instead of a subnet.

Source types unaffected by an HTTP proxy because they do not use HTTP:
`tcp`, `dns`, `icmp` (these connect directly regardless of the proxy
vars). The `http`, `prometheus`, `loki`, and `elasticsearch` sources use
the runtime's HTTP client and therefore honor the proxy and `NO_PROXY`.
`websocket` issues a `CONNECT` through `HTTPS_PROXY`. The `cloudwatch`
and `grpc` sources are **not supported through an HTTP proxy**: the AWS
SDK and the gRPC client do not consult these variables, so that traffic
will not traverse the proxy.

### TLS-inspecting proxies (custom CA)

If the proxy terminates and re-signs TLS, point the runtime at the
corporate CA bundle so the re-signed certificate verifies:

```bash
export NODE_EXTRA_CA_CERTS="/etc/observer/corp-ca.pem"
```

Verified: with the CA bundle present, the cloud channel verifies and
connects normally; without it, the connection fails with
`unable to verify the first certificate`. **Do not** use
`SKIP_SSL_VERIFICATION=true` for this. That disables certificate
verification entirely and exposes the `AGENT_KEY` to interception; it
exists for local dev only.

### Offline-ish installs

- **Internal registry mirror:** pull `ghcr.io/useobserver/agent:<version>`
  through your mirror, or move it with `docker save` / `docker load`.
- **Standalone binary:** the compiled binary
  (`bun run build:binaries`) has no runtime dependency to fetch, so it
  runs on hosts that cannot reach a package registry. The proxy and CA
  variables above are honored by the binary identically.

## Debug dashboard

When `ENABLE_DEBUG_DASHBOARD=true` (the default), the agent serves a
small status page at `http://127.0.0.1:10101`: live counters, queue
depth, recent pushes, and active source types. To reach it from another
host, set `DEBUG_DASHBOARD_HOST` and a `DEBUG_DASHBOARD_TOKEN`, then send
the token as a bearer credential.

## How it works

The agent refetches its metric definitions from the cloud every 5
minutes and sends a heartbeat every 30 seconds. Each definition is
scheduled on its own interval; a verdict is pushed on status change or
on a forced-push interval. Pending pushes are held in a durable local
SQLite buffer (`bun:sqlite`) and drained with exponential backoff, so a
transient cloud outage never drops data.

### Source abstraction

Every source implements the same `Source` lifecycle contract defined in
`@observer/protocol`:

```ts
export interface Source<TConfig = Record<string, unknown>> {
  readonly mode: "pull" | "push";
  validateConfig(config: unknown): null | string;
  init(config: TConfig, env?: unknown): Promise<SourceInstance> | SourceInstance;
}

export interface SourceInstance {
  read(): Promise<ProbeResult>;
  dispose(): Promise<void> | void;
}
```

`ProbeResult` carries the numeric value, an ISO timestamp, an optional
`status_hint: "no_data"`, and reason / metadata fields. The scheduler
hands the result to `evaluate()` in `src/evaluator.ts`, which applies
the strict-operator threshold rules and produces a final status. The
agent emits the raw verdict every read; the cloud owns any dwell-gating
before a public status flips.

**Pull-mode** sources fetch a fresh value on demand: `init()` once per
definition, `read()` on the polling interval, `dispose()` when the
definition disappears. Older modules export the stateless `ProbeSource`
shape (`validateConfig` + `execute`) and are lifted into `Source` form
by the `asPullSource` adapter.

**Push-mode** sources receive data instead of fetching it: `init()`
opens a receiver and buffers incoming samples; `read()` returns the
latest buffered sample (or `no_data` when empty); `dispose()` shuts the
receiver down.

### Adding a new source type

1. Add the identifier to `SourceType` in
   `packages/protocol/src/definition.ts`.
2. Add a Zod schema for the config in `packages/probe-config/src/`.
3. **Pull source** — create `src/sources/<name>.ts` exporting
   `validateConfig` and `execute`. Add an entry to `SOURCES` in
   `src/sources/index.ts`; the adapter wraps it automatically.
4. **Push source** — create `src/sources/<name>.ts` exporting a
   `Source<TConfig>` object (with `mode: "push"`). Add an entry to the
   `PUSH_SOURCES` map in `src/sources/index.ts`.
5. Write tests in `tests/<name>.test.ts`.

## Status evaluation

Operators are strict everywhere: `over` is `>`, `under` is `<`, `equal`
is `=`. A value exactly equal to a threshold under `over`/`under` does
NOT match. The same rule is enforced server-side in Observer Cloud.

Per-metric:
- if the value matches `healthy_*` → `healthy`;
- else if it matches `unhealthy_*` → `unhealthy`;
- else `degraded`.

## Repository layout

```
.
├── src/
│   ├── index.ts          # Entry: heartbeat, drain loop, probe scheduler
│   ├── sources/          # Probe runtimes (15 types) + dispatch registry
│   ├── evaluator.ts      # Pure threshold evaluation
│   ├── status.ts         # Strict-operator comparison helpers
│   ├── buffer.ts         # Durable on-disk queue (bun:sqlite)
│   ├── drain.ts          # Drain controller with exponential backoff
│   └── dashboard.ts      # Embedded debug dashboard (:10101)
├── packages/
│   ├── protocol/         # Cloud↔agent wire contract
│   └── probe-config/     # Zod schemas
├── tests/                # Bun tests
├── scripts/              # Binary build driver (bun --compile)
├── Dockerfile
├── docker-compose.yml
├── LICENSE               # Apache-2.0
└── README.md             # this file
```

## Building from source

Bun runs `.ts` directly; there is no transpile step.

```bash
bun install
bun --bun tsc --noEmit -p tsconfig.json   # typecheck (strict)
bun test                                   # run all tests
bun run build:binaries                     # standalone binaries (all targets)
```

Tests cover status computation, buffer durability, drain backoff, queue
lag classification, every shipped source's `validateConfig` and
`execute` happy paths, the source lifecycle adapter, and the evaluator's
no-data and strict-operator branches.

## Versioning

Releases follow semver. Breaking changes to the heartbeat or push
contracts are major bumps. Check `packages/protocol` for the wire
contract version a given build targets.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE).
