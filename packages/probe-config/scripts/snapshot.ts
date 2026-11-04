// Writes snapshots/<type>.schema.json: the JSON Schema of every source_config
// (compat C3). Agents in the field validate with these schemas `.strict()`,
// so `bun run compat` diffs the snapshots against the previous commit and
// fails on changes old agents would reject (scripts/compat/probe-config-rules.ts).
// `.refine()` rules are not representable in JSON Schema and are not covered.
//
//   bun scripts/snapshot.ts              write snapshots/
//   bun scripts/snapshot.ts --check      exit 1 if any snapshot is stale
//   bun scripts/snapshot.ts --out <dir>  write to another directory

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PROBE_TYPES, getConfigSchema } from "../src/index.ts";

export function snapshotFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const type of PROBE_TYPES) {
    const schema = getConfigSchema(type);
    if (!schema) throw new Error(`no schema for ${type}`);
    const js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete js.$schema;
    files.set(`${type}.schema.json`, JSON.stringify(js, null, 2) + "\n");
  }
  return files;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const dir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.resolve(import.meta.dir, "..", "snapshots");
  const files = snapshotFiles();
  if (args.includes("--check")) {
    const stale: string[] = [];
    for (const [name, text] of files) {
      const p = path.join(dir, name);
      if (!existsSync(p) || readFileSync(p, "utf8") !== text) stale.push(name);
    }
    if (existsSync(dir)) for (const name of readdirSync(dir)) if (!files.has(name)) stale.push(`${name} (no such type)`);
    if (stale.length) {
      console.error(`probe-config snapshots are stale: ${stale.join(", ")}. Run: bun run compat:update`);
      process.exit(1);
    }
    console.log("probe-config snapshots are up to date");
  } else {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) if (!files.has(name)) unlinkSync(path.join(dir, name));
    for (const [name, text] of files) writeFileSync(path.join(dir, name), text);
    console.log(`wrote ${files.size} snapshots to ${path.relative(process.cwd(), dir)}`);
  }
}
