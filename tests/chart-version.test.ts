// The Helm chart (charts/observer-agent) tracks the agent it ships:
// appVersion is the agent version, and the image annotation Artifact Hub reads
// names the same tag. An agent release bumps appVersion and the chart's patch
// version in the same commit (mirror-release skill). The chart's health probe
// is the runtime contract's healthExec, verbatim (compat C5).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_RUNTIME, compareAgentVersions } from "@observer/protocol";

const AGENT = join(import.meta.dir, "..");
const CHART = join(AGENT, "charts", "observer-agent");
const pkg = JSON.parse(readFileSync(join(AGENT, "package.json"), "utf8")) as { version: string };
const chart = Bun.YAML.parse(readFileSync(join(CHART, "Chart.yaml"), "utf8")) as {
  version: string;
  appVersion: string;
  annotations: Record<string, string>;
};

// Between releases package.json reads "X.Y.Z-dev": the chart keeps pointing at
// the last released image (which exists) until the release commit bumps both.
const inDevelopment = /-dev$/.test(pkg.version);

describe("Helm chart version", () => {
  it("appVersion equals the agent version in package.json (or the last release, during -dev)", () => {
    if (inDevelopment) {
      expect(chart.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(compareAgentVersions(chart.appVersion, pkg.version.replace(/-dev$/, ""))).toBe(-1);
    } else {
      expect(chart.appVersion).toBe(pkg.version);
    }
  });

  it("chart version is plain semver", () => {
    expect(chart.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("the Artifact Hub image annotation names the appVersion tag", () => {
    const images = Bun.YAML.parse(chart.annotations["artifacthub.io/images"]) as { image: string }[];
    expect(images.map((i) => i.image)).toEqual([`${AGENT_RUNTIME.image}:${chart.appVersion}`]);
  });

  it("the probes run AGENT_RUNTIME.healthExec", () => {
    const helpers = readFileSync(join(CHART, "templates", "_helpers.tpl"), "utf8");
    expect(helpers).toContain(JSON.stringify(AGENT_RUNTIME.healthExec));
  });
});
