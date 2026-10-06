// Redis read-only command allowlist.
//
// The agent's database probe accepts a verbatim Redis command string
// (e.g. "DBSIZE", "LLEN myqueue", "STRLEN config:version"). This
// parser splits the first token, uppercases it, and rejects anything
// not in the allowlist. The read-only Redis user the operator
// provisions is the actual security boundary; this parser is
// defense in depth so a misconfigured user can't accidentally fire
// FLUSHALL.

export interface RedisCheckResult {
  ok: boolean;
  /** The uppercased command name on success. */
  command?: string;
  /** Arguments after the command, in shell-tokenised form. */
  args?: string[];
  reason?: string;
}

// Commands that always return a number and never mutate state. We
// keep the list short on purpose; growing it past read-shaped
// commands is a real-world security regression risk. Add an entry
// when a customer needs it, not preemptively.
//
// Specifically:
//   - DBSIZE                  → integer
//   - EXISTS key [key ...]    → integer (count of existing keys)
//   - LLEN key                → integer
//   - SCARD key               → integer
//   - ZCARD key               → integer
//   - HLEN key                → integer
//   - STRLEN key              → integer
//   - TTL  key                → integer (seconds, -1 / -2)
//   - PTTL key                → integer (ms, -1 / -2)
//   - BITCOUNT key            → integer
//   - GET  key                → bulk string (coerced to number when numeric)
//   - INCR-like commands are NOT here (they mutate)
//   - KEYS / SCAN are NOT here (O(N) blocking on large dbs)
//   - INFO / CONFIG are NOT here (return multi-line text; out of scope v1)
const ALLOWED_COMMANDS = new Set([
  "DBSIZE",
  "EXISTS",
  "LLEN",
  "SCARD",
  "ZCARD",
  "HLEN",
  "STRLEN",
  "TTL",
  "PTTL",
  "BITCOUNT",
  "GET",
]);

/**
 * Split the raw command into [command, ...args] using shell-style
 * quoting. Supports single + double quotes; backslash escapes
 * preserved verbatim. Returns null on unbalanced quotes.
 */
function tokenise(raw: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < raw.length) {
    const ch = raw[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        cur += ch;
      }
      i++;
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\" && i + 1 < raw.length) {
        cur += raw[i + 1];
        i += 2;
        continue;
      } else {
        cur += ch;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (/\s/.test(ch ?? "")) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (inSingle || inDouble) return null;
  if (cur.length > 0) out.push(cur);
  return out;
}

export function checkRedisCommand(rawCommand: string): RedisCheckResult {
  if (typeof rawCommand !== "string") {
    return { ok: false, reason: "command is not a string" };
  }
  const trimmed = rawCommand.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "command is empty" };
  }
  // Disallow newlines (multi-command RESP injection guard). Even with
  // ioredis's command API the raw string would never reach the wire
  // as multi-command, but reject loudly so the operator catches the
  // configuration mistake before save.
  if (/[\r\n]/.test(trimmed)) {
    return { ok: false, reason: "command contains a newline" };
  }
  const tokens = tokenise(trimmed);
  if (!tokens || tokens.length === 0) {
    return { ok: false, reason: "command did not tokenise (check quotes)" };
  }
  const cmd = tokens[0]!.toUpperCase();
  if (!ALLOWED_COMMANDS.has(cmd)) {
    return { ok: false, reason: `${cmd} is not in the read-only command allowlist` };
  }
  return { ok: true, command: cmd, args: tokens.slice(1) };
}

export const REDIS_ALLOWED_COMMANDS = Object.freeze([...ALLOWED_COMMANDS]);
