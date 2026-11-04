# Changelog

All notable changes to the Observer Agent. Versions follow [semver](https://semver.org).
The image tags `1`, `1.x` and `latest` track the newest 1.x release.

## Unreleased

## 1.7.3 (2026-10-23)

- The local buffer now holds up to 200,000 samples (was 10,000), about 33 hours of cloud
  outage for 50 metrics at 30 seconds. Still configurable with `BUFFER_MAX_ROWS`.

## 1.7.2 (2026-10-22)

- Every `no_data` result is logged with its reason and how long the probe took.

## 1.7.1 (2026-10-20)

- Network errors map to one stable set of reason codes on every runtime.
- macOS host memory matches what Activity Monitor shows as Memory Used.
- Metric value units come from one shared definition.

## 1.7.0 (2026-10-15)

- Test a probe from the console before saving it, and browse CloudWatch metrics, through a
  new job queue between the agent and the cloud.
- The heartbeat no longer sends custom probe descriptions, only their names.

## 1.6.2 (2026-10-08)

- Prometheus-compatible backends (Mimir, Cortex, Thanos, VictoriaMetrics, Grafana Cloud):
  `PROMETHEUS_TENANT_ID`, `PROMETHEUS_BEARER_TOKEN` and `PROMETHEUS_HEADERS`.
- The heartbeat reports the host name.

## 1.6.1 (2026-10-08)

- HTTP probes accept `ca_cert_ref` without a client certificate.
- A plan suspension is explained in the logs instead of a bare HTTP 403.

## 1.6.0 (2026-10-06)

- Heartbeat relay: jobs without internet access can report heartbeats through the agent.
- Secret headers and gRPC metadata, read from env vars on the agent host.
- New and changed checks are picked up within one heartbeat instead of the 5-minute poll.
