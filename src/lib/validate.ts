import { NextResponse } from "next/server";

/**
 * A wrong-typed scalar used to be the database's problem, and the database
 * answers in one of two unhelpful ways. The table below is what leadgenius'
 * write routes did before this existed. Eight rows are a real call through the
 * exported handler with a valid key and an otherwise-valid body; the other nine
 * are the Prisma call the replaced handler made, measured directly, because the
 * probe never got past an earlier 400 on those routes. Full provenance, row by
 * row, is improvements §8.12:
 *
 *   POST /api/contacts          email: 42              500 PrismaClientValidationError
 *   POST /api/contacts          company: []            500 PrismaClientValidationError
 *   POST /api/contacts          customFields: 42       201  — a number in a Json column
 *   POST /api/campaigns         name: 42               500 PrismaClientValidationError
 *   POST /api/campaigns         startDate: 42          201  — reads back 1970-01-01T00:00:00.042Z
 *   POST /api/contact-lists     name: 42               500 PrismaClientValidationError
 *   POST /api/enrollments       contactId: 42          500 PrismaClientValidationError
 *   POST /api/webhooks          events: ["a","b"]      500  (the column is a String)
 *   POST /api/sequences         channel: "FAX"         201  — a step no sender will pick up
 *   POST /api/templates         body omitted           500 "Argument `body` is missing"
 *   POST /api/sending-accounts  config omitted         500 "Argument `config` is missing"
 *   POST /api/sending-accounts  dailyLimit: "1000"     500  Expected Int, provided String
 *   POST /api/sending-accounts  dailyLimit: 0          201  — stored as 100, the `|| 100` fallback
 *   PATCH /api/sequences/:id    steps: [...]           500  (a relation, not a column)
 *   PATCH /api/sequences/:id    {}                     200  — the row, unchanged
 *   PATCH /api/contacts/:id     {} or {foo:1}          200  — the row, unchanged
 *   PATCH /api/contacts/:id     company: ""            200  — dropped by `&&`, unchanged
 *
 * A 500 is the one status a correct client retries, against a request that will
 * fail identically forever. The 201s are worse: `startDate: 42` and
 * `customFields: 42` are stored without complaint and read back as a date in
 * 1970 and a scalar where every reader expects an object. Prisma validates the
 * types it was told about (String, Int, DateTime) and not the ones it was not —
 * `channel`, `status` and `provider` are plain String columns whose values live
 * in a schema comment, so `channel: "FAX"` is a clean 201 today and a step no
 * sender will ever pick up.
 *
 * So the check belongs at the boundary, against a declared table per route:
 *
 *  - No coercion. `String(42)` into a text field turns a client bug into the
 *    value "42", which is the same silent corruption coming the other way.
 *  - An absent key means "not mentioned" and is omitted, so a PATCH cannot
 *    reset a column the caller never named. `null` means "clear it" and only
 *    works where the column is nullable.
 *  - Every problem is reported at once, named by field. A caller who sent four
 *    bad fields and is told about one needs four round trips to learn the API.
 *  - Text is trimmed. `email: " a@b.co "` passes a type check, then defeats
 *    `@@unique([workspaceId, email])` and every later lookup by address.
 *  - A field the route did not declare never reaches Prisma. That is what the
 *    `steps` row above is: a caller-specified key spread into an update.
 *
 * This is `src/lib/ids.ts` for the rest of the request: a list of ids already
 * refuses the shapes Prisma cannot take. `withAuth` deliberately stays an error
 * boundary rather than growing a global `PrismaClientValidationError -> 400`,
 * because that net would also swallow a validation error our own code causes —
 * which is a bug, and wants to be loud.
 */

import { collect, collectBody, describe, short } from "./validation-engine";
import type { Schema, Validated, ValidationProblem } from "./validation-engine";

export type { FieldKind, Field, JsonObject, JsonArray, Schema, Validated, ValidationProblem } from "./validation-engine";
export { NO_FIELD_TO_UPDATE } from "./validation-engine";


export type Validation<S extends Schema> =
  | { ok: true; data: Validated<S>; error?: undefined }
  | { ok: false; data?: undefined; error: NextResponse };

/**
 * The engine's walk, projected into this app's envelope. Every rule — which kinds
 * exist, what a wrong value is called, what `null` and an absent key mean — is in
 * `./validation-engine`, one file for all six apps. This function is here because
 * what a problem *becomes* on the wire is this app's own decision, and the six
 * have never agreed about it: five answer 400 with `{ error, fields }`, abetapi
 * answers 422 with `{ error: { code, message }, fields }` because that envelope is
 * what its published OpenAPI document promises. Reunited rules, forked answer.
 */
export function validateBody<S extends Schema>(
  body: unknown,
  schema: S,
  opts: { requireWrite?: boolean } = {},
): Validation<S> {
  const result = collectBody(body, schema, opts);
  return result.ok ? result : fail(result.problems);
}

/**
 * Guard a nested array of objects — `stepsConfig[]` — with the same
 * declared-field rule, so a bad entry names its index instead of arriving as
 * "the 400 that says nothing about which step".
 */
export function validateItems<T>(
  value: unknown,
  name: string,
  item: Schema,
  opts: { required?: boolean; min?: number; max?: number } = {},
): { ok: true; items: T[]; error?: undefined } | { ok: false; items?: undefined; error: NextResponse } {
  if (value === undefined) {
    if (opts.required) return { ok: false, error: bad(`${name} is required`) };
    return { ok: true, items: [] };
  }
  if (!Array.isArray(value)) return { ok: false, error: bad(`${name} must be an array, got ${describe(value)}`) };
  const max = opts.max ?? 100;
  if (value.length > max) return { ok: false, error: bad(`${name} holds ${value.length} entries; at most ${max}`) };
  if (opts.min !== undefined && value.length < opts.min) {
    return { ok: false, error: bad(`${name} must hold at least ${opts.min} entries`) };
  }
  const items: Record<string, unknown>[] = [];
  const problems: ValidationProblem[] = [];
  for (const [i, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push([`${name}[${i}]`, `${name}[${i}] must be an object, got ${describe(entry)}`]);
      continue;
    }
    const out: Record<string, unknown> = {};
    problems.push(...collect(entry as Record<string, unknown>, item, out, `${name}[${i}]`));
    items.push(out);
  }
  if (problems.length) return { ok: false, error: fail(problems).error };
  return { ok: true, items: items as T[] };
}

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;

/**
 * Comma-separated token list, for the column whose schema comment shows an
 * array while the only code that reads it splits on commas (`Webhook.events`).
 * Both shapes are accepted at the boundary and one shape is stored, so a
 * caller following the comment no longer gets a 500 and the reader still finds
 * what it expects.
 */
export function eventNames(
  value: unknown,
  name = "events",
  max = 50,
): { ok: true; values: string[]; error?: undefined } | { ok: false; values?: undefined; error: NextResponse } {
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") {
        return { ok: false, error: bad(`${name} holds ${describe(entry)}; every event must be text`) };
      }
      parts.push(entry);
    }
  } else if (typeof value === "string") {
    parts.push(...value.split(","));
  } else {
    return {
      ok: false,
      error: bad(`${name} must be an array of event names or a comma-separated string, got ${describe(value)}`),
    };
  }
  const values: string[] = [];
  for (const part of parts) {
    const token = part.trim();
    if (!token) continue;
    if (!EVENT_NAME.test(token)) {
      return { ok: false, error: bad(`${name} holds ${short(token)}; an event name is letters, digits, dot, dash or underscore`) };
    }
    if (!values.includes(token)) values.push(token);
  }
  if (!values.length) return { ok: false, error: bad(`${name} must name at least one event`) };
  if (values.length > max) return { ok: false, error: bad(`${name} names ${values.length} events; at most ${max}`) };
  return { ok: true, values };
}

/* ---------- the per-field walk, shared by body and array entry ---------- */

function bad(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * One message per field, plus a `fields` object keyed the same way as the body
 * the caller sent. The key is the point: the 500s above named an argument only
 * inside a Prisma stack line that never reached the client.
 */
function fail(problems: ValidationProblem[]): { ok: false; error: NextResponse } {
  const fields: Record<string, string> = {};
  for (const [name, message] of problems) fields[name] = message;
  return {
    ok: false,
    error: NextResponse.json({ error: problems.map(([, message]) => message).join("; "), fields }, { status: 400 }),
  };
}

/**
 * A refusal about one field that the schema walk cannot express, because it is
 * about where the value *points* rather than whether it is well-formed — the
 * address-shape rule in `egress.ts`. Same envelope and status as `fail`, so a
 * client cannot tell the two apart by shape, only by the message.
 */
export function fieldProblem(name: string, message: string): NextResponse {
  return fail([[name, message]]).error;
}
