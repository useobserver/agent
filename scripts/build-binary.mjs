#!/usr/bin/env bun
// Observer agent — Bun single-binary build script.
//
// Bun's `--compile` flag bundles the entry point + every imported
// module (including the workspace packages @observer/protocol and
// @observer/probe-config) into a standalone executable that ships the
// Bun runtime alongside the JS. No `bun install` needed on the target
// host. See https://bun.com/docs/bundler/executables.
//
// Targets:
//   bun-linux-x64
//   bun-linux-arm64
//   bun-darwin-x64
//   bun-darwin-arm64
//   bun-windows-x64
//
// Usage:
//   bun run build:binary             # current host only (auto-detect)
//   bun run build:binary --target X  # specific target (e.g. bun-linux-arm64)
//   bun run build:binaries           # all five targets
//
// Output: apps/agent/dist/observer-agent-<os>-<arch>[.exe]
//
// Runtime flags can be forwarded to the embedded Bun runtime via the
// BUN_OPTIONS env var on the target host (see Bun docs link above).

import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = resolve(HERE, "..");
const ENTRY = resolve(AGENT_ROOT, "src/index.ts");
const DIST = resolve(AGENT_ROOT, "dist");

const TARGETS = [
  { target: "bun-linux-x64",     out: "observer-agent-linux-x64" },
  { target: "bun-linux-arm64",   out: "observer-agent-linux-arm64" },
  { target: "bun-darwin-x64",    out: "observer-agent-darwin-x64" },
  { target: "bun-darwin-arm64",  out: "observer-agent-darwin-arm64" },
  { target: "bun-windows-x64",   out: "observer-agent-windows-x64.exe" },
];

function detectHostTarget() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "linux" && arch === "x64") return "bun-linux-x64";
  if (platform === "linux" && arch === "arm64") return "bun-linux-arm64";
  if (platform === "darwin" && arch === "x64") return "bun-darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "bun-darwin-arm64";
  if (platform === "win32" && arch === "x64") return "bun-windows-x64";
  throw new Error(`Unsupported host: ${platform}/${arch}`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { all: false, target: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--all") flags.all = true;
    else if (args[i] === "--target") flags.target = args[++i];
  }
  return flags;
}

async function buildOne(target, outFilename) {
  const outPath = join(DIST, outFilename);
  console.log(`▸ ${target} → ${outFilename}`);
  const args = [
    "build",
    "--compile",
    "--minify",
    "--sourcemap=none",
    `--target=${target}`,
    ENTRY,
    `--outfile=${outPath}`,
  ];
  const proc = Bun.spawn(["bun", ...args], {
    cwd: AGENT_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`bun build exited ${code} for ${target}`);
  const size = statSync(outPath).size;
  console.log(`  ✓ ${(size / 1024 / 1024).toFixed(1)} MiB`);
}

async function main() {
  const flags = parseArgs(process.argv);
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  let queue = TARGETS;
  if (!flags.all) {
    const wanted = flags.target ?? detectHostTarget();
    queue = TARGETS.filter((t) => t.target === wanted);
    if (queue.length === 0) {
      console.error(`Unknown target: ${wanted}`);
      console.error(`Valid: ${TARGETS.map((t) => t.target).join(", ")}`);
      process.exit(2);
    }
  }

  for (const t of queue) {
    await buildOne(t.target, t.out);
  }

  console.log(`\nDone. Artifacts in ${DIST}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
