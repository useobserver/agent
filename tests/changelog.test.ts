// Every agent version has human-written release notes: the public release
// workflow publishes this version's CHANGELOG.md section as the GitHub
// release body and fails without one.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

describe("CHANGELOG.md", () => {
  it(`has a non-empty section for the current version (${version})`, () => {
    const re = new RegExp(`^## ${version.replace(/\./g, "\\.")}(?: |$)[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m");
    const m = re.exec(changelog);
    expect(m, `add a "## ${version} (YYYY-MM-DD)" section`).not.toBeNull();
    expect(m![1].trim().length).toBeGreaterThan(0);
  });
  it("keeps an Unreleased section on top for the next release", () => {
    expect(changelog).toMatch(/^## Unreleased\s*$/m);
  });
});
