// The container image must keep the SQLite buffer on the /data volume every
// install snippet mounts; with the old ./observer-agent-buffer.db default it
// lived in /app and a recreated container lost every queued sample. Reads
// the Dockerfile + docker-compose.yml next to src/ (apps/agent in the
// monorepo, the repo root in the public mirror).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { relayQueuePath, resolveRelayConfig } from "../src/heartbeat-relay";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("container buffer path", () => {
  const dockerfile = read("../Dockerfile");

  it("image sets BUFFER_PATH under /data in the runtime stage", () => {
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM "));
    expect(runtime).toMatch(/^ENV BUFFER_PATH=\/data\/observer-agent-buffer\.db$/m);
  });

  it("image creates /data (distroless has no shell) and copies it into the runtime stage", () => {
    expect(dockerfile).toMatch(/^RUN mkdir -p \/data\b/m);
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM "));
    expect(runtime).toMatch(/^COPY --from=builder (--chown=\S+ )?\/data \/data$/m);
  });

  it("docker-compose.yml mounts a volume on /data", () => {
    expect(read("../docker-compose.yml")).toMatch(/^\s+- observer-agent-buffer:\/data$/m);
  });

  it("the heartbeat relay queue follows BUFFER_PATH onto the volume", () => {
    expect(relayQueuePath("/data/observer-agent-buffer.db")).toBe("/data/observer-agent-buffer-relay.db");
    expect(resolveRelayConfig({ BUFFER_PATH: "/data/observer-agent-buffer.db" }).queuePath).toBe(
      "/data/observer-agent-buffer-relay.db",
    );
  });

  it("non-container runs keep the binary default", () => {
    expect(relayQueuePath(undefined)).toBe("./observer-agent-buffer-relay.db");
    expect(readFileSync(new URL("../src/buffer.ts", import.meta.url), "utf8")).toContain(
      'process.env.BUFFER_PATH || "./observer-agent-buffer.db"',
    );
  });
});
