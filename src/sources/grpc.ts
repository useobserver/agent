// gRPC health-check probe source.
//
// Implements the standard gRPC Health Checking Protocol
// (grpc.health.v1.Health/Check) only. Arbitrary method invocation is
// out of scope.
//
// Library: @grpc/grpc-js (pure JS, Bun-compatible — verified against a
// local Health server round-trip). We do NOT take @grpc/proto-loader
// or a .proto file: the two Health messages are trivial protobuf
// (one string field, one enum field), so the wire codec is hand-rolled
// below. That keeps the source self-contained with no runtime file
// dependency that the agent bundler / public-mirror vendoring could
// drop.
//
// mTLS material is loaded via the shared _mtls.ts loader, the
// same path the HTTP source uses — not reimplemented here.
//
// The client is always closed after each probe (no connection leak),
// and the call carries a deadline so a probe can never hang.

import * as grpc from "@grpc/grpc-js";
import type { ProbeResult, ProbeSource } from "../types.ts";
import { GrpcConfigSchema, type GrpcConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";
import { isCertExpiringSoon, loadMtlsMaterial, loadPemRef } from "./_mtls.ts";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(GrpcConfigSchema, config);
}

// ── hand-rolled protobuf wire for grpc.health.v1 ──────────────────
// HealthCheckRequest { string service = 1; }
// HealthCheckResponse { ServingStatus status = 1; }  // enum, varint

function encodeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function decodeVarint(buf: Buffer, start: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = start;
  while (i < buf.length) {
    const byte = buf[i++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, i];
}

function serializeRequest(req: { service?: string }): Buffer {
  const svc = req.service ?? "";
  if (svc.length === 0) return Buffer.alloc(0); // field omitted => default ""
  const body = Buffer.from(svc, "utf8");
  // tag: field 1, wire type 2 (length-delimited) = 0x0a
  return Buffer.concat([Buffer.from([0x0a, ...encodeVarint(body.length)]), body]);
}

function deserializeResponse(buf: Buffer): { status: number } {
  let status = 0;
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i++];
    const fieldNo = tag >> 3;
    const wire = tag & 0x07;
    if (fieldNo === 1 && wire === 0) {
      const [val, next] = decodeVarint(buf, i);
      status = val;
      i = next;
    } else if (wire === 0) {
      i = decodeVarint(buf, i)[1];
    } else if (wire === 2) {
      const [len, next] = decodeVarint(buf, i);
      i = next + len;
    } else {
      break; // unsupported wire type; stop rather than misread
    }
  }
  return { status };
}

const HEALTH_CHECK_PATH = "/grpc.health.v1.Health/Check";
const passthroughBuffer = (b: Buffer): Buffer => b;

const HealthClient = grpc.makeGenericClientConstructor(
  {
    check: {
      path: HEALTH_CHECK_PATH,
      requestStream: false,
      responseStream: false,
      requestSerialize: serializeRequest,
      requestDeserialize: passthroughBuffer, // server-side only; unused on client
      responseSerialize: passthroughBuffer, // server-side only; unused on client
      responseDeserialize: deserializeResponse,
    },
  } as unknown as grpc.ServiceDefinition,
  "Health",
);

// Proto enum: UNKNOWN=0, SERVING=1, NOT_SERVING=2, SERVICE_UNKNOWN=3.
const SERVING = 1;
const NOT_SERVING = 2;
const SERVICE_UNKNOWN = 3;

// Map a gRPC status code (+ details) to a typed reason. TLS handshake
// failures arrive as UNAVAILABLE/INTERNAL with a TLS-ish detail string,
// so sniff the detail first.
function classifyGrpcError(code: number, details: string): string {
  const d = (details || "").toLowerCase();
  if (d.includes("tls") || d.includes("ssl") || d.includes("certificate") || d.includes("handshake")) {
    return "grpc_tls_failed";
  }
  switch (code) {
    case grpc.status.DEADLINE_EXCEEDED:
      return "grpc_timeout";
    case grpc.status.NOT_FOUND:
      return "grpc_service_unknown";
    case grpc.status.UNIMPLEMENTED:
      return "grpc_unimplemented";
    case grpc.status.UNAUTHENTICATED:
      return "grpc_unauthenticated";
    case grpc.status.PERMISSION_DENIED:
      return "grpc_permission_denied";
    case grpc.status.UNAVAILABLE:
      return "grpc_unavailable";
    default:
      return "grpc_error";
  }
}

interface CheckOutcome {
  ok: boolean;
  status?: number; // serving status enum on success
  latencyMs?: number;
  reason?: string;
  detail?: string;
  grpcCode?: number;
}

type CredsResult =
  | { ok: true; creds: grpc.ChannelCredentials; certExpiringSoon?: boolean }
  | { ok: false; reason: string; detail?: string };

function buildCredentials(config: GrpcConfig): CredsResult {
  const mode = config.tls_mode ?? "plaintext";
  if (mode === "plaintext") {
    return { ok: true, creds: grpc.credentials.createInsecure() };
  }

  // Optional private CA for both tls and mtls.
  let caBuf: Buffer | null = null;
  if (config.ca_cert_ref) {
    const caRes = loadPemRef(config.ca_cert_ref, process.env);
    if (!caRes.ok) return { ok: false, reason: "grpc_ca_unreadable", detail: config.ca_cert_ref };
    caBuf = Buffer.from(caRes.pem, "utf8");
  }

  if (mode === "tls") {
    return { ok: true, creds: grpc.credentials.createSsl(caBuf) };
  }

  // mtls — reuse the shared loader; surface its typed mtls_* reasons.
  const mat = loadMtlsMaterial(
    { client_cert_ref: config.client_cert_ref, client_key_ref: config.client_key_ref, ca_cert_ref: config.ca_cert_ref },
    process.env,
  );
  if (!mat.ok) return { ok: false, reason: mat.reason, detail: mat.detail };
  const rootCa = mat.material.ca ? Buffer.from(mat.material.ca, "utf8") : caBuf;
  return {
    ok: true,
    creds: grpc.credentials.createSsl(rootCa, Buffer.from(mat.material.key, "utf8"), Buffer.from(mat.material.cert, "utf8")),
    certExpiringSoon: isCertExpiringSoon(mat.material),
  };
}

function runCheck(config: GrpcConfig, creds: grpc.ChannelCredentials): Promise<CheckOutcome> {
  const timeoutMs = config.timeout_ms ?? 5_000;
  const target = `${config.host}:${config.port}`;
  return new Promise<CheckOutcome>((resolve) => {
    // Build call metadata BEFORE creating the client. grpc-js throws on
    // illegal metadata keys/values with a message that embeds the FULL
    // value — which per the schema docs is an auth token. That message
    // must never escape runCheck (it would land in logs), so we guard
    // the construction and return a typed reason with NO detail. The
    // client is only created after the metadata is known-good, so
    // there is nothing to leak (or close) on this path.
    let md: grpc.Metadata;
    try {
      md = new grpc.Metadata();
      for (const [k, v] of Object.entries(config.metadata ?? {})) md.set(k, v);
    } catch {
      resolve({ ok: false, reason: "grpc_metadata_invalid" });
      return;
    }

    let client: InstanceType<typeof HealthClient>;
    try {
      client = new HealthClient(target, creds);
    } catch (e) {
      resolve({ ok: false, reason: "grpc_error", detail: (e as Error).message });
      return;
    }

    const start = Date.now();
    const deadline = new Date(start + timeoutMs);
    let settled = false;
    const done = (o: CheckOutcome) => {
      if (settled) return;
      settled = true;
      try {
        client.close();
      } catch {
        /* already closed */
      }
      resolve(o);
    };

    try {
      (client as unknown as { check: Function }).check(
        { service: config.service ?? "" },
        md,
        { deadline },
        (err: grpc.ServiceError | null, resp: { status: number } | undefined) => {
          const latencyMs = Date.now() - start;
          if (err) {
            done({
              ok: false,
              reason: classifyGrpcError(err.code, err.details),
              detail: err.details,
              grpcCode: err.code,
              latencyMs,
            });
            return;
          }
          done({ ok: true, status: resp?.status ?? 0, latencyMs });
        },
      );
    } catch (e) {
      done({ ok: false, reason: "grpc_error", detail: (e as Error).message });
    }
  });
}

export async function execute(config: GrpcConfig): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();
  const interpretation = config.interpretation ?? "health_state";
  const mode = config.tls_mode ?? "plaintext";

  const credsRes = buildCredentials(config);
  if (!credsRes.ok) {
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: credsRes.reason,
      metadata: {
        target: `${config.host}:${config.port}`,
        tls_mode: mode,
        ...(credsRes.detail ? { detail: credsRes.detail } : {}),
      },
    };
  }

  const outcome = await runCheck(config, credsRes.creds);

  const baseMeta: Record<string, unknown> = {
    target: `${config.host}:${config.port}`,
    service: config.service ?? "",
    tls_mode: mode,
    interpretation,
    ...(credsRes.certExpiringSoon ? { cert_expiry_warning: true } : {}),
    ...(outcome.latencyMs !== undefined ? { latency_ms: outcome.latencyMs } : {}),
  };

  if (!outcome.ok) {
    // Deliberately NOT surfacing outcome.detail here: it carries the
    // gRPC server's status message (and, on the throw paths, an
    // exception message), which is server-controlled text that could
    // echo back call metadata. The typed reason + numeric grpc_code
    // are enough to triage; the raw detail stays out of persisted
    // metadata. (buildCredentials detail above is an env-var NAME, not
    // a secret, so that one is kept.)
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: outcome.reason,
      metadata: {
        ...baseMeta,
        ...(outcome.grpcCode !== undefined ? { grpc_code: outcome.grpcCode } : {}),
      },
    };
  }

  const status = outcome.status ?? 0;
  const meta = { ...baseMeta, health_status: status };

  // latency: any successful Check RPC yields a round-trip value,
  // regardless of serving status.
  if (interpretation === "latency") {
    return { value: outcome.latencyMs ?? null, timestamp: ts(), metadata: meta };
  }

  // health_state mapping.
  if (status === SERVING) return { value: 1, timestamp: ts(), metadata: meta };
  if (status === NOT_SERVING) return { value: 0, timestamp: ts(), metadata: meta };
  if (status === SERVICE_UNKNOWN) {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "grpc_service_unknown", metadata: meta };
  }
  // UNKNOWN (0) or anything unexpected.
  return { value: null, timestamp: ts(), status_hint: "no_data", reason: "grpc_health_unknown", metadata: meta };
}

const source: ProbeSource<GrpcConfig> = { execute, validateConfig };
export default source;
