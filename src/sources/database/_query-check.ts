// SELECT-only statement check.
//
// This is belt-and-suspenders alongside the read-only DB role the
// operator is expected to provision. The read-only role is the real
// security boundary; this parser stops obviously-wrong queries
// (UPDATE / DELETE / DROP / DDL) from ever reaching the database, so
// a misconfigured role doesn't turn a bad metric def into a
// destructive operation.
//
// What we accept:
//   - A single statement that starts with SELECT
//   - A single statement that starts with WITH and contains SELECT
//     in its body (CTE wrapping a SELECT)
//
// What we reject:
//   - Anything starting with INSERT / UPDATE / DELETE / TRUNCATE /
//     DROP / ALTER / CREATE / GRANT / REVOKE / COPY / CALL / DO /
//     MERGE / EXEC / EXECUTE / SET
//   - Multi-statement bodies (queries containing `;` outside of a
//     literal). We reject any unquoted semicolon to keep this simple.
//   - Empty / whitespace-only strings.

export interface QueryCheckResult {
  ok: boolean;
  reason?: string;
}

// Strip C-style block comments (/* … */) and line comments (-- …\n)
// to keep keyword detection robust. We preserve string literals
// verbatim so a comment-shaped substring inside a string doesn't
// trip the strip.
function stripCommentsPreservingLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // Single-quoted string literal. Both Postgres `''` doubling and
    // MySQL / Postgres-E `\'` backslash escapes are treated as in-
    // literal so we never enter a parsing state where we think a
    // string has closed but the engine does not (or vice versa).
    if (ch === "'") {
      out += ch;
      i++;
      while (i < sql.length) {
        const c = sql[i];
        out += c;
        i++;
        if (c === "\\" && i < sql.length) {
          out += sql[i];
          i++;
          continue;
        }
        if (c === "'") {
          if (i < sql.length && sql[i] === "'") {
            out += sql[i];
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    // Double-quoted identifier (preserve).
    if (ch === '"') {
      out += ch;
      i++;
      while (i < sql.length) {
        const c = sql[i];
        out += c;
        i++;
        if (c === "\\" && i < sql.length) {
          out += sql[i];
          i++;
          continue;
        }
        if (c === '"') {
          if (i < sql.length && sql[i] === '"') {
            out += sql[i];
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }
    // Block comment.
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2; // skip past */
      out += " ";
      continue;
    }
    // Line comment.
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Find unquoted ; outside of string literals.
//
// String literal handling tries to match both Postgres and MySQL
// behavior because we don't know which engine the query targets at
// parse time:
//   - SQL-standard / Postgres: `''` inside a single-quoted string is
//     a literal `'` and does NOT close the string. Backslash is a
//     plain character.
//   - MySQL (default mode) + Postgres E'…' strings: backslash escapes
//     the next character. `''` doubling still works.
// We treat BOTH as valid escapes so the parser is conservative — a
// closing `'` only counts when it isn't paired and isn't preceded by
// an unescaped backslash. False negatives risk admitting writes
// (real concern); false positives just reject legal SELECTs (the
// operator rephrases). We bias toward false positives.
function containsUnquotedSemicolon(sql: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) {
      if (ch === "\\" && i < sql.length - 1) {
        i++;
        continue;
      }
      if (ch === "'") {
        // Doubled '' = escaped quote, keep going.
        if (i + 1 < sql.length && sql[i + 1] === "'") {
          i++;
          continue;
        }
        inSingle = false;
        continue;
      }
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i < sql.length - 1) {
        i++;
        continue;
      }
      if (ch === '"') {
        if (i + 1 < sql.length && sql[i + 1] === '"') {
          i++;
          continue;
        }
        inDouble = false;
        continue;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === ";") {
      // Trailing semicolons are tolerated. Only flag a `;` followed
      // by any non-whitespace character (a second statement).
      const rest = sql.slice(i + 1).trim();
      if (rest.length > 0) return true;
    }
  }
  return false;
}

const ALLOWED_LEADING = new Set(["SELECT", "WITH"]);
const DISALLOWED_LEADING = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "DROP",
  "ALTER",
  "CREATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "CALL",
  "DO",
  "MERGE",
  "EXEC",
  "EXECUTE",
  "SET",
  "LOCK",
  "UNLOCK",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "VACUUM",
  "REINDEX",
  "CLUSTER",
  "REFRESH",
  "REPLACE",
];

/**
 * Returns `{ ok: true }` when the query is a single SELECT-shaped
 * statement, otherwise `{ ok: false, reason: "<short>" }`.
 */
export function checkSelectOnly(rawSql: string): QueryCheckResult {
  if (typeof rawSql !== "string") return { ok: false, reason: "query is not a string" };
  const stripped = stripCommentsPreservingLiterals(rawSql).trim();
  if (stripped.length === 0) return { ok: false, reason: "query is empty after comment strip" };

  // Reject anything with an unquoted second statement.
  if (containsUnquotedSemicolon(stripped)) {
    return { ok: false, reason: "multi-statement queries are not allowed" };
  }

  // First non-whitespace token.
  const firstWordMatch = stripped.match(/^([A-Za-z]+)\b/);
  if (!firstWordMatch) {
    return { ok: false, reason: "query does not start with a SQL keyword" };
  }
  const first = firstWordMatch[1]!.toUpperCase();

  if (DISALLOWED_LEADING.includes(first)) {
    return { ok: false, reason: `${first} statements are not allowed` };
  }
  if (!ALLOWED_LEADING.has(first)) {
    return { ok: false, reason: `query must start with SELECT or WITH, got ${first}` };
  }

  // For WITH, require the body to contain a SELECT keyword somewhere
  // outside of a string literal. (We've already stripped comments,
  // so a SELECT inside a comment doesn't satisfy this.) This is a
  // best-effort check; the read-only role is the real safeguard.
  if (first === "WITH") {
    const upper = stripped.toUpperCase();
    // Match SELECT as a whole word.
    if (!/\bSELECT\b/.test(upper)) {
      return { ok: false, reason: "WITH query body must contain a SELECT" };
    }
    // Reject WITH + write-tail (INSERT/UPDATE/DELETE inside a CTE).
    if (/\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(upper)) {
      return { ok: false, reason: "WITH query must not contain write statements" };
    }
  }

  // Reject state-changing constructs a SELECT/WITH leading keyword still
  // permits — the parser is defense-in-depth for a misprovisioned read-only
  // role, which is exactly where these matter. Strip string literals first so
  // an INTO/INSERT *inside a quoted string* (e.g. SELECT 'INSERT INTO x') is
  // not a false positive.
  const noLiterals = stripped
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const upperAll = noLiterals.toUpperCase();
  // SELECT INTO (new table/temp), INTO OUTFILE / DUMPFILE (MySQL file write).
  if (/\bINTO\b/.test(upperAll)) {
    return { ok: false, reason: "INTO clause is not allowed" };
  }
  // Known side-effecting functions (sequence mutation, session config, backend
  // control, large-object/file IO, dblink). Read-only pg_* (e.g. pg_database_size)
  // intentionally NOT denied.
  if (/\b(SETVAL|NEXTVAL|SET_CONFIG|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|LO_EXPORT|LO_IMPORT|PG_READ_FILE|PG_LS_DIR|DBLINK)\s*\(/.test(upperAll)) {
    return { ok: false, reason: "side-effecting function is not allowed" };
  }

  return { ok: true };
}
