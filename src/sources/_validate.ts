// Helper used by every source's validateConfig(). Parses against the
// canonical Zod schema from @observer/probe-config and returns either
// null (valid) or a single string with every issue concatenated, in
// the form "<field>: <message>". Test suites assert on regex matches
// against field names.

import type { ZodTypeAny } from "zod";

export function validateWithSchema(schema: ZodTypeAny, config: unknown): null | string {
  if (config == null || typeof config !== "object") return "config must be an object";
  const r = schema.safeParse(config);
  if (r.success) return null;
  return r.error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}
