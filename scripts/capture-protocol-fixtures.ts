// Records what real agents send the cloud (compat C4), for every published
// agent version from MIN_SUPPORTED_AGENT_VERSION up. Downloads each release
// binary for this platform from github.com/useobserver/agent (checksum-verified),
// runs it against a local capture server that answers like the cloud, and
// writes the first request per endpoint to
// packages/protocol/fixtures/agent-<version>/<endpoint>.json.
// apps/web/tests/compat-agent-protocol.test.ts replays them against the real
// handlers, so a cloud change that would reject an agent in the field fails CI.
//
//   bun scripts/capture-protocol-fixtures.ts            capture missing versions
//   bun scripts/capture-protocol-fixtures.ts 1.7.3      (re)capture one version
//
// Run it after every agent release (the mirror-release skill says so).

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { $ } from "bun";
import { MIN_SUPPORTED_AGENT_VERSION, compareAgentVersions } from "@observer/protocol";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const FIXTURES = path.join(ROOT, "packages", "protocol", "fixtures");
const CACHE = path.join(ROOT, ".cache", "agent-binaries");
const RUN_SECONDS = 150;
// A key-shaped placeholder; the capture server accepts anything.
const FIXTURE_KEY = "obs_live_fixturefixturefixturefixturefixture0";

const platform = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const asset = `observer-agent-${platform}`;

// Endpoints worth pinning, and the file name each is recorded under.
const ENDPOINTS: Record<string, string> = {
  "POST /api/agent/heartbeat": "heartbeat.json",
  "GET /api/agent/metrics-definitions": "metrics-definitions.json",
  "POST /api/agent/receiver/batch": "receiver-batch.json",
  "GET /api/agent/work/jobs": "work-jobs.json",
};

async function versionsToCapture(): Promise<string[]> {
  const only = process.argv[2];
  if (only) return [only.replace(/^agent-v/, "")];
  const tags = (await $`git tag -l ${"agent-v*"}`.cwd(ROOT).text()).split("\n").filter(Boolean);
  return tags
    .map((t) => t.replace(/^agent-v/, ""))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .filter((v) => (compareAgentVersions(v, MIN_SUPPORTED_AGENT_VERSION) ?? -1) >= 0)
    .filter((v) => !existsSync(path.join(FIXTURES, `agent-${v}`)))
    .sort((a, b) => compareAgentVersions(a, b) ?? 0);
}

async function binaryFor(version: string): Promise<string> {
  const dir = path.join(CACHE, version);
  const bin = path.join(dir, asset);
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const base = `https://github.com/useobserver/agent/releases/download/agent-v${version}`;
  const sums = await (await fetch(`${base}/SHA256SUMS.txt`)).text();
  const want = sums.split("\n").find((l) => l.trim().endsWith(asset))?.split(/\s+/)[0];
  if (!want) throw new Error(`${version}: ${asset} not in SHA256SUMS.txt`);
  const res = await fetch(`${base}/${asset}`);
  if (!res.ok) throw new Error(`${version}: download failed ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) throw new Error(`${version}: checksum mismatch`);
  writeFileSync(bin, bytes);
  chmodSync(bin, 0o755);
  return bin;
}

async function capture(version: string) {
  const bin = await binaryFor(version);
  const seen = new Map<string, unknown>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const key = `${req.method} ${url.pathname}`;
      const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      if (ENDPOINTS[key] && !seen.has(key)) {
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        // Never commit the capturing machine's name.
        if (body && typeof body === "object" && "hostname" in body) (body as Record<string, unknown>).hostname = "fixture-host";
        seen.set(key, {
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          has_agent_key: req.headers.get("agent-key") === FIXTURE_KEY,
          content_type: req.headers.get("content-type"),
          body,
        });
      }
      // Answers in the cloud's response shapes (apps/web/app/api/agent/**).
      if (url.pathname === "/ok") return new Response("ok");
      if (key === "POST /api/agent/heartbeat") return Response.json({ ok: true, definitions_version: "fixture-v1" });
      if (key === "GET /api/agent/metrics-definitions") {
        return Response.json(
          [
            {
              id: "11111111-1111-4111-8111-111111111111",
              source_type: "http",
              source_config: { url: `http://127.0.0.1:${server.port}/ok`, method: "GET", timeout_ms: 2000 },
              query: "",
              interval: 1,
              interval_agent_push: 1,
              healthy_operation: "under",
              healthy_value: 2000,
              unhealthy_operation: "over",
              unhealthy_value: 5000,
            },
          ],
          { headers: { "x-observer-definitions-version": "fixture-v1" } },
        );
      }
      if (key === "POST /api/agent/receiver/batch") {
        const n = Array.isArray(JSON.parse(text || "[]")) ? JSON.parse(text).length : 0;
        return Response.json({ accepted: n, rejected: [] });
      }
      if (key === "GET /api/agent/work/jobs") return Response.json({ jobs: [] });
      return Response.json({ ok: true });
    },
  });

  const work = mkdtempSync(path.join(tmpdir(), `observer-fixture-${version}-`));
  const proc = Bun.spawn([bin], {
    cwd: work,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: work,
      AGENT_KEY: FIXTURE_KEY,
      CLOUD_SERVER_URL: `http://127.0.0.1:${server.port}`,
      BUFFER_PATH: path.join(work, "buffer.db"),
      ENABLE_DEBUG_DASHBOARD: "false",
      OBSERVER_OTLP_DISABLE: "true",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  const deadline = Date.now() + RUN_SECONDS * 1000;
  while (Date.now() < deadline && seen.size < Object.keys(ENDPOINTS).length) await Bun.sleep(1000);
  proc.kill("SIGTERM");
  await proc.exited;
  server.stop(true);
  rmSync(work, { recursive: true, force: true });

  const out = path.join(FIXTURES, `agent-${version}`);
  mkdirSync(out, { recursive: true });
  for (const [key, data] of seen) writeFileSync(path.join(out, ENDPOINTS[key]), JSON.stringify(data, null, 2) + "\n");
  const missing = Object.keys(ENDPOINTS).filter((k) => !seen.has(k));
  console.log(`agent ${version}: captured ${seen.size}/${Object.keys(ENDPOINTS).length}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
}

const versions = await versionsToCapture();
if (!versions.length) console.log(`all versions >= ${MIN_SUPPORTED_AGENT_VERSION} already have fixtures in ${path.relative(ROOT, FIXTURES)}`);
for (const v of versions) await capture(v);
if (existsSync(FIXTURES)) console.log(`fixtures: ${readdirSync(FIXTURES).sort().join(", ")}`);
