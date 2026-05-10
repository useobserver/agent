// Observer agent debug dashboard.
//
// Single Bun.serve() listener on port 10101 that renders a small HTML
// page + a JSON state endpoint. Read-only; never mutates agent state.
//
// Default-on; opt-out via ENABLE_DEBUG_DASHBOARD=false. Bind address
// + port configurable via DEBUG_DASHBOARD_HOST / DEBUG_DASHBOARD_PORT.
//
// Env exposure: explicit allowlist of agent-relevant variables. Every
// variable on the list goes through maskValue() (always — even
// non-sensitive entries are partially masked so accidental sharing of
// the dashboard UI never reveals a full token). Anything off the list
// is invisible to the dashboard regardless of name.
//
// Memory: ~5MB. CPU at idle: near zero. The dashboard polls every 5s.
// The agent main loop is unaffected.

import type { DashboardSnapshot } from "./types.ts";

interface StateProvider {
  getSnapshot(): DashboardSnapshot;
}

// Allowlist. Names matching `*_*` glob (e.g. PROMETHEUS_*) accept any
// suffix. Operators wanting more vars visible should fork — the
// default ships the minimum viable surface.
const ENV_ALLOWLIST: ReadonlyArray<string | RegExp> = [
  "AGENT_KEY",
  "CLOUD_SERVER_URL",
  "BROADCAST_LOGS",
  "ENABLE_DEBUG_DASHBOARD",
  "NODE_ENV",
  /^PROMETHEUS_/,
  /^DEBUG_DASHBOARD_/,
];

function isAllowed(key: string): boolean {
  for (const m of ENV_ALLOWLIST) {
    if (typeof m === "string" ? m === key : m.test(key)) return true;
  }
  return false;
}

function maskValue(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function maskEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = Object.keys(env).sort();
  for (const k of keys) {
    if (!isAllowed(k)) continue;
    const v = env[k];
    if (typeof v !== "string") continue;
    out[k] = maskValue(v);
  }
  return out;
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Observer agent — debug</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d10;
      --fg: #e6e6e6;
      --muted: #8a8f99;
      --card: #14171c;
      --border: #1f242c;
      --green: #4ade80;
      --amber: #fbbf24;
      --red: #f87171;
    }
    * { box-sizing: border-box; }
    body { font: 13px/1.45 ui-monospace, "JetBrains Mono", monospace; background: var(--bg); color: var(--fg); margin: 0; padding: 24px; }
    h1 { font-size: 16px; font-weight: 600; margin: 0 0 4px; letter-spacing: 0.02em; }
    .lede { color: var(--muted); margin: 0 0 24px; font-size: 11px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 12px 14px; }
    .card h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 8px; font-weight: 500; }
    dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; }
    dt { color: var(--muted); }
    dd { margin: 0; word-break: break-all; }
    .ok { color: var(--green); }
    .warn { color: var(--amber); }
    .err { color: var(--red); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 6px 4px 0; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
    td { padding: 4px 6px 4px 0; vertical-align: top; }
    tr + tr td { border-top: 1px solid var(--border); }
    .pill { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; }
    .pill.ok { background: rgba(74,222,128,0.15); color: var(--green); }
    .pill.warn { background: rgba(251,191,36,0.15); color: var(--amber); }
    .pill.err { background: rgba(248,113,113,0.15); color: var(--red); }
    .pill.muted { background: rgba(138,143,153,0.15); color: var(--muted); }
    .footer { margin-top: 24px; color: var(--muted); font-size: 11px; }
  </style>
</head>
<body>
  <h1>Observer agent / debug</h1>
  <p class="lede">Read-only snapshot. Refreshes every 5 seconds. Disable with ENABLE_DEBUG_DASHBOARD=false.</p>
  <div id="root">loading…</div>
  <p class="footer">last refresh: <span id="ts">—</span></p>
  <script>
    const fmt = (v) => v == null ? "—" : v;
    const fmtAge = (s) => {
      if (s == null) return "—";
      if (s < 60) return s + "s";
      if (s < 3600) return Math.floor(s/60) + "m";
      return (s/3600).toFixed(1) + "h";
    };
    const pill = (cls, text) => '<span class="pill ' + cls + '">' + text + '</span>';
    const ok = (b) => b == null ? pill("muted", "—") : (b ? pill("ok", "ok") : pill("err", "fail"));
    function render(s) {
      const cfg = Object.entries(s.config).map(([k,v]) => '<tr><td>'+k+'</td><td>'+v+'</td></tr>').join("");
      const defs = s.definitions.map(d => (
        '<tr>'
          + '<td>' + d.id.slice(0,8) + '…</td>'
          + '<td>' + d.source_type + '</td>'
          + '<td>' + d.interval_minutes + 'm</td>'
          + '<td>' + (d.last_status ? pill(d.last_status === 'healthy' ? 'ok' : d.last_status === 'unhealthy' ? 'err' : 'warn', d.last_status) : pill('muted','—')) + '</td>'
          + '<td>' + fmt(d.last_value) + '</td>'
          + '<td>' + (d.last_at ? new Date(d.last_at).toLocaleTimeString() : '—') + '</td>'
          + '<td>' + fmt(d.last_reason) + '</td>'
        + '</tr>'
      )).join("");
      const queueTone = s.queue.depth > 1000 || s.queue.oldest_age_seconds > 300 ? 'err' : (s.queue.depth > 50 ? 'warn' : 'ok');
      const sources = s.active_source_types.length ? s.active_source_types.map(t => pill('ok', t)).join(' ') : pill('muted', 'none');
      document.getElementById("root").innerHTML =
        '<div class="grid">'
          + '<div class="card"><h2>Process</h2><dl>'
            + '<dt>uptime</dt><dd>' + fmtAge(s.process.uptime_seconds) + '</dd>'
            + '<dt>memory</dt><dd>' + s.process.memory_rss_mb.toFixed(1) + ' MB</dd>'
            + '<dt>started</dt><dd>' + new Date(s.process.agent_started_at).toLocaleString() + '</dd>'
            + '<dt>version</dt><dd>' + s.process.version + ' (bun ' + s.process.bun_version + ')</dd>'
          + '</dl></div>'

          + '<div class="card"><h2>Queue ' + pill(queueTone, queueTone === 'ok' ? 'healthy' : queueTone === 'warn' ? 'warm' : 'lagging') + '</h2><dl>'
            + '<dt>depth</dt><dd>' + s.queue.depth + ' / ' + s.queue.capacity + '</dd>'
            + '<dt>oldest</dt><dd>' + fmtAge(s.queue.oldest_age_seconds) + '</dd>'
            + '<dt>backoff</dt><dd>' + s.queue.drain_backoff_ms + 'ms</dd>'
          + '</dl></div>'

          + '<div class="card"><h2>Cloud</h2><dl>'
            + '<dt>url</dt><dd>' + s.cloud.cloud_server_url + '</dd>'
            + '<dt>last hb</dt><dd>' + ok(s.cloud.last_heartbeat_ok) + (s.cloud.last_heartbeat_at ? ' ' + new Date(s.cloud.last_heartbeat_at).toLocaleTimeString() : '') + '</dd>'
            + (s.cloud.last_heartbeat_error ? '<dt></dt><dd class="err">' + s.cloud.last_heartbeat_error + '</dd>' : '')
            + '<dt>last post</dt><dd>' + ok(s.cloud.last_post_ok) + (s.cloud.last_post_at ? ' ' + new Date(s.cloud.last_post_at).toLocaleTimeString() : '') + '</dd>'
            + (s.cloud.last_post_error ? '<dt></dt><dd class="err">' + s.cloud.last_post_error + '</dd>' : '')
          + '</dl></div>'

          + '<div class="card"><h2>Prometheus</h2><dl>'
            + '<dt>url</dt><dd>' + s.prometheus.server_url + '</dd>'
            + '<dt>last probe</dt><dd>' + (s.prometheus.last_probe_outcome ? pill(s.prometheus.last_probe_outcome === 'success' ? 'ok' : 'err', s.prometheus.last_probe_outcome) : pill('muted','—')) + ' ' + (s.prometheus.last_probe_at ? new Date(s.prometheus.last_probe_at).toLocaleTimeString() : '') + '</dd>'
          + '</dl></div>'

          + '<div class="card" style="grid-column: 1 / -1;"><h2>Active source types</h2>' + sources + '</div>'

          + '<div class="card" style="grid-column: 1 / -1;"><h2>Metric definitions (' + s.definitions.length + ')</h2>'
            + (defs ? '<table><thead><tr><th>id</th><th>type</th><th>interval</th><th>status</th><th>value</th><th>at</th><th>reason</th></tr></thead><tbody>' + defs + '</tbody></table>' : '<p style="color:var(--muted)">No definitions polled yet.</p>')
          + '</div>'

          + '<div class="card" style="grid-column: 1 / -1;"><h2>Configuration</h2><table><thead><tr><th>key</th><th>value</th></tr></thead><tbody>' + cfg + '</tbody></table></div>'
        + '</div>';
      document.getElementById("ts").textContent = new Date().toLocaleTimeString();
    }
    async function tick() {
      try {
        const r = await fetch("/api/state");
        const s = await r.json();
        render(s);
      } catch (e) {
        document.getElementById("root").innerHTML = '<p class="err">fetch failed: ' + e.message + '</p>';
      }
    }
    tick();
    setInterval(tick, 5000);
  </script>
</body>
</html>`;

export interface DashboardOptions {
  port?: number;
  hostname?: string;
  state: StateProvider;
}

export interface DashboardServer {
  stop(): void;
  port: number;
  hostname: string;
}

export function startDashboard(opts: DashboardOptions): DashboardServer {
  const port = opts.port ?? Number(process.env.DEBUG_DASHBOARD_PORT) ?? 10101;
  const hostname = opts.hostname ?? process.env.DEBUG_DASHBOARD_HOST ?? "0.0.0.0";

  const server = Bun.serve({
    port,
    hostname,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (url.pathname === "/api/state") {
        const snap = opts.state.getSnapshot();
        return new Response(JSON.stringify(snap), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      if (url.pathname === "/healthz") {
        return new Response("ok", { headers: { "Content-Type": "text/plain" } });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    port: server.port ?? port,
    hostname: typeof server.hostname === "string" ? server.hostname : hostname,
    stop() {
      server.stop(true);
    },
  };
}
