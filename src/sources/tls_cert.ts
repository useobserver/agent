// TLS certificate probe source.

import tls from "node:tls";
import net from "node:net";
import type { ProbeResult, ProbeSource } from "../types.ts";
import { TlsCertConfigSchema, type TlsCertConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MS_PER_DAY = 86_400_000;

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(TlsCertConfigSchema, config);
}

export async function execute(config: TlsCertConfig): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();
  const port = config.port ?? 443;
  return await new Promise((resolve) => {
    let settled = false;
    let socket: tls.TLSSocket;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* already torn down */
      }
      resolve(result);
    };
    // SNI server_name forbids IP literals (Node 22+ throws synchronously
    // with ERR_INVALID_ARG_VALUE). Skip the servername hint for raw IPs;
    // hostnames still get it so virtual-hosted servers respond correctly.
    const isIpLiteral = net.isIP(config.host) !== 0;
    try {
      socket = tls.connect(
        {
          host: config.host,
          port,
          ...(isIpLiteral ? {} : { servername: config.host }),
          rejectUnauthorized: false,
          timeout: DEFAULT_TIMEOUT_MS,
        },
        () => {
          const cert = socket.getPeerCertificate();
          if (!cert || !cert.valid_to) {
            return finish({ value: null, timestamp: ts(), status_hint: "no_data", reason: "no_cert" });
          }
          const expiryMs = new Date(cert.valid_to).getTime();
          if (!Number.isFinite(expiryMs)) {
            return finish({ value: null, timestamp: ts(), status_hint: "no_data", reason: "bad_cert_date" });
          }
          const days = Math.max(0, Math.floor((expiryMs - Date.now()) / MS_PER_DAY));
          finish({
            value: days,
            timestamp: ts(),
            metadata: {
              subject: cert.subject?.CN ?? null,
              issuer: cert.issuer?.CN ?? null,
              valid_to: cert.valid_to,
            },
          });
        }
      );
      socket.once("timeout", () =>
        finish({ value: null, timestamp: ts(), status_hint: "no_data", reason: "ETIMEDOUT" })
      );
      socket.once("error", (err: NodeJS.ErrnoException) =>
        finish({ value: null, timestamp: ts(), status_hint: "no_data", reason: err.code || "tls_error" })
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      finish({ value: null, timestamp: ts(), status_hint: "no_data", reason: e.code || "tls_error" });
    }
  });
}

const source: ProbeSource<TlsCertConfig> = { execute, validateConfig };
export default source;
