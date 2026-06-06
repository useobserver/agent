// Host-metrics source — the agent PRODUCES host vitals so a
// fresh deploy gives instant signal with no external source configured.
//
// Linux is first-class (read from /proc + node:fs statfs). On other
// platforms we fall back to the `os` module where it's meaningful and
// otherwise return no_data with a typed reason rather than a wrong
// number — the cloud renders the agent verdict as truth.
//
// CPU and network are rate/utilisation metrics that need two samples;
// execute() takes the delta inline (short sleep) since this is a
// pull-mode probe with no persistent state. source_config carries NO
// endpoint or credentials — it always reads the local host.

import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import type { ProbeResult, ProbeSource } from "../types.ts";
import { HostConfigSchema, type HostConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(HostConfigSchema, config);
}

const isLinux = process.platform === "linux";
const ts = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const round = (n: number, dp = 1): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
function noData(reason: string, metadata?: Record<string, unknown>): ProbeResult {
  return { value: null, timestamp: ts(), status_hint: "no_data", reason, metadata };
}

// --- CPU: aggregate /proc/stat cpu line, delta busy/total over a window ---
async function readCpuTotals(): Promise<{ idle: number; total: number } | null> {
  const txt = await readFile("/proc/stat", "utf8");
  const line = txt.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number); // user nice system idle iowait irq softirq steal...
  if (parts.length < 4) return null;
  const idle = (parts[3] || 0) + (parts[4] || 0); // idle + iowait
  const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { idle, total };
}
async function cpuPct(): Promise<number | null> {
  if (isLinux) {
    const a = await readCpuTotals();
    if (!a) return null;
    await sleep(200);
    const b = await readCpuTotals();
    if (!b) return null;
    const dt = b.total - a.total;
    const di = b.idle - a.idle;
    if (dt <= 0) return null;
    return Math.max(0, Math.min(100, (1 - di / dt) * 100));
  }
  // Fallback: os.cpus() times delta (works on macOS; Windows is coarse).
  const a = os.cpus();
  await sleep(200);
  const c = os.cpus();
  if (!a.length || a.length !== c.length) return null;
  let idle = 0;
  let total = 0;
  for (let i = 0; i < c.length; i++) {
    const ta = a[i].times;
    const tb = c[i].times;
    idle += tb.idle - ta.idle;
    total +=
      tb.user - ta.user + (tb.nice - ta.nice) + (tb.sys - ta.sys) + (tb.idle - ta.idle) + (tb.irq - ta.irq);
  }
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

// --- Memory: used % (MemAvailable on Linux; os fallback elsewhere) ---
async function memPct(): Promise<number | null> {
  if (isLinux) {
    try {
      const txt = await readFile("/proc/meminfo", "utf8");
      const get = (k: string): number | null => {
        const m = txt.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"));
        return m ? Number(m[1]) : null;
      };
      const total = get("MemTotal");
      const avail = get("MemAvailable");
      if (total && avail != null && total > 0) {
        return Math.max(0, Math.min(100, (1 - avail / total) * 100));
      }
    } catch {
      /* fall through to os */
    }
  }
  const total = os.totalmem();
  const free = os.freemem();
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, (1 - free / total) * 100));
}

// --- Filesystem: used % for a mountpoint (statfs, cross-platform) ---
async function fsPct(mountpoint: string): Promise<number | null> {
  try {
    const s = await statfs(mountpoint);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize); // available to unprivileged
    if (total <= 0) return null;
    return Math.max(0, Math.min(100, (1 - free / total) * 100));
  } catch {
    return null;
  }
}

// --- Network: bytes/sec across iface(s) from /proc/net/dev (Linux only) ---
async function readNetBytes(iface?: string): Promise<{ rx: number; tx: number } | null> {
  const txt = await readFile("/proc/net/dev", "utf8");
  let rx = 0;
  let tx = 0;
  let found = false;
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    const name = m[1].trim();
    if (name === "lo") continue;
    if (iface && name !== iface) continue;
    const f = m[2].trim().split(/\s+/).map(Number); // rx bytes ... (idx0), tx bytes (idx8)
    rx += f[0] || 0;
    tx += f[8] || 0;
    found = true;
  }
  return found ? { rx, tx } : null;
}
async function netBytesPerSec(iface?: string): Promise<number | null> {
  if (!isLinux) return null;
  const a = await readNetBytes(iface);
  if (!a) return null;
  await sleep(500);
  const b = await readNetBytes(iface);
  if (!b) return null;
  const bytes = (b.rx - a.rx + (b.tx - a.tx)) / 0.5;
  return Math.max(0, bytes);
}

export async function execute(config: HostConfig): Promise<ProbeResult> {
  const metric = config.metric;
  try {
    switch (metric) {
      case "cpu": {
        const v = await cpuPct();
        return v == null ? noData("host_cpu_unavailable", { metric }) : { value: round(v), timestamp: ts(), metadata: { metric } };
      }
      case "memory": {
        const v = await memPct();
        return v == null ? noData("host_memory_unavailable", { metric }) : { value: round(v), timestamp: ts(), metadata: { metric } };
      }
      case "filesystem": {
        const v = await fsPct(config.mountpoint);
        return v == null
          ? noData("host_filesystem_unavailable", { metric, mountpoint: config.mountpoint })
          : { value: round(v), timestamp: ts(), metadata: { metric, mountpoint: config.mountpoint } };
      }
      case "network": {
        if (!isLinux) return noData("host_metric_unsupported_platform", { metric, platform: process.platform });
        const v = await netBytesPerSec(config.iface);
        return v == null
          ? noData("host_network_unavailable", { metric, iface: config.iface ?? null })
          : { value: Math.round(v), timestamp: ts(), metadata: { metric, iface: config.iface ?? null } };
      }
      case "load": {
        const la = os.loadavg()[0];
        const n = os.cpus().length || 1;
        // Windows reports [0,0,0] for loadavg — treat as unsupported there.
        if (!Number.isFinite(la) || (la === 0 && process.platform === "win32")) {
          return noData("host_metric_unsupported_platform", { metric, platform: process.platform });
        }
        return { value: round(la / n, 2), timestamp: ts(), metadata: { metric, loadavg_1m: la, ncpu: n } };
      }
      default:
        return noData("host_unknown_metric", { metric });
    }
  } catch (e) {
    return noData("host_read_error", { metric, error: (e as Error).message });
  }
}

const source: ProbeSource<HostConfig> = { execute, validateConfig };
export default source;
