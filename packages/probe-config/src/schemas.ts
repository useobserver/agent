// Per-source Zod schemas.
//
// Each metric definition carries source_type + source_config. These
// schemas are the single contract between the cloud UI, the cloud
// API, and the agent runtime in src/sources/.
//
// Schemas marked "runtime: shipped" have a working executor. Schemas
// marked "runtime: stubbed" are defined so the UI / API can accept
// definitions before the runtime lands.

import { z } from "zod";

const port = z.number().int().min(1).max(65535);
const timeoutMs = z.number().int().min(1).max(60_000);
const nonEmptyString = z.string().min(1);

const httpFields = {
  url: z.string().url(),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).default("GET"),
  expected_status: z.union([z.number().int().min(100).max(599), z.array(z.number().int().min(100).max(599)).min(1)]).default(200),
  timeout_ms: timeoutMs.default(5_000),
  headers: z.record(z.string(), z.string()).optional(),
  body_match: z.string().optional(),
  follow_redirects: z.boolean().default(true),
  verify_tls: z.boolean().default(true),
};

// runtime: shipped (21.3)
export const PrometheusConfigSchema = z
  .object({
    query: nonEmptyString,
    prometheus_url: z.string().url().optional(),
  })
  .strict();

// runtime: shipped (21.3)
export const HttpConfigSchema = z.object(httpFields).strict();

// runtime: shipped (21.3)
export const TcpConfigSchema = z
  .object({
    host: nonEmptyString,
    port,
    timeout_ms: timeoutMs.default(2_000),
  })
  .strict();

// runtime: shipped (21.3)
export const DnsConfigSchema = z
  .object({
    domain: nonEmptyString,
    record_type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "PTR"]).default("A"),
    expected_value: z.string().optional(),
    resolver: z.string().optional(),
  })
  .strict();

// runtime: shipped (21.3)
export const TlsCertConfigSchema = z
  .object({
    host: nonEmptyString,
    port: port.default(443),
    warn_days: z.number().int().min(1).max(365).default(30),
    critical_days: z.number().int().min(1).max(365).default(7),
  })
  .strict()
  .refine((v) => v.warn_days >= v.critical_days, {
    message: "warn_days must be >= critical_days",
    path: ["warn_days"],
  });

// runtime: stubbed (21.3 returns not_implemented)
export const IcmpConfigSchema = z
  .object({
    host: nonEmptyString,
    count: z.number().int().min(1).max(20).default(3),
    timeout_ms: timeoutMs.default(2_000),
  })
  .strict();

// runtime: stubbed
export const GrpcConfigSchema = z
  .object({
    host: nonEmptyString,
    port,
    service: z.string().optional(),
    tls: z.boolean().default(true),
  })
  .strict();

// runtime: stubbed
export const WebsocketConfigSchema = z
  .object({
    url: z.string().url().refine((v) => v.startsWith("ws://") || v.startsWith("wss://"), {
      message: "url must use ws:// or wss://",
    }),
    send_message: z.string().optional(),
    expect_message: z.string().optional(),
    timeout_ms: timeoutMs.default(5_000),
  })
  .strict();

// runtime: stubbed
export const MtlsHttpConfigSchema = z
  .object({
    ...httpFields,
    client_cert_ref: nonEmptyString,
    client_key_ref: nonEmptyString,
  })
  .strict();

// runtime: stubbed
export const DatabaseConfigSchema = z
  .object({
    kind: z.enum(["postgres", "mysql", "redis", "mongodb"]),
    connection_string_ref: nonEmptyString,
    query: z.string().optional(),
    timeout_ms: timeoutMs.default(5_000),
  })
  .strict();

// z.infer<>'d types — public so callers can replace `Record<string, unknown>`
// with the right shape per probe.
export type PrometheusConfig = z.infer<typeof PrometheusConfigSchema>;
export type HttpConfig = z.infer<typeof HttpConfigSchema>;
export type TcpConfig = z.infer<typeof TcpConfigSchema>;
export type DnsConfig = z.infer<typeof DnsConfigSchema>;
export type TlsCertConfig = z.infer<typeof TlsCertConfigSchema>;
export type IcmpConfig = z.infer<typeof IcmpConfigSchema>;
export type GrpcConfig = z.infer<typeof GrpcConfigSchema>;
export type WebsocketConfig = z.infer<typeof WebsocketConfigSchema>;
export type MtlsHttpConfig = z.infer<typeof MtlsHttpConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
