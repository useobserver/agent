// @observer/probe-config — public API.

export { PROBE_TYPES, type ProbeType } from "./probe-types";

export {
  PrometheusConfigSchema,
  HttpConfigSchema,
  TcpConfigSchema,
  DnsConfigSchema,
  TlsCertConfigSchema,
  IcmpConfigSchema,
  GrpcConfigSchema,
  WebsocketConfigSchema,
  MtlsHttpConfigSchema,
  DatabaseConfigSchema,
} from "./schemas";

export type {
  PrometheusConfig,
  HttpConfig,
  TcpConfig,
  DnsConfig,
  TlsCertConfig,
  IcmpConfig,
  GrpcConfig,
  WebsocketConfig,
  MtlsHttpConfig,
  DatabaseConfig,
} from "./schemas";

export {
  getConfigSchema,
  validateProbeWrite,
  type ProbeWriteValues,
  type ProbeWriteResult,
} from "./validate";
