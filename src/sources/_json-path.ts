// JSON path extraction helper. Re-exports from
// @observer/probe-config so the agent and the cloud-side
// /api/agent/test-json-path route share one implementation
// of the extraction + coercion contract.

export {
  extractByJsonPath,
  parseAndExtract,
  type ExtractError,
  type ExtractResult,
  type ExtractFailure,
} from "@observer/probe-config";
