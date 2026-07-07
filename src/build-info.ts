// Build provenance for the heartbeat (agent 1.5.0+).
//
// Two channels:
//   - "official": the public image CI writes build-info.json next to the
//     package root at build time ({version, commit, channel, source_hash}).
//     The source hash is computed by the SAME algorithm below over the
//     vendored src/ tree, so cloud-side comparison against the published
//     per-release hash detects a patched image.
//   - "source": no build-info.json → running from a checkout. The hash is
//     computed live at boot over src/.
//
// This is self-reported telemetry, not a security boundary — the agent is
// open source and a fork can send anything. It exists so the dashboard can
// tell honest operators "official vX.Y.Z", "source run", or "modified
// build" and surface out-of-date versions.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentBuildInfo } from "@observer/protocol";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src
const PKG_ROOT = join(HERE, "..");

/**
 * Deterministic hash of a source tree: sha256 over each file's relative
 * POSIX path + NUL + contents, files visited in sorted path order. Only
 * .ts/.js/.json files count so editor droppings and .DS_Store noise never
 * change the hash. Mirrored by tools/mirror-agent (official image CI) —
 * change both together or every official build reports "modified".
 */
export function computeSourceHash(rootDir: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(ts|js|json)$/.test(entry)) files.push(full);
    }
  };
  walk(rootDir);
  const h = createHash("sha256");
  for (const f of files.sort()) {
    h.update(relative(rootDir, f).split("\\").join("/"));
    h.update("\0");
    h.update(readFileSync(f));
  }
  return h.digest("hex");
}

let cached: AgentBuildInfo | null = null;

export function getBuildInfo(): AgentBuildInfo {
  if (cached) return cached;
  try {
    const baked = join(PKG_ROOT, "build-info.json");
    if (existsSync(baked)) {
      const parsed = JSON.parse(readFileSync(baked, "utf8"));
      if (parsed?.channel === "official" && typeof parsed?.source_hash === "string") {
        cached = {
          channel: "official",
          commit: typeof parsed.commit === "string" ? parsed.commit : null,
          source_hash: parsed.source_hash,
        };
        return cached;
      }
    }
  } catch {
    // fall through to source computation
  }
  try {
    cached = { channel: "source", commit: null, source_hash: computeSourceHash(join(PKG_ROOT, "src")) };
  } catch {
    cached = { channel: "source", commit: null, source_hash: "unavailable" };
  }
  return cached;
}
