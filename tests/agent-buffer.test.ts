import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuffer } from "../src/buffer";

let tmpDir;
let bufferPath;
let buf;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "obs-buffer-test-"));
  bufferPath = join(tmpDir, "buffer.db");
});

afterEach(() => {
  try {
    if (buf) buf.close();
  } catch {
    /* already closed */
  }
  buf = null;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("agent buffer", () => {
  it("enqueue grows size; size() reflects pending count", () => {
    buf = createBuffer(bufferPath);
    expect(buf.size()).toBe(0);
    buf.enqueue({ metric_id: "m1", value: 1 });
    buf.enqueue({ metric_id: "m1", value: 2 });
    expect(buf.size()).toBe(2);
  });

  it("cloud-down scenario: 100 unsent enqueues persist; oldestAgeSeconds non-negative", () => {
    buf = createBuffer(bufferPath);
    for (let i = 0; i < 100; i++) {
      buf.enqueue({ metric_id: "m1", value: i });
    }
    expect(buf.size()).toBe(100);
    expect(buf.oldestAgeSeconds()).toBeGreaterThanOrEqual(0);

    // Pull a batch but don't ack — simulating cloud unreachable.
    let drained = 0;
    for (const batch of buf.batches(20)) {
      drained += batch.length;
      break;
    }
    expect(drained).toBe(20);
    expect(buf.size()).toBe(100);
  });

  it("ack removes rows; full drain empties the buffer", () => {
    buf = createBuffer(bufferPath);
    for (let i = 0; i < 30; i++) {
      buf.enqueue({ metric_id: "m1", value: i });
    }
    for (const batch of buf.batches(10)) {
      for (const row of batch) buf.ack(row.id);
    }
    expect(buf.size()).toBe(0);
    expect(buf.oldestAgeSeconds()).toBe(0);
  });

  it("evicts oldest when above MAX_ROWS cap", () => {
    buf = createBuffer(bufferPath, { maxRows: 5 });
    expect(buf.MAX_ROWS).toBe(5);

    let lastResult;
    for (let i = 0; i < 8; i++) {
      lastResult = buf.enqueue({ seq: i });
    }
    expect(buf.size()).toBe(5);
    expect(lastResult.dropped).toBeGreaterThan(0);

    // Read one batch only — the generator loops until ack drains it.
    const { value: rows } = buf.batches(10).next();
    const seqs = rows.map((r) => JSON.parse(r.payload).seq);
    expect(seqs).toEqual([3, 4, 5, 6, 7]);
  });

  it("payloads survive a close + reopen with the same path", () => {
    buf = createBuffer(bufferPath);
    buf.enqueue({ metric_id: "m1", value: 42 });
    buf.close();
    buf = null;

    const buf2 = createBuffer(bufferPath);
    expect(buf2.size()).toBe(1);
    const { value: rows } = buf2.batches(10).next();
    expect(JSON.parse(rows[0].payload)).toEqual({ metric_id: "m1", value: 42 });
    buf2.close();
  });

  it("size returns 0 and oldestAgeSeconds returns 0 on empty buffer", () => {
    buf = createBuffer(bufferPath);
    expect(buf.size()).toBe(0);
    expect(buf.oldestAgeSeconds()).toBe(0);
  });
});

describe("corrupt buffer file recovery", () => {
  it("quarantines a garbage (non-SQLite) file and recreates an empty working buffer", () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(bufferPath, "this is not a sqlite database, just garbage bytes ".repeat(4));
      buf = createBuffer(bufferPath);

      // Recovered: empty buffer, fully functional.
      expect(buf.size()).toBe(0);
      expect(buf.enqueue({ metric_id: "m1", value: 1 })).toEqual({ dropped: 0, size: 1 });
      const { value: rows } = buf.batches(10).next();
      expect(JSON.parse(rows[0].payload)).toEqual({ metric_id: "m1", value: 1 });

      // The corrupt original was moved aside, not deleted.
      const quarantined = readdirSync(tmpDir).filter((f) => /^buffer\.db\.corrupt-\d+$/.test(f));
      expect(quarantined.length).toBe(1);

      // Loud error was logged.
      expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(String(errSpy.mock.calls[0][0])).toContain("corrupt");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("recovered buffer persists across close + reopen", () => {
    writeFileSync(bufferPath, "garbage garbage garbage garbage garbage garbage!");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      buf = createBuffer(bufferPath);
    } finally {
      errSpy.mockRestore();
    }
    buf.enqueue({ metric_id: "m1", value: 7 });
    buf.close();
    buf = createBuffer(bufferPath);
    expect(buf.size()).toBe(1);
  });
});

describe("post-close behavior", () => {
  it("close() is idempotent; post-close calls no-op instead of resurrecting the DB", () => {
    buf = createBuffer(bufferPath);
    buf.enqueue({ metric_id: "m1" });
    buf.close();
    buf.close(); // idempotent — must not throw

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // enqueue drops instead of reopening; warns once only.
      expect(buf.enqueue({ metric_id: "m2" })).toEqual({ dropped: 1, size: 0 });
      expect(buf.enqueue({ metric_id: "m3" })).toEqual({ dropped: 1, size: 0 });
      expect(warnSpy.mock.calls.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }

    expect(buf.size()).toBe(0);
    expect(buf.oldestAgeSeconds()).toBe(0);
    expect(buf.batches(10).next().done).toBe(true);
    buf.ack(1); // no-op, must not throw
  });
});
