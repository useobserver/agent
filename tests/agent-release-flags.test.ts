// The release workflow's pre-release flags (agent-release.yml): a stable tag
// agent-vX.Y.Z is a normal release and becomes releases/latest, which
// install.sh and the console's binary snippets download; an rc tag
// agent-vX.Y.Z-rc.N is a pre-release and never becomes latest.
//
// Regression: the flags once tested github.ref_name for a hyphen, and the
// "agent-" prefix always has one, so 1.8.0 and 1.8.1 shipped as pre-releases
// and releases/latest stayed on 1.7.3.
//
// Monorepo: tools/mirror-agent/templates/agent-release.yml. Public repo: the
// same file installed by hand at .github/workflows/agent-release.yml.
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const candidates = [
  join(import.meta.dir, "..", "..", "..", "tools", "mirror-agent", "templates", "agent-release.yml"),
  join(import.meta.dir, "..", ".github", "workflows", "agent-release.yml"),
];
const file = candidates.find((p) => existsSync(p));

type Step = { id?: string; uses?: string; run?: string; with?: Record<string, string> };

function releaseStep(): Step {
  const wf = Bun.YAML.parse(readFileSync(file!, "utf8")) as { jobs: Record<string, { steps: Step[] }> };
  const step = Object.values(wf.jobs)
    .flatMap((j) => j.steps)
    .find((s) => s.uses?.startsWith("softprops/action-gh-release"));
  if (!step?.with) throw new Error("agent-release.yml: release step not found");
  return step;
}

// Evaluates the two expression shapes the flags use, for a pushed tag:
//   ${{ contains(<ctx>, '-') }}
//   ${{ contains(<ctx>, '-') && 'false' || 'true' }}
// <ctx> is github.ref_name (the full tag) or steps.version.outputs.tag (the
// tag minus "agent-v", as the `version` step writes it).
function evaluate(expr: string, tag: string): string {
  const m = /^\$\{\{\s*contains\(([\w.]+),\s*'-'\)\s*(&&\s*'(\w+)'\s*\|\|\s*'(\w+)'\s*)?\}\}$/.exec(String(expr).trim());
  if (!m) throw new Error(`unrecognised expression: ${expr}`);
  const ctx: Record<string, string> = {
    "github.ref_name": tag,
    "steps.version.outputs.tag": tag.replace(/^agent-v/, ""),
  };
  if (!(m[1] in ctx)) throw new Error(`unknown context ${m[1]}`);
  const hit = ctx[m[1]].includes("-");
  return m[2] ? (hit ? m[3] : m[4]) : String(hit);
}

describe.skipIf(!file)("agent-release.yml pre-release flags", () => {
  const { with: w } = releaseStep();

  it("a stable tag is a normal release and becomes latest", () => {
    for (const tag of ["agent-v1.8.1", "agent-v2.0.0"]) {
      expect(evaluate(w!.prerelease, tag)).toBe("false");
      expect(evaluate(w!.make_latest, tag)).toBe("true");
    }
  });

  it("an rc tag is a pre-release and never becomes latest", () => {
    for (const tag of ["agent-v1.9.0-rc.1", "agent-v2.0.0-beta.2"]) {
      expect(evaluate(w!.prerelease, tag)).toBe("true");
      expect(evaluate(w!.make_latest, tag)).toBe("false");
    }
  });
});
