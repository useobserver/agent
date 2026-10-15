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

import pkg from "../../package.json" with { type: "json" };
import { buildDeps, createProber, detectIcmp, loadProberConfig } from "./prober.ts";

const version = (pkg as { version: string }).version;

async function main(): Promise<void> {
  const loaded = loadProberConfig(process.env, version);
  if (!loaded.ok) {
    console.error(`[ERROR] [prober] ${loaded.error}`);
    process.exit(1);
  }
  const cfg = loaded.config;
  const icmpEnabled = cfg.icmp === "on" || (cfg.icmp === "auto" && (await detectIcmp()));
  console.log(
    `[INFO] [prober] Observer managed prober ${version} → ${cfg.cloudUrl}` +
      ` (dns ${cfg.dnsServers.join(",")}, icmp ${icmpEnabled ? "on" : "off"}, concurrency ${cfg.concurrency})`,
  );
  const prober = createProber(cfg, buildDeps(cfg, icmpEnabled));
  prober.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[INFO] [prober] ${signal}: draining`);
    const hard = setTimeout(() => process.exit(0), 15_000);
    await prober.stop();
    clearTimeout(hard);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (import.meta.main) {
  void main();
}
