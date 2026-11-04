// _secret-value.ts: an env-var ref's value is inline content or a file path.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecretValue } from "../src/sources/_secret-value.ts";

const isJson = (raw: string) => raw.trimStart().startsWith("{");

describe("readSecretValue", () => {
  it("unset or empty refs are missing", () => {
    expect(readSecretValue("NOPE", {}, isJson)).toEqual({ ok: false, failure: "missing" });
    expect(readSecretValue("EMPTY", { EMPTY: "" }, isJson)).toEqual({ ok: false, failure: "missing" });
  });

  it("inline content is returned as is", () => {
    expect(readSecretValue("KEY", { KEY: '{"a":1}' }, isJson)).toEqual({ ok: true, value: '{"a":1}', source: "inline" });
  });

  it("anything else is read as a file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-value-"));
    const file = join(dir, "key.json");
    writeFileSync(file, '{"b":2}');
    expect(readSecretValue("KEY", { KEY: file }, isJson)).toEqual({ ok: true, value: '{"b":2}', source: "file" });
  });

  it("an unreadable path is unreadable, and the path never leaks", () => {
    const r = readSecretValue("KEY", { KEY: "/definitely/not/here" }, isJson);
    expect(r).toEqual({ ok: false, failure: "unreadable" });
    expect(JSON.stringify(r)).not.toContain("/definitely");
  });

  it("uses the injected reader", () => {
    const seen: string[] = [];
    const r = readSecretValue("KEY", { KEY: "/mnt/key" }, isJson, (p) => {
      seen.push(p);
      return "from-seam";
    });
    expect(seen).toEqual(["/mnt/key"]);
    expect(r).toEqual({ ok: true, value: "from-seam", source: "file" });
  });
});
