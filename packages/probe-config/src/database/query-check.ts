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

export type SqlDialect = "postgres" | "mysql";

// Engine-aware lexer. Turns the query into "code": string literals become
// '', quoted identifiers are unwrapped to a word (non-word characters become
// _, so "nextval"('s') still reads as a call), and comments become a space.
// Every later check runs on the code alone, so text the engine reads as SQL
// can never hide inside something this lexer took for a literal, and the
// other way round. The two engines disagree:
//   postgres: '' doubles a quote; a backslash escapes only in E'...';
//     $tag$...$tag$ is a string; "..." is an identifier; -- and nested
//     /* */ are comments; # is an operator.
//   mysql: '...' and "..." are strings where backslash escapes; `...` is
//     an identifier; # and "-- " are comments; /* */ does not nest;
//     /*! ... */ is EXECUTED, so it is refused.
// Anything unterminated, or a comment form the engine could read as code,
// is refused rather than guessed.
// Not a discriminated union: apps/web compiles this without strictNullChecks,
// where narrowing on `ok` does not work.
type Lexed = { ok: boolean; code: string; reason?: string };

const WORD = /[A-Za-z0-9_]/;

function unwrapIdent(inner: string): string {
  return inner.replace(/[^A-Za-z0-9_$]/g, "_");
}

function lexSql(sql: string, dialect: SqlDialect): Lexed {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // Comments.
    if (ch === "-" && next === "-") {
      const after = sql[i + 2];
      if (dialect === "mysql" && after !== undefined && !/[ \t\r\n\f\v]/.test(after)) {
        // MySQL reads "1--1" as arithmetic: never strip it as a comment.
        return { ok: false, code: "", reason: "a -- comment must be followed by a space" };
      }
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "#" && dialect === "mysql") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      if (dialect === "mysql" && sql[i + 2] === "!") {
        return { ok: false, code: "", reason: "MySQL executable comments (/*! */) are not allowed" };
      }
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else if (dialect === "postgres" && sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else i++;
      }
      if (depth > 0) return { ok: false, code: "", reason: "unterminated comment" };
      out += " ";
      continue;
    }

    // Postgres dollar-quoted string: $$...$$ or $tag$...$tag$. A $ inside a
    // word (a$b) or a parameter ($1) is not one.
    if (dialect === "postgres" && ch === "$" && !(i > 0 && WORD.test(sql[i - 1]!))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close < 0) return { ok: false, code: "", reason: "unterminated dollar-quoted string" };
        i = close + tag.length;
        out += "''";
        continue;
      }
    }

    // String literals.
    const isPgString = dialect === "postgres" && ch === "'";
    const isMyString = dialect === "mysql" && (ch === "'" || ch === '"');
    if (isPgString || isMyString) {
      const quote = ch;
      // Postgres honours backslash escapes only in E'...' (E/e directly
      // before the quote, and not the end of a longer word).
      const prev = sql[i - 1];
      const backslash =
        dialect === "mysql" ||
        ((prev === "E" || prev === "e") && !(i >= 2 && WORD.test(sql[i - 2]!)));
      i++;
      let closed = false;
      while (i < n) {
        const c = sql[i]!;
        if (backslash && c === "\\") {
          i += 2;
          continue;
        }
        if (c === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return { ok: false, code: "", reason: "unterminated string literal" };
      out += "''";
      continue;
    }

    // Quoted identifiers: unwrap so a quoted function name is still seen.
    const identQuote = dialect === "postgres" ? '"' : "`";
    if (ch === identQuote) {
      i++;
      let inner = "";
      let closed = false;
      while (i < n) {
        const c = sql[i]!;
        if (c === identQuote) {
          if (sql[i + 1] === identQuote) {
            inner += c;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        inner += c;
        i++;
      }
      if (!closed) return { ok: false, code: "", reason: "unterminated quoted identifier" };
      out += unwrapIdent(inner);
      continue;
    }

    out += ch;
    i++;
  }
  return { ok: true, code: out };
}

// Any ; followed by more SQL is a second statement. Literals are gone from
// the code, so a ; here is always live.
function hasSecondStatement(code: string): boolean {
  const i = code.indexOf(";");
  return i >= 0 && code.slice(i + 1).replace(/;/g, "").trim().length > 0;
}

const ALLOWED_LEADING = new Set(["SELECT", "WITH"]);

const SIDE_EFFECT_FN = new RegExp(
  "\\b(" +
    [
      "SETVAL",
      "NEXTVAL",
      "SET_CONFIG",
      "PG_TERMINATE_BACKEND",
      "PG_CANCEL_BACKEND",
      "PG_RELOAD_CONF",
      "PG_ROTATE_LOGFILE",
      "PG_STAT_RESET\\w*",
      "PG_SWITCH_WAL",
      "PG_CREATE_RESTORE_POINT",
      "PG_PROMOTE",
      "PG_(?:TRY_)?ADVISORY_\\w+",
      "LO_\\w+",
      "PG_READ_FILE",
      "PG_READ_BINARY_FILE",
      "PG_LS_DIR",
      "PG_FILE_WRITE",
      "PG_NOTIFY",
      "PG_LOGICAL_EMIT_MESSAGE",
      "PG_\\w*REPLICATION_SLOT\\w*",
      "DBLINK\\w*",
      "GET_LOCK",
      "RELEASE_LOCK",
      "RELEASE_ALL_LOCKS",
      "LOAD_FILE",
    ].join("|") +
    ")\\s*\\(",
);
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
 * statement, otherwise `{ ok: false, reason: "<short>" }`. With no dialect
 * the query must pass the rules of both engines.
 */
export function checkSelectOnly(rawSql: string, dialect?: SqlDialect): QueryCheckResult {
  if (typeof rawSql !== "string") return { ok: false, reason: "query is not a string" };
  if (!dialect) {
    const pg = checkSelectOnly(rawSql, "postgres");
    return pg.ok ? checkSelectOnly(rawSql, "mysql") : pg;
  }
  const lexed = lexSql(rawSql, dialect);
  if (!lexed.ok) return { ok: false, reason: lexed.reason ?? "query could not be read" };
  const code = lexed.code.trim();
  if (code.length === 0) return { ok: false, reason: "query is empty after comment strip" };

  if (hasSecondStatement(code)) {
    return { ok: false, reason: "multi-statement queries are not allowed" };
  }

  const firstWordMatch = code.match(/^([A-Za-z]+)\b/);
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

  const upper = code.toUpperCase();
  if (first === "WITH") {
    if (!/\bSELECT\b/.test(upper)) {
      return { ok: false, reason: "WITH query body must contain a SELECT" };
    }
    // A data-modifying CTE (WITH x AS (DELETE ...) SELECT ...).
    if (/\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(upper)) {
      return { ok: false, reason: "WITH query must not contain write statements" };
    }
  }
  // SELECT ... INTO (new table), INTO OUTFILE / DUMPFILE (MySQL file write).
  if (/\bINTO\b/.test(upper)) {
    return { ok: false, reason: "INTO clause is not allowed" };
  }
  // Row locks: FOR UPDATE / FOR SHARE / LOCK IN SHARE MODE.
  if (/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/.test(upper) || /\bLOCK\s+IN\s+SHARE\s+MODE\b/.test(upper)) {
    return { ok: false, reason: "row locking clauses are not allowed" };
  }
  // Known side-effecting functions (sequence mutation, session config,
  // backend/server control, locks, notifications, replication slots,
  // large-object/file IO, dblink). Read-only pg_* functions (e.g.
  // pg_database_size) are intentionally NOT denied.
  if (SIDE_EFFECT_FN.test(upper)) {
    return { ok: false, reason: "side-effecting function is not allowed" };
  }
  return { ok: true };
}
