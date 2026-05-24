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

// Terminal-adjacent register. Hand-written CSS, no framework. Bright
// terminal-glyph greens/ambers/reds — closer to `top` than to SaaS.
const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>observer-agent · :10101</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0a0b;
      --surface: #111114;
      --surface-2: #16161a;
      --ink: #e5e7eb;
      --ink-2: #94a3b8;
      --ink-3: #64748b;
      --hairline: #1f2024;
      --green: #4ade80;
      --amber: #fbbf24;
      --red: #f87171;
      --blue: #60a5fa;
      --magenta: #c084fc;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 13px;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    body { padding-bottom: 44px; }
    a { color: var(--blue); text-decoration: none; }

    .topbar {
      display: flex; align-items: center; gap: 18px;
      padding: 10px 18px;
      border-bottom: 1px solid var(--hairline);
      background: var(--surface);
      flex-wrap: wrap;
    }
    .topbar h1 {
      margin: 0; font-size: 13px; font-weight: 600;
      letter-spacing: 0.02em; color: var(--ink);
    }
    .topbar .meta { color: var(--ink-3); font-size: 11px; }
    .topbar .right { margin-left: auto; display: flex; gap: 14px; align-items: center; color: var(--ink-3); font-size: 11px; }
    .blink { animation: blink 1.2s steps(2, end) infinite; }
    @keyframes blink { 50% { opacity: 0.2; } }

    h2 {
      font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--ink-3);
      margin: 0 0 10px; font-weight: 500;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 14px;
      padding: 18px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--hairline);
      border-radius: 4px;
      padding: 14px;
    }
    .card .head {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 12px;
    }
    .card .head .lbl {
      color: var(--ink-3); text-transform: uppercase;
      letter-spacing: 0.08em; font-size: 11px;
    }
    .card dl {
      margin: 0; display: grid;
      grid-template-columns: 1fr auto;
      row-gap: 6px; column-gap: 18px;
      font-size: 12px;
    }
    .card dt { color: var(--ink-3); }
    .card dd { margin: 0; color: var(--ink); text-align: right; word-break: break-all; }
    .card dd.long { font-size: 11px; }

    /* Status pills — square-cornered, terminal palette */
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 2px 8px; border-radius: 3px;
      font-size: 11px; font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.08em;
    }
    .pill .dot { width: 6px; height: 6px; border-radius: 999px; display: inline-block; }
    .pill.running { color: var(--green); background: rgba(74,222,128,0.10); }
    .pill.running .dot { background: var(--green); }
    .pill.ok      { color: var(--green); background: rgba(74,222,128,0.10); }
    .pill.ok .dot { background: var(--green); }
    .pill.ready   { color: var(--blue);  background: rgba(96,165,250,0.10); }
    .pill.ready .dot { background: var(--blue); }
    .pill.stopped, .pill.err {
      color: var(--red); background: rgba(248,113,113,0.10);
    }
    .pill.stopped .dot, .pill.err .dot { background: var(--red); animation: pulse 1.6s infinite; }
    .pill.degraded, .pill.warn, .pill.no_data {
      color: var(--amber); background: rgba(251,191,36,0.10);
    }
    .pill.degraded .dot, .pill.warn .dot, .pill.no_data .dot { background: var(--amber); animation: pulse 1.6s infinite; }
    .pill.muted   { color: var(--ink-3); background: rgba(138,143,153,0.10); }
    .pill.muted .dot { background: var(--ink-3); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

    .probe-wrap { margin: 0 18px; border: 1px solid var(--hairline); border-radius: 4px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
    thead th {
      text-align: left; font-weight: 500; font-size: 10px;
      color: var(--ink-3); text-transform: uppercase;
      letter-spacing: 0.1em; padding: 10px 14px;
      border-bottom: 1px solid var(--hairline);
      background: var(--surface-2);
    }
    thead th.r { text-align: right; }
    tbody td {
      padding: 9px 14px; border-bottom: 1px solid var(--hairline);
      color: var(--ink);
    }
    tbody td.r { text-align: right; }
    tbody tr:hover { background: var(--surface-2); }
    tbody td .name { color: var(--ink); font-weight: 500; }
    tbody td .source { color: var(--ink-3); font-size: 11px; word-break: break-all; }
    tbody td.empty { color: var(--ink-3); text-align: center; padding: 18px; }

    .log {
      background: var(--surface);
      border: 1px solid var(--hairline);
      border-radius: 4px;
      padding: 12px 14px;
      margin: 18px;
      font-size: 12px; line-height: 1.6;
      overflow: auto; resize: vertical;
      min-height: 50px; max-height: 500px;
    }
    .log .line { display: grid; grid-template-columns: 90px 60px 1fr; gap: 12px; }
    .log .t { color: var(--ink-3); }
    .log .lvl { font-weight: 600; }
    .log .lvl.info { color: var(--blue); }
    .log .lvl.warn { color: var(--amber); }
    .log .lvl.err  { color: var(--red); }
    .log .lvl.ok   { color: var(--green); }
    .log .msg { color: var(--ink-2); word-break: break-word; }
    .log .empty { color: var(--ink-3); }

    .modeline {
      position: fixed; left: 0; right: 0; bottom: 0;
      z-index: 10;
      display: flex; gap: 16px; flex-wrap: wrap;
      padding: 6px 18px;
      background: var(--surface);
      border-top: 1px solid var(--hairline);
      font-size: 11px; color: var(--ink-3);
    }
    .modeline .seg { display: inline-flex; gap: 6px; align-items: center; }
    .modeline .seg b { color: var(--ink); font-weight: 500; }
    .modeline .right { margin-left: auto; display: inline-flex; gap: 14px; }

    /* Sources grid inside the Sources card */
    .src-grid { display: grid; grid-template-columns: 1fr auto; row-gap: 6px; column-gap: 18px; font-size: 12px; }
    .src-grid .label { color: var(--ink-3); }
    .src-grid .val.up { color: var(--green); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; font-size: 11px; }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>observer-agent</h1>
    <span class="meta" id="topMeta">starting…</span>
    <div class="right">
      <span id="topHost"></span>
      <span id="topPill"></span>
      <span>refresh in <b id="refreshIn">5</b><span class="blink">s</span></span>
    </div>
  </div>

  <section style="padding: 18px 18px 0;"><h2>Agent</h2></section>
  <div id="cards" class="grid"></div>

  <section style="padding: 0 18px;"><h2 id="probesHead">Probes</h2></section>
  <div class="probe-wrap"><table>
    <thead><tr>
      <th style="width:38%">Probe</th>
      <th>Source</th>
      <th>Status</th>
      <th class="r">Value</th>
      <th class="r">Threshold</th>
      <th class="r">Interval</th>
      <th class="r">Last eval</th>
    </tr></thead>
    <tbody id="probes"></tbody>
  </table></div>

  <section style="padding: 18px 18px 0;"><h2 id="logHead">Log</h2></section>
  <div class="log" id="log"></div>

  <div class="modeline" id="modeline"></div>

  <script>
    const POLL_MS = 5000;
    const esc = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const fmt = (v) => v == null ? "—" : v;
    const fmtAge = (s) => {
      if (s == null) return "—";
      if (s < 60) return s + "s";
      if (s < 3600) return Math.floor(s/60) + "m " + (s%60) + "s";
      const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60); const ss = s%60;
      return h + "h " + m + "m " + (ss < 10 ? "0"+ss : ss) + "s";
    };
    const fmtNum = (n) => typeof n === "number" ? n.toLocaleString() : fmt(n);
    const fmtVal = (v) => v == null ? "—" : (typeof v === "number" ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3)) : v);
    const sinceMs = (iso) => iso ? (Date.now() - new Date(iso).getTime()) : null;
    const fmtSince = (iso) => {
      const ms = sinceMs(iso);
      if (ms == null) return "—";
      if (ms < 1000) return "now";
      const s = Math.floor(ms / 1000);
      return fmtAge(s) + " ago";
    };
    const pill = (cls, text) => '<span class="pill ' + cls + '"><span class="dot"></span>' + esc(text) + '</span>';
    const okPill = (b) => b == null ? pill("muted", "—") : (b ? pill("ok", "OK") : pill("err", "FAIL"));

    function thresholdText(d) {
      // Render as "healthy_op healthy_value · unhealthy_op unhealthy_value"
      const sym = (op) => op === "over" ? "&gt;" : op === "under" ? "&lt;" : op === "equal" ? "=" : "?";
      const parts = [];
      if (d.healthy_operation != null && d.healthy_value != null) {
        parts.push("ok " + sym(d.healthy_operation) + " " + fmtVal(d.healthy_value));
      }
      if (d.unhealthy_operation != null && d.unhealthy_value != null) {
        parts.push("bad " + sym(d.unhealthy_operation) + " " + fmtVal(d.unhealthy_value));
      }
      return parts.length ? parts.join(" · ") : "—";
    }

    function statusPill(s) {
      if (!s) return pill("muted", "—");
      const cls = s === "healthy" ? "ok"
                : s === "unhealthy" ? "err"
                : s === "degraded" ? "warn"
                : s === "no_data" ? "no_data"
                : "muted";
      return pill(cls, s);
    }

    function shortHost(h) { return h && h.length > 22 ? h.slice(0, 22) + "…" : (h || ""); }
    function cleanUrl(u) {
      try { const p = new URL(u); return p.host; } catch { return u || ""; }
    }

    function renderCards(s) {
      const cardRuntime = '<article class="card">'
        + '<div class="head"><span class="lbl">Runtime</span>' + pill("running", "RUNNING") + '</div>'
        + '<dl>'
          + '<dt>Version</dt><dd>' + esc(s.process.version) + '</dd>'
          + '<dt>Bun</dt><dd>' + esc(s.process.bun_version) + '</dd>'
          + '<dt>PID</dt><dd>' + s.process.pid + '</dd>'
          + '<dt>Host</dt><dd class="long" title="' + esc(s.process.hostname) + '">' + esc(s.process.hostname) + '</dd>'
          + '<dt>Memory</dt><dd>' + s.process.memory_rss_mb.toFixed(2) + ' MB</dd>'
          + '<dt>Uptime</dt><dd>' + fmtAge(s.process.uptime_seconds) + '</dd>'
        + '</dl></article>';

      const cloudOk = s.cloud.last_heartbeat_ok !== false && s.cloud.last_post_ok !== false;
      const cardCloud = '<article class="card">'
        + '<div class="head"><span class="lbl">Cloud link</span>' + (cloudOk ? pill("running", "CONNECTED") : pill("stopped", "DEGRADED")) + '</div>'
        + '<dl>'
          + '<dt>Endpoint</dt><dd>' + esc(cleanUrl(s.cloud.cloud_server_url)) + '</dd>'
          + '<dt>Last heartbeat</dt><dd>' + okPill(s.cloud.last_heartbeat_ok) + ' ' + fmtSince(s.cloud.last_heartbeat_at) + '</dd>'
          + (s.cloud.last_heartbeat_error ? '<dt>HB error</dt><dd style="color:var(--red)" class="long">' + esc(s.cloud.last_heartbeat_error) + '</dd>' : '')
          + '<dt>Last push</dt><dd>' + okPill(s.cloud.last_post_ok) + ' ' + fmtSince(s.cloud.last_post_at) + '</dd>'
          + (s.cloud.last_post_error ? '<dt>Push error</dt><dd style="color:var(--red)" class="long">' + esc(s.cloud.last_post_error) + '</dd>' : '')
        + '</dl></article>';

      const c = s.counters || { evaluations: 0, pushes: 0, errors: 0, dropped: 0 };
      const counterTone = c.errors > 0 ? "warn" : "ok";
      const cardCounters = '<article class="card">'
        + '<div class="head"><span class="lbl">Counters</span>' + pill(counterTone, counterTone === "ok" ? "OK" : "errors") + '</div>'
        + '<dl>'
          + '<dt>Probes loaded</dt><dd>' + s.definitions.length + '</dd>'
          + '<dt>Evaluations</dt><dd>' + fmtNum(c.evaluations) + '</dd>'
          + '<dt>Verdicts pushed</dt><dd>' + fmtNum(c.pushes) + '</dd>'
          + '<dt>Errors</dt><dd' + (c.errors > 0 ? ' style="color:var(--amber)"' : '') + '>' + fmtNum(c.errors) + '</dd>'
          + '<dt>Dropped</dt><dd' + (c.dropped > 0 ? ' style="color:var(--red)"' : '') + '>' + fmtNum(c.dropped) + '</dd>'
        + '</dl></article>';

      const queueTone = s.queue.depth > 1000 || s.queue.oldest_age_seconds > 300 ? "err"
                      : (s.queue.depth > 50 ? "warn" : "ok");
      const cardQueue = '<article class="card">'
        + '<div class="head"><span class="lbl">Queue</span>' + pill(queueTone, queueTone === "ok" ? "HEALTHY" : queueTone === "warn" ? "WARM" : "LAGGING") + '</div>'
        + '<dl>'
          + '<dt>Depth</dt><dd>' + s.queue.depth + ' / ' + s.queue.capacity + '</dd>'
          + '<dt>Oldest</dt><dd>' + fmtAge(s.queue.oldest_age_seconds) + '</dd>'
          + '<dt>Drain backoff</dt><dd>' + s.queue.drain_backoff_ms + ' ms</dd>'
        + '</dl></article>';

      const sourcesActive = s.active_source_types || [];
      const sourceRows = sourcesActive.length === 0
        ? '<div class="label" style="color:var(--ink-3)">no sources active</div>'
        : sourcesActive.map((t) => '<div class="label">' + esc(t) + '</div><div class="val up">UP</div>').join("");
      const cardSources = '<article class="card">'
        + '<div class="head"><span class="lbl">Sources</span>' + pill(sourcesActive.length ? "ready" : "muted", sourcesActive.length + " active") + '</div>'
        + '<div class="src-grid">' + sourceRows + '</div></article>';

      const cardPrometheus = '<article class="card">'
        + '<div class="head"><span class="lbl">Prometheus</span>' + (s.prometheus.last_probe_outcome === "success" ? pill("ok", "OK") : s.prometheus.last_probe_outcome ? pill("warn", s.prometheus.last_probe_outcome) : pill("muted", "—")) + '</div>'
        + '<dl>'
          + '<dt>URL</dt><dd class="long">' + esc(s.prometheus.server_url || "—") + '</dd>'
          + '<dt>Last probe</dt><dd>' + fmtSince(s.prometheus.last_probe_at) + '</dd>'
        + '</dl></article>';

      document.getElementById("cards").innerHTML =
        cardRuntime + cardCloud + cardCounters + cardQueue + cardSources + cardPrometheus;
    }

    function renderProbes(s) {
      document.getElementById("probesHead").textContent = "Probes · " + s.definitions.length + " active";
      const tbody = document.getElementById("probes");
      if (s.definitions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">No metric definitions polled yet.</td></tr>';
        return;
      }
      tbody.innerHTML = s.definitions.map((d) => {
        const idShort = d.id.slice(0, 8);
        const interval = d.interval_minutes + "m";
        const value = d.last_value == null ? "—" : fmtVal(d.last_value);
        return '<tr>'
          + '<td><span class="name">' + esc(idShort) + '</span><div class="source">id ' + esc(d.id) + '</div></td>'
          + '<td>' + esc(d.source_type) + '</td>'
          + '<td>' + statusPill(d.last_status) + '</td>'
          + '<td class="r">' + esc(value) + '</td>'
          + '<td class="r" style="color:var(--ink-3)">' + thresholdText(d) + '</td>'
          + '<td class="r">' + esc(interval) + '</td>'
          + '<td class="r">' + esc(fmtSince(d.last_at)) + '</td>'
        + '</tr>';
      }).join("");
    }

    function renderLogs(s) {
      const logs = s.recent_logs || [];
      document.getElementById("logHead").textContent = "Log · last " + logs.length;
      const el = document.getElementById("log");
      if (logs.length === 0) {
        el.innerHTML = '<div class="empty">no log entries yet</div>';
        return;
      }
      el.innerHTML = logs.slice().reverse().map((l) => {
        const t = (l.timestamp || "").slice(11, 23) || "—";
        const lvl = String(l.level || "INFO").toUpperCase();
        const cls = lvl === "ERROR" ? "err" : lvl === "WARN" || lvl === "WARNING" ? "warn" : lvl === "INFO" ? "info" : "ok";
        return '<div class="line"><span class="t">' + esc(t) + '</span>'
          + '<span class="lvl ' + cls + '">' + esc(lvl) + '</span>'
          + '<span class="msg">' + esc(l.message) + '</span></div>';
      }).join("");
    }

    function renderTopbar(s) {
      const meta = "v" + s.process.version
        + " · pid " + s.process.pid
        + " · bun " + s.process.bun_version
        + " · started " + fmtSince(s.process.agent_started_at);
      document.getElementById("topMeta").textContent = meta;
      document.getElementById("topHost").textContent = shortHost(s.process.hostname);
      document.getElementById("topPill").innerHTML = pill("running", "RUNNING");
    }

    function renderModeline(s) {
      const counts = { healthy: 0, degraded: 0, unhealthy: 0, no_data: 0, ready: 0 };
      for (const d of s.definitions) {
        const k = d.last_status || "ready";
        if (counts[k] != null) counts[k]++;
        else counts.ready++;
      }
      const c = s.counters || {};
      document.getElementById("modeline").innerHTML =
        '<span class="seg"><b>NORMAL</b></span>'
        + '<span class="seg">probes <b>' + s.definitions.length + '</b></span>'
        + '<span class="seg">healthy <b style="color:var(--green)">' + counts.healthy + '</b></span>'
        + '<span class="seg">degraded <b style="color:var(--amber)">' + counts.degraded + '</b></span>'
        + '<span class="seg">unhealthy <b style="color:var(--red)">' + counts.unhealthy + '</b></span>'
        + '<span class="seg">no_data <b style="color:var(--amber)">' + counts.no_data + '</b></span>'
        + '<span class="seg">ready <b>' + counts.ready + '</b></span>'
        + '<div class="right">'
          + '<span class="seg">mem <b>' + s.process.memory_rss_mb.toFixed(2) + 'M</b></span>'
          + '<span class="seg">pushes <b>' + (c.pushes ?? 0) + '</b></span>'
          + '<span class="seg">errors <b' + ((c.errors ?? 0) > 0 ? ' style="color:var(--amber)"' : '') + '>' + (c.errors ?? 0) + '</b></span>'
          + '<span class="seg">tick <b class="blink">●</b></span>'
        + '</div>';
    }

    function render(s) {
      renderTopbar(s);
      renderCards(s);
      renderProbes(s);
      renderLogs(s);
      renderModeline(s);
    }

    let countdown = POLL_MS / 1000;
    function refreshCountdown() {
      const el = document.getElementById("refreshIn");
      if (!el) return;
      el.textContent = countdown;
      countdown = countdown <= 1 ? POLL_MS / 1000 : countdown - 1;
    }

    async function tick() {
      try {
        const r = await fetch("/api/state");
        const s = await r.json();
        render(s);
        countdown = POLL_MS / 1000;
      } catch (e) {
        document.getElementById("cards").innerHTML =
          '<div class="card" style="grid-column: 1 / -1; color: var(--red);">fetch failed: ' + esc(e.message) + '</div>';
      }
    }

    tick();
    setInterval(tick, POLL_MS);
    setInterval(refreshCountdown, 1000);
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
  const hostname =
    opts.hostname ?? process.env.DEBUG_DASHBOARD_HOST ?? "0.0.0.0";

  const server = Bun.serve({
    port,
    hostname,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
      if (url.pathname === "/api/state") {
        const snap = opts.state.getSnapshot();
        return new Response(JSON.stringify(snap), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      }
      if (url.pathname === "/healthz") {
        return new Response("ok", {
          headers: { "Content-Type": "text/plain" },
        });
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
