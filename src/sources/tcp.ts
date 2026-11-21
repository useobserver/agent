// TCP probe source.

import net from "node:net";
import type { ProbeResult, ProbeSource } from "../types.ts";
import { TcpConfigSchema, type TcpConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";
import { classifyNetError } from "./net-errors.ts";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(TcpConfigSchema, config);
}

export async function execute(config: TcpConfig): Promise<ProbeResult> {
  const timeoutMs = config.timeout_ms ?? 2_000;
  const ts = (): string => new Date().toISOString();
  const start = Date.now();
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: config.host, port: config.port });
    let settled = false;
    let wall: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      try {
        socket.destroy();
      } catch {
        /* already torn down */
      }
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    // Wall-clock cap: the idle timeout is not guaranteed to cover the
    // connect phase, and a dropped SYN otherwise waits for the kernel's
    // retry limit (about 2 minutes on Linux).
    wall = setTimeout(
      () => finish({ value: null, timestamp: ts(), status_hint: "no_data", reason: "ETIMEDOUT" }),
      timeoutMs + 250,
    );
    socket.once("close", () => clearTimeout(wall));
    socket.once("connect", () => finish({ value: Date.now() - start, timestamp: ts() }));
    socket.once("timeout", () =>
      finish({ value: null, timestamp: ts(), status_hint: "no_data", reason: "ETIMEDOUT" })
    );
    socket.once("error", (err: NodeJS.ErrnoException) =>
      finish({ value: null, timestamp: ts(), status_hint: "no_data", reason: classifyNetError(err, "tcp_error").reason })
    );
  });
}

const source: ProbeSource<TcpConfig> = { execute, validateConfig };
export default source;
