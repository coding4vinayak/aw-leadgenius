import { NextResponse } from "next/server";

/**
 * A caller-supplied list is input, not a fact, and it has to be checked before
 * it reaches Prisma or a later reader. Neither failure shape is informative
 * once it gets there. Measured on leadworks' POST /api/leads — the identical
 * code here had the identical holes, before any of this existed:
 *
 *   listIds: ["nope"]        P2003 "Foreign key constraint violated"  -> 500
 *   listIds: "abc"           TypeError: listIds.map is not a function -> 500
 *   listIds: [42]            PrismaClientValidationError              -> 500
 *   listIds: [id, id]        409 "a Contact with this listId + contactId
 *                            already exists" — about a contact that did not
 *                            exist yet
 *   listIds: {a: 1}          201, with no membership written at all, because
 *                            `?.length` is undefined on an object: a contact
 *                            outside every list the caller named, silently
 *                            missing every campaign keyed to those lists
 *
 * withAuth maps P2002 and nothing else, so the first three left as 500 — the
 * one status a correct client retries, against a request that will fail
 * identically forever.
 *
 * Abetanalytics' dashboards route and snapshots' `typeof metricId !== "string"`
 * guard already do this inline; this is the same rule in one place for the two
 * apps that take a list.
 */
export interface IdList {
  /** Deduplicated, order-preserving; empty when the caller named nothing. */
  values: string[];
  error: null;
}
export interface IdListError {
  values: null;
  error: NextResponse;
}

/**
 * `max` bounds one request's fan-out: an unbounded list turns a single POST
 * into thousands of membership rows, and the page-size lesson from `limit` is
 * that a cap is the only thing a hostile or buggy client cannot argue with.
 */
export function asStrings(value: unknown, name: string, max = 100): IdList | IdListError {
  // Absent and empty mean the same thing here: nothing named. `null` reaches
  // us from JSON, `undefined` from a body that never mentioned the field, and
  // both must stay the 201 they are today.
  if (value === undefined || value === null) return { values: [], error: null };
  if (!Array.isArray(value)) {
    return { values: null, error: NextResponse.json({ error: `${name} must be an array of strings` }, { status: 400 }) };
  }
  if (value.length > max) {
    return { values: null, error: NextResponse.json({ error: `${name} holds ${value.length} entries; at most ${max}` }, { status: 400 }) };
  }
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "") {
      return { values: null, error: NextResponse.json({ error: `every ${name} entry must be a non-empty string` }, { status: 400 }) };
    }
    if (!values.includes(item)) values.push(item);
  }
  return { values, error: null };
}

/**
 * 422, not 404: the request is well-formed and the record it creates is fine —
 * one of the ids it points at is not. Naming them is the whole point; "a list
 * was not found" makes a caller who sent twenty ids guess which.
 */
export function unknownIdsError(name: string, missing: string[]): NextResponse {
  const shown = missing.slice(0, 5);
  const more = missing.length > shown.length ? ` (+${missing.length - shown.length} more)` : "";
  return NextResponse.json(
    { error: `${name} holds ${missing.length} id${missing.length === 1 ? "" : "s"} this workspace does not have: ${shown.join(", ")}${more}`, unknownIds: missing },
    { status: 422 },
  );
}

/** Ids in `wanted` that the database did not return, in the caller's order. */
export function missingIds(wanted: string[], found: { id: string }[]): string[] {
  const have = new Set(found.map((f) => f.id));
  return wanted.filter((id) => !have.has(id));
}

/**
 * Validate several array-valued Json columns at once, keyed by column name so
 * a route can spread the result straight into `data`. PATCH needs it per-field
 * (`x !== undefined && ...`) because it must not reset a column the caller
 * never mentioned; POST needs it unconditionally because the column is NOT
 * NULL. Same rule, one call.
 */
export function stringArrayColumns<T extends Record<string, unknown>>(
  fields: T,
  max = 100,
): { columns: { [K in keyof T]: string[] }; error: null } | { columns: null; error: NextResponse } {
  const columns: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(fields)) {
    const parsed = asStrings(value, name, max);
    if (parsed.error) return { columns: null, error: parsed.error };
    columns[name] = parsed.values;
  }
  return { columns: columns as { [K in keyof T]: string[] }, error: null };
}
