// Managed-prober mode entry point.
//
//   bun run src/prober/main.ts          (or: bun run start:prober)
//
// Runs Observer's hosted outside-in checks from one location. This is NOT
// the org agent: it takes OBSERVER_PROBER_KEY (obs_prb_…), not AGENT_KEY,
// and refuses to start with an agent key. Only http, tcp, dns, tls_cert and
// icmp checks run here; every target is resolved, vetted against the SSRF
// policy and pinned before any connection.
//
// Environment:
//   OBSERVER_PROBER_KEY      required, the prober credential for this location
//   CLOUD_SERVER_URL         default https://use.observer (https only)
//   PROBER_LOCATION          optional; refuse to run if the cloud disagrees
//   PROBER_DNS_SERVERS       default 1.1.1.1,8.8.8.8 (public IPs only)
//   PROBER_ICMP              off | on | auto (default off; auto = try one loopback ping)
//   PROBER_CONCURRENCY       default 32
//   PROBER_REFRESH_SECONDS   default 30
//   PROBER_FLUSH_SECONDS     default 5
//   PROBER_MAX_RSS_MB        default 384; the watchdog exits above it (set below the memory limit)
//   PROBER_HEARTBEAT_FILE    optional; touched every ~10 s while the event loop runs (k8s liveness)
//
// Exit codes: 1 bad config, 70 watchdog (the supervisor restarts it), 0 clean stop.

import { writeFileSync } from "node:fs";
import pkg from "../../package.json" with { type: "json" };
import { WATCHDOG_INTERVAL_MS, buildDeps, createProber, detectIcmp, loadProberConfig, proberNetworkOk } from "./prober.ts";

const version = (pkg as { version: string }).version;

// Bun 1.4.3 sent no TLS SNI from pinned-IP fetches (every HTTPS check failed)
// and 1.3.6 reused one hostname's connection for another behind the same IP.
// 1.4.4 is the oldest runtime the prober is tested on.
export const MIN_BUN_VERSION = "1.4.4";

export function bunAtLeast(have: string, min: string): boolean {
  const a = have.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const b = min.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

// Bun's fetch honours these, which would route tenants' checks (and the
// prober key) through whatever proxy the host environment names.
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

async function main(): Promise<void> {
  const loaded = loadProberConfig(process.env, version);
  if (!loaded.ok) {
    console.error(`[ERROR] [prober] ${loaded.error}`);
    process.exit(1);
  }
  const cfg = loaded.config;
  if (!bunAtLeast(Bun.version, MIN_BUN_VERSION)) {
    console.error(`[ERROR] [prober] Bun ${Bun.version} is too old for prober mode; install Bun ${MIN_BUN_VERSION} or later.`);
    process.exit(1);
  }
  const proxied = PROXY_VARS.filter((k) => process.env[k]);
  if (proxied.length > 0) {
    console.error(`[ERROR] [prober] ${proxied.join(", ")} is set; prober mode connects directly and refuses to run behind a proxy.`);
    process.exit(1);
  }
  const icmpEnabled = cfg.icmp === "on" || (cfg.icmp === "auto" && (await detectIcmp()));
  console.log(
    `[INFO] [prober] Observer managed prober ${version} on Bun ${Bun.version} → ${cfg.cloudUrl}` +
      ` (dns ${cfg.dnsServers.join(",")}, icmp ${icmpEnabled ? "on" : "off"}, concurrency ${cfg.concurrency}, max rss ${cfg.maxRssMb} MB)`,
  );
  const deps = buildDeps(cfg, icmpEnabled);
  // Results are sent only after a network self-check passes (see proberNetworkOk).
  const heartbeatFile = process.env.PROBER_HEARTBEAT_FILE?.trim();
  const prober = createProber(cfg, deps, {
    selfCheck: () => proberNetworkOk(deps),
    ...(heartbeatFile ? { heartbeat: () => writeFileSync(heartbeatFile, String(Date.now())) } : {}),
  });
  prober.start();

  let stopping = false;
  const shutdown = async (signal: string, code: number) => {
    if (stopping) return;
    stopping = true;
    console.log(`[INFO] [prober] ${signal}: draining`);
    // A forced exit is non-zero so a lost final flush is visible.
    const hard = setTimeout(() => process.exit(code || 1), 25_000);
    await prober.stop();
    clearTimeout(hard);
    process.exit(code);
  };

  // Exit for a restart when the prober can no longer do its job (memory
  // over its cap, a stalled event loop, abandoned checks piling up, no
  // results). Looking alive while measuring nothing is the failure this
  // exists to prevent: a prober once checked in for days without producing
  // a result.
  setInterval(() => {
    const reason = prober.watchdog();
    if (!reason) return;
    const h = prober.health();
    console.error(
      `[ERROR] [prober] watchdog: ${reason}; exiting for a restart ` +
        `(rss ${Math.round(h.rss_mb ?? 0)} MB, lag ${h.lag_ms} ms, inflight ${h.inflight}, abandoned ${h.abandoned}, queued ${h.queued}, last result ${h.result_age_s} s ago)`,
    );
    void shutdown("watchdog", 70);
  }, WATCHDOG_INTERVAL_MS);
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
}

if (import.meta.main) {
  void main();
}
