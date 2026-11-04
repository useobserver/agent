// Minimal stand-in for Observer Cloud, for smoke tests that run the real
// agent (the Helm chart's kind smoke, chart.yml in the public repo). It has no
// dependencies, so it runs as a single file: `bun server.ts`, mounted from a
// ConfigMap into an oven/bun pod.
//
// Response shapes are copied from the real handlers under
// apps/web/app/api/agent/** (monorepo):
//   POST /api/agent/heartbeat           { ok, uptime_pct_24h, restart_count_24h, definitions_version }
//   GET  /api/agent/metrics-definitions bare array + x-observer-definitions-version header
//   POST /api/agent/receiver/batch      { accepted, rejected: [] }
//   GET  /api/agent/work/jobs           { jobs: [], next_poll_ms }
// plus, for the smoke test itself:
//   GET  /ok       the target of the one http metric it hands out
//   GET  /_assert  request counts per endpoint and the Agent-Key values seen
//
// Env: PORT (default 8080), MOCK_SELF_URL (how the agent reaches this server,
// default http://127.0.0.1:<port>).

type Counts = { heartbeats: number; definitions: number; batches: number; samples: number; jobs: number; other: number };

const DEFINITIONS_VERSION = "mock-cloud-v1";
const METRIC_ID = "5e1f0c2a-6b7d-4c3e-9a10-000000000001";

export function startMockCloud({ port = 8080, selfUrl }: { port?: number; selfUrl?: string } = {}) {
  const counts: Counts = { heartbeats: 0, definitions: 0, batches: 0, samples: 0, jobs: 0, other: 0 };
  const agentKeys = new Set<string>();

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);
      const key = `${req.method} ${url.pathname}`;
      if (url.pathname.startsWith("/api/agent/")) {
        const k = req.headers.get("agent-key");
        if (!k) return Response.json({ error: "Missing Agent-Key" }, { status: 401 });
        agentKeys.add(k);
      }
      switch (key) {
        case "GET /ok":
          return new Response("ok");
        case "GET /_assert":
          return Response.json({ ...counts, agent_keys: [...agentKeys] });
        case "POST /api/agent/heartbeat":
          counts.heartbeats++;
          await req.text();
          return Response.json(
            { ok: true, uptime_pct_24h: 100, restart_count_24h: 0, definitions_version: DEFINITIONS_VERSION },
            { headers: { "Cache-Control": "no-store" } },
          );
        case "GET /api/agent/metrics-definitions": {
          counts.definitions++;
          const self = (selfUrl ?? `http://127.0.0.1:${server.port}`).replace(/\/$/, "");
          return Response.json(
            [
              {
                id: METRIC_ID,
                query: "",
                source_type: "http",
                source_config: { url: `${self}/ok`, method: "GET", timeout_ms: 2000 },
                interval: 1,
                interval_agent_push: 1,
                healthy_operation: "under",
                healthy_value: 2000,
                unhealthy_operation: "over",
                unhealthy_value: 5000,
              },
            ],
            { headers: { "x-observer-definitions-version": DEFINITIONS_VERSION, "Cache-Control": "no-store" } },
          );
        }
        case "POST /api/agent/receiver/batch": {
          let rows: unknown = null;
          try {
            rows = await req.json();
          } catch {
            return Response.json({ error: "invalid_json" }, { status: 400 });
          }
          if (!Array.isArray(rows)) return Response.json({ error: "invalid_json" }, { status: 400 });
          counts.batches++;
          counts.samples += rows.length;
          return Response.json({ accepted: rows.length, rejected: [] });
        }
        case "GET /api/agent/work/jobs":
          counts.jobs++;
          return Response.json({ jobs: [], next_poll_ms: 5000 });
        default:
          counts.other++;
          if (req.method !== "GET" && req.method !== "HEAD") await req.text().catch(() => "");
          return Response.json({ ok: true });
      }
    },
  });
  return { server, counts, agentKeys };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  const { server } = startMockCloud({ port, selfUrl: process.env.MOCK_SELF_URL });
  console.log(`mock cloud listening on :${server.port}`);
}
