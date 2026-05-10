import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
