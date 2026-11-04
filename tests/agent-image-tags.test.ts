// The image workflow's tag rules (agent-image.yml): only a stable tag
// agent-vX.Y.Z moves X, X.Y and latest; a prerelease agent-vX.Y.Z-rc.N
// publishes only X.Y.Z-rc.N (and sha-*). PaaS templates and the compose file
// pin :1, so an unanchored pattern would ship a release candidate to them.
//
// Monorepo: tools/mirror-agent/templates/agent-image.yml. Public repo: the
// same file installed by hand at .github/workflows/agent-image.yml.
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const candidates = [
  join(import.meta.dir, "..", "..", "..", "tools", "mirror-agent", "templates", "agent-image.yml"),
  join(import.meta.dir, "..", ".github", "workflows", "agent-image.yml"),
];
const file = candidates.find((p) => existsSync(p));

type Step = { id?: string; name?: string; run?: string; with?: Record<string, string> };

function load() {
  const wf = Bun.YAML.parse(readFileSync(file!, "utf8")) as { jobs: Record<string, { steps: Step[] }> };
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps);
  const classify = steps.find((s) => s.id === "tag");
  const meta = steps.find((s) => s.id === "meta");
  if (!classify?.run || !meta?.with?.tags) throw new Error("agent-image.yml: steps `tag` and `meta` not found");
  const rules = meta.with.tags
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [type, ...rest] = line.split(",");
      const opts = Object.fromEntries(
        rest.map((kv) => {
          const i = kv.indexOf("=");
          return [kv.slice(0, i), kv.slice(i + 1)];
        }),
      );
      return { type: type.replace(/^type=/, ""), ...opts } as Record<string, string>;
    });
  // The classify step's bash regex, applied to refs/tags/<tag>.
  const bash = /=~\s*(\^refs\/tags\/\S+\$)/.exec(classify.run)?.[1];
  if (!bash) throw new Error("agent-image.yml: no tag regex in the classify step");
  return { rules, stableRe: new RegExp(bash.replace(/\[0-9\]/g, "\\d")) };
}

/** Image tags the metadata step emits for a git tag, as the workflow is written. */
function tagsFor(gitTag: string): string[] {
  const { rules, stableRe } = load();
  const stable = stableRe.test(`refs/tags/${gitTag}`);
  const enabled = (r: Record<string, string>) =>
    r.enable === undefined || (r.enable.includes("steps.tag.outputs.stable == 'true'") ? stable : (() => {
      throw new Error(`unrecognised enable expression: ${r.enable}`);
    })());
  const out: string[] = [];
  for (const r of rules) {
    if (!enabled(r)) continue;
    if (r.type === "match") {
      const m = new RegExp(r.pattern).exec(gitTag);
      if (m) out.push(m[Number(r.group ?? 0)]);
    } else if (r.type === "raw") {
      out.push(r.value);
    }
  }
  return out;
}

describe.skipIf(!file)("agent image tag rules", () => {
  it("every match pattern is anchored at both ends", () => {
    const { rules } = load();
    const matches = rules.filter((r) => r.type === "match");
    expect(matches.length).toBeGreaterThan(0);
    for (const r of matches) {
      expect(r.pattern.startsWith("^"), r.pattern).toBe(true);
      expect(r.pattern.endsWith("$"), r.pattern).toBe(true);
    }
  });

  it("a stable tag publishes X.Y.Z, X.Y, X and latest", () => {
    expect(tagsFor("agent-v1.7.3").sort()).toEqual(["1", "1.7", "1.7.3", "latest"]);
    expect(tagsFor("agent-v2.10.0").sort()).toEqual(["2", "2.10", "2.10.0", "latest"]);
  });

  it("a prerelease publishes only its own version", () => {
    expect(tagsFor("agent-v2.0.0-rc.1")).toEqual(["2.0.0-rc.1"]);
    expect(tagsFor("agent-v1.8.0-beta.2")).toEqual(["1.8.0-beta.2"]);
  });

  it("anything else publishes no version tag", () => {
    for (const t of ["agent-v1.7", "agent-v1", "agent-v1.7.3.1", "xagent-v1.7.3", "agent-v1.7.3 ", "cli-v1.2.3"]) {
      expect(tagsFor(t), t).toEqual([]);
    }
  });
});
