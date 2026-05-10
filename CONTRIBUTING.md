# Contributing to Observer Agent

Thanks for your interest. This repository is a public mirror of the
agent code from a private monorepo. Pull requests are welcome but the
review + merge path is asynchronous: PRs land here first, then a
maintainer round-trips them into the private repo and a subsequent
release pushes the merged change back out.

## Repository status

This repo is **mirror-only**. Direct pushes by maintainers come from
`tools/mirror-agent/mirror.sh` in the private monorepo. Do not expect
the GitHub web UI's "merge" button to be the canonical merge path —
it's a marker that the maintainer has accepted the change; the
actual merge into the source of truth happens privately.

## What lives here

- `src/` — the agent runtime: cron loop, push, heartbeat, source
  dispatch, local SQLite write-ahead buffer, drain controller,
  embedded debug dashboard.
- `tests/` — Bun test suite.
- `packages/protocol/` — vendored copy of the cloud↔agent wire
  contract (heartbeat shape, push payload, agent-health state machine).
  Read-only; do not edit here. Eventually published as
  `@observer/protocol` on npm.
- `packages/probe-config/` — vendored Zod schemas + write validator.
  Same read-only constraint.
- `packages/tsconfig/` — shared TypeScript presets.
- `Dockerfile` + `docker-compose.yml` — container packaging.

## Local development

```bash
bun install
bun test                    # run the test suite
bun run src/index.ts        # run the agent locally
```

The agent expects the following environment variables:

| Var | Required | Notes |
|-----|----------|-------|
| `AGENT_KEY` | yes | Your agent's secret key from the cloud. |
| `CLOUD_SERVER_URL` | yes | Observer cloud base URL. |
| `PROMETHEUS_SERVER_URL` | yes (for prometheus probes) | Local Prometheus base URL. |
| `BROADCAST_LOGS` | no | Default `false`. PromQL queries are always redacted. |

`bun:sqlite` writes a local buffer to `observer-agent-buffer.db`.
`.gitignore` excludes the file.

## What kind of PR is welcome

**Welcome:**
- Bug fixes in `src/`.
- New probe runtimes following the `ProbeSource<TConfig>` interface.
- Improvements to the local SQLite buffer or drain controller.
- Documentation, examples, README clarifications.
- Test coverage gaps.

**Not welcome here (open an issue first):**
- Changes to the wire contract (`packages/protocol/`). The contract is
  driven from the private cloud side.
- Changes to `packages/probe-config/` schemas. Same — these are
  upstream and synced down here.
- Major architectural shifts (multi-agent leadership, queue
  replacements, etc.). Discuss in an issue before writing code.

If your change touches the contract or schemas, open an issue and
we'll discuss whether the upstream change is appropriate before any
code lands.

## Style

Match the surrounding code:
- TypeScript, strict mode.
- Bun runtime APIs (`bun:sqlite`, `Bun.serve`, native `fetch`) where
  available.
- Comments explain WHY, not WHAT.
- Keep PRs focused; one concern per PR.

## License

By submitting a PR, you agree your contribution is licensed under
the Apache License 2.0 (see `LICENSE`).

## Reporting security issues

Do not file public issues for security problems. Email security
concerns directly so we can patch in private before disclosure.
Contact: see the repo description.
