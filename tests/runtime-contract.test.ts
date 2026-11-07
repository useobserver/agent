// Compat C5: every env var the agent code reads is declared in
// AGENT_ENV (@observer/protocol agent-runtime.ts), with the same default, and
// every declared agent/prober/source var is still read. The Helm chart, PaaS
// templates, install script and console snippets are generated or tested
// against that manifest, so an undeclared rename here would break them all.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AGENT_ENV } from "@observer/protocol";

const SRC = join(import.meta.dir, "..", "src");

// Files allowed to read env vars by a computed name (a *_ref from the metric
// config, resolved on the agent host). Add a file here only when it reads
// customer-named refs, never for a fixed var name.
const AUDITED_DYNAMIC_READS = new Set([
  "sources/_header-refs.ts",
  // The single gate every cloud-named ref goes through (agent-internal
  // secrets refused, optional OBSERVER_PROBE_SECRET_REFS allowlist).
  "sources/_ref-policy.ts",
  "sources/_mtls.ts",
  "sources/_secret-value.ts",
  "sources/database.ts",
  "sources/loki.ts",
  "sources/elasticsearch.ts",
  // Renders an allow-listed, masked env view on the debug dashboard.
  "dashboard.ts",
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

type Read = { name: string; file: string; default?: string };

function scan(): { reads: Read[]; dynamic: string[] } {
  const reads: Read[] = [];
  const dynamic: string[] = [];
  for (const path of walk(SRC)) {
    const file = relative(SRC, path);
    const src = stripComments(readFileSync(path, "utf8"));
    const consts = new Map<string, string>();
    for (const m of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|(\d[\d_]*))\s*;/g)) {
      consts.set(m[1], m[2] ?? m[3].replaceAll("_", ""));
    }
    // const { A, B = DEFAULT_B } = process.env;
    for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*(?:process|Bun)\.env\b/g)) {
      for (const part of m[1].split(",")) {
        const pm = /^\s*([A-Z][A-Z0-9_]*)\s*(?:=\s*([A-Za-z0-9_"'.:/-]+))?\s*$/.exec(part);
        if (!pm) continue;
        const raw = pm[2];
        const def = raw === undefined ? undefined : /^["']/.test(raw) ? raw.slice(1, -1) : consts.get(raw);
        reads.push({ name: pm[1], file, default: def });
      }
    }
    // process.env.X, Bun.env.X, env.X, env?.X, process.env["X"], with an optional literal fallback.
    const access =
      /(?:\b(?:process|Bun)\.env|\benv\??)(?:\.([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])(\)?\s*(?:\?\?|\|\|)\s*(?:"([^"]*)"|(\d[\d_]*)))?/g;
    for (const m of src.matchAll(access)) {
      // `?? ""` normalises "unset" to an empty string; it is not a default.
      const lit = m[4] || m[5]?.replaceAll("_", "") || undefined;
      reads.push({ name: m[1] ?? m[2], file, default: lit });
    }
    // int(env.X, 32, ...) in the prober config loader.
    for (const m of src.matchAll(/\bint\(\s*env\.([A-Z][A-Z0-9_]*)\s*,\s*([\d_]+)/g)) {
      reads.push({ name: m[1], file, default: m[2].replaceAll("_", "") });
    }
    if (/(?:\b(?:process|Bun)\.env|\benv)\[\s*(?!["'])/.test(src)) dynamic.push(file);
  }
  return { reads, dynamic };
}

const { reads, dynamic } = scan();
const declared = AGENT_ENV.filter((e) => e.scope !== "runtime");

describe("agent runtime contract (AGENT_ENV)", () => {
  it("every env var the agent reads is declared", () => {
    const known = new Set(AGENT_ENV.flatMap((e) => [e.name, ...(e.aliases ?? [])]));
    const undeclared = [...new Set(reads.filter((r) => !known.has(r.name)).map((r) => `${r.name} (${r.file})`))];
    expect(undeclared, "add these to packages/protocol/src/agent-runtime.ts").toEqual([]);
  });

  it("every declared agent, prober and source var is still read", () => {
    const read = new Set(reads.map((r) => r.name));
    const unread = declared.filter((e) => !read.has(e.name) && !e.aliases?.some((a) => read.has(a))).map((e) => e.name);
    expect(unread, "removing an env var breaks deploy templates; deprecate it instead").toEqual([]);
  });

  it("literal defaults in code match the manifest", () => {
    const byName = new Map(AGENT_ENV.map((e) => [e.name, e]));
    const mismatches = reads
      .filter((r) => r.default !== undefined && byName.has(r.name))
      .filter((r) => r.default !== byName.get(r.name)!.default)
      .map((r) => `${r.name} in ${r.file}: code "${r.default}" vs manifest "${byName.get(r.name)!.default}"`);
    expect([...new Set(mismatches)]).toEqual([]);
  });

  it("only audited files read env vars by a computed name", () => {
    expect(dynamic.filter((f) => !AUDITED_DYNAMIC_READS.has(f))).toEqual([]);
  });

  it("names are unique and well formed", () => {
    const names = AGENT_ENV.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});
