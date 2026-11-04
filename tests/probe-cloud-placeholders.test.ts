// datadog / gcp_monitoring / azure_monitor are registered but not
// implemented yet: they validate their config and report a typed no_data.
import { describe, expect, it } from "bun:test";
import { execute, getSource } from "../src/sources/index.ts";

const CASES = [
  { type: "datadog", config: { query: "avg:system.cpu.user{*}" }, reason: "datadog_not_implemented" },
  { type: "gcp_monitoring", config: { project_id: "my-project-1", query: "up" }, reason: "gcp_monitoring_not_implemented" },
  {
    type: "azure_monitor",
    config: {
      resource_id: "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Web/sites/app",
      metric_name: "Http5xx",
      auth_mode: "managed_identity",
    },
    reason: "azure_monitor_not_implemented",
  },
] as const;

describe("cloud metric source placeholders", () => {
  for (const c of CASES) {
    it(`${c.type}: validates config and reports ${c.reason}`, async () => {
      const src = getSource(c.type);
      expect(src).toBeDefined();
      expect(src!.validateConfig(c.config)).toBeNull();
      expect(src!.validateConfig({ ...c.config, unknown_field: 1 })).not.toBeNull();
      const r = await execute({ id: "m1", source_type: c.type, source_config: c.config } as never);
      expect(r.value).toBeNull();
      expect(r.status_hint).toBe("no_data");
      expect(r.reason).toBe(c.reason);
    });
  }
});
