// ICMP ping probe source.
//
// Bun has no raw-socket (SOCK_RAW) API and native ICMP addons
// (net-ping) don't build reliably under Bun, so this source shells
// out to the system `ping` binary — the same approach the `ping` npm
// package takes. The binary handles the raw-socket privilege itself
// (it's typically setuid root or has cap_net_raw+ep); in a container
// the agent's environment must grant CAP_NET_RAW for ping to send
// ICMP. See the docs.
//
// We NEVER fall back to a TCP probe when ICMP can't run — a TCP
// connect tests a different layer and would mask the real failure.
// Privilege / availability problems surface with a typed reason and
// the documented fix.

import { spawn } from "node:child_process";
import type { ProbeResult, ProbeSource } from "../types.ts";
import { IcmpConfigSchema, type IcmpConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(IcmpConfigSchema, config);
}

interface PingOutcome {
  transmitted: number;
  received: number;
  avgRttMs: number | null;
}

// Build platform-specific `ping` argv. host is a discrete argv element
// (no shell) and the schema rejects a leading "-", so it can't be
// read as a flag.
function buildPingArgs(host: string, count: number, timeoutMs: number): string[] {
  const args = ["-c", String(count)];
  if (process.platform === "darwin") {
    // macOS: -W is per-packet wait in MILLISECONDS.
    args.push("-W", String(timeoutMs));
  } else {
    // Linux (iputils): -W is per-packet timeout in SECONDS (>= 1).
    args.push("-W", String(Math.max(1, Math.ceil(timeoutMs / 1000))));
  }
  args.push(host);
  return args;
}

// Parse Linux (iputils) + macOS ping summary output. Returns null
// when no summary line is found.
export function parsePingOutput(out: string): PingOutcome | null {
  const summary = out.match(
    /(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets )?received/i,
  );
  if (!summary) return null;
  const transmitted = Number(summary[1]);
  const received = Number(summary[2]);

  let avgRttMs: number | null = null;
  const rtt = out.match(
    /(?:rtt|round-trip)\s+min\/avg\/max\/(?:mdev|stddev)\s*=\s*[\d.]+\/([\d.]+)\//i,
  );
  if (rtt) {
    const v = Number(rtt[1]);
    if (Number.isFinite(v)) avgRttMs = v;
  }
  return { transmitted, received, avgRttMs };
}

// Classify a ping failure (no usable summary) into a typed reason.
export function classifyPingFailure(stderr: string, code: number | null): string {
  const s = stderr.toLowerCase();
  if (
    s.includes("operation not permitted") ||
    s.includes("socket: permission denied") ||
    s.includes("must be superuser") ||
    s.includes("cap_net_raw")
  ) {
    return "icmp_privilege_denied";
  }
  if (
    s.includes("name or service not known") ||
    s.includes("cannot resolve") ||
    s.includes("unknown host") ||
    s.includes("no address associated")
  ) {
    return "icmp_dns_failed";
  }
  if (s.includes("not found") || code === 127) {
    return "icmp_unavailable";
  }
  return "icmp_error";
}

function runPing(
  host: string,
  count: number,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null; spawnError?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ping", buildPingArgs(host, count, timeoutMs), {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ stdout: "", stderr: (e as Error).message, code: 127, spawnError: (e as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    // Hard wall-clock kill: count * per-ping timeout + 2s slack.
    const wall = count * timeoutMs + 2_000;
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, wall);
    child.on("error", (e) => {
      clearTimeout(killer);
      const msg = (e as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : e.message;
      resolve({ stdout, stderr: stderr + msg, code: 127, spawnError: msg });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, code });
    });
  });
}

export async function execute(config: IcmpConfig): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();
  const count = config.count ?? 3;
  const timeoutMs = config.timeout_ms ?? 1_000;
  const interpretation = config.interpretation ?? "latency";

  const { stdout, stderr, code, spawnError } = await runPing(config.host, count, timeoutMs);

  const parsed = parsePingOutput(stdout);
  if (!parsed) {
    // No summary line (spawn failure, missing binary, privilege denied,
    // DNS failure, or a generic error). Classify from stderr / exit code.
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: classifyPingFailure(stderr, spawnError !== undefined ? (code ?? 127) : code),
      metadata: { host: config.host, interpretation },
    };
  }

  const { transmitted, received, avgRttMs } = parsed;
  // Clamp to [0,100]: malformed ping output (received > transmitted)
  // would otherwise yield a negative loss percentage.
  const rawLoss = transmitted > 0 ? ((transmitted - received) / transmitted) * 100 : 100;
  const lossPct = Math.max(0, Math.min(100, rawLoss));
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const metadata = {
    host: config.host,
    interpretation,
    transmitted,
    received,
    packet_loss_pct: round1(lossPct),
    avg_rtt_ms: avgRttMs,
  };

  if (interpretation === "reachability") {
    return { value: received > 0 ? 1 : 0, timestamp: ts(), metadata };
  }
  if (interpretation === "packet_loss") {
    return { value: round1(lossPct), timestamp: ts(), metadata };
  }
  // latency: no successful pings → no_data (can't average nothing).
  if (received === 0 || avgRttMs === null) {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "icmp_all_timeout", metadata };
  }
  return { value: avgRttMs, timestamp: ts(), metadata };
}

const source: ProbeSource<IcmpConfig> = { execute, validateConfig };
export default source;
