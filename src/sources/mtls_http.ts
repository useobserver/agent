// mTLS HTTP probe source — DEPRECATED.
//
// mTLS is now a feature of the `http` source (client_cert_ref /
// client_key_ref / ca_cert_ref). This module stays only so the
// `mtls_http` SourceType union member + DB constraint value keep a
// runtime; it delegates to the http source so any stray mtls_http
// config still probes. The picker no longer offers it.

import type { ProbeResult, ProbeSource } from "../types.ts";
import { MtlsHttpConfigSchema, type MtlsHttpConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";
import httpSource from "./http.ts";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(MtlsHttpConfigSchema, config);
}

export async function execute(config: MtlsHttpConfig): Promise<ProbeResult> {
  // The http runtime reads the same client_cert_ref / client_key_ref
  // fields (now part of httpFields), so delegation is exact.
  return httpSource.execute(config as never);
}

const source: ProbeSource<MtlsHttpConfig> = { execute, validateConfig };
export default source;
