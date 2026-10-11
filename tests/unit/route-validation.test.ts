// N5, held in place: a request body that reaches Prisma unvalidated is a 500 or a
// wrong row, and there is nothing in the type system that notices when the next
// route forgets.
//
// Measured against this app's own dev.db over HTTP, with the app's own signing
// secrets set — a run of 47 requests through `next dev`, before these routes were
// wired (full provenance, case by case, is improvements §8.19):
//
//   POST /api/ai/draft-reply    body not JSON          500 — request.json() threw
//   POST /api/ai/draft-reply    enrollmentId: 42       500  Expected String, provided Int
//   POST /api/ai/draft-reply    productContext: 42     500 `42.trim is not a function`
//   POST /api/ai/draft-reply    model: 42              502 — sent to the provider as a number
//   POST /api/webhooks/email    {"event":…}            500 `body.map is not a function`
//   POST /api/webhooks/email    timestamp: "soon"      500  Provided Date object is invalid
//   POST /api/webhooks/email    sg_message_id: 42      500  Expected String, provided Int
//   POST /api/webhooks/email    event: {}              500 `event.toLowerCase is not a function`
//   POST /api/webhooks/email    no sg_message_id       200 — a BOUNCED on a message it never named
//   POST /api/webhooks/linkedin value: 5               500 `body.value is not iterable`
//   POST /api/webhooks/linkedin urn: 42                500 `senderUrn.replace is not a function`
//   POST /api/webhooks/linkedin no urn                 200 — `contains: ""` matched every contact
//   POST /api/webhooks/whatsapp From: 42               500 `body.From.startsWith is not a function`
//   POST /api/webhooks/whatsapp MessageSid: 42         500  Expected String, provided Int
//   POST /api/webhooks/whatsapp Body: 42               200 — a number in a text column's slot
//   POST /api/webhooks/events   5 / "prose" / null     500  Cannot create property 'event'
//
// Sixteen 500s and five 200s that were not true, every one of them reachable by a
// correctly *signed* request — the signature is what authorizes these four
// endpoints, so the caller in every row above is someone the deployment vouches
// for. That is what this file keeps: `validate.test.ts` proves the engine, and
// these prove that every route is actually plugged into it. The scanner is shared
// with `route-auth.test.ts` for the reason given there — a copy scanned twice
// drifts twice, and a handler either copy cannot see has to fail, not pass
// quietly.
//
// Running this file for the first time is also part of the measurement, and it
// found two things about *itself*: a `validateItems<EmailEvent>(` call read as no
// validation at all (the email and linkedin routes were accused of the very wiring
// they have), and `from` was read out of the whatsapp route as a table name. Both
// are in `schemaArgs` now, and both are pinned by a test of the scanner rather than
// trusted because the run went green the second time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectHandlers, countCodeMentions, schemaArgs, unresolvedTailCalls } from "./route-handlers";
import * as FIELDS from "../../src/lib/fields";
import * as ENUMS from "../../src/lib/enums";

/** The calls that decide what a body may contain. */
// The optional type argument is not decoration: `validateItems<EmailEvent>(` is how
// a route names the shape it gets back, and a matcher that stopped at the `<` read
// that call as *no validation at all* — the two webhook routes failed this test for
// having wired it correctly.
const VALIDATES = /validate(?:Body|Items)(?:<[^<>]*>)?\s*\(|eventNames\s*\(/;

/**
 * Reading a body at all, however the handler spells it. `request.text()` belongs
 * here as much as `request.json()`: the four inbound-provider routes take the
 * bytes because their HMAC is over them, and then parse them by hand — which is
 * exactly the code that was never checked against anything.
 */
const READS_A_BODY = /\brequest\.json\s*\(\s*\)|\brequest\.text\s*\(\s*\)|\brequest\.formData\s*\(\s*\)/;

/**
 * Handlers that read a body and are not on the list above, each with the reason
 * it is acceptable. Adding a line here is the review step, same as PUBLIC is for
 * authentication.
 */
const UNVALIDATED: Record<string, string[]> = {
  // The two dashboard billing calls. Both are session-authed — 401 measured for a
  // body of `5` and for a real JSON body with an invalid cookie, and this dev.db
  // holds zero user rows, so there is no session that gets further — and neither
  // writes a Prisma row. `priceId` is checked by membership in `PRICES` and
  // `returnUrl` by `sameOriginReturnUrl`, which is a same-origin rule this engine
  // has no kind for. There is no 500 and no wrong row here to prevent: the input
  // never reaches a column.
  "src/app/api/billing/checkout/route.ts": ["POST"],
  "src/app/api/billing/portal/route.ts": ["POST"],
  // Stripe, over the exact bytes, verified by Stripe's own SDK. Measured: no
  // signature, a garbage signature and a body written to look like a
  // `customer.subscription.updated` event all answer 400 at `verifyWebhook`,
  // before anything is parsed. What does reach Prisma arrives through
  // `syncSubscriptionFromStripe`, whose `metadata.workspaceId` comes from this
  // payload and is not checked against a row — that is a different rule (a foreign
  // key taken on faith inside a helper, invisible to this file's scanner as well)
  // and it is filed as its own number, not excused by this entry.
  "src/app/api/billing/webhook/route.ts": ["POST"],
};

test("every handler that reads a body validates it", () => {
  const offenders: string[] = [];
  for (const h of collectHandlers()) {
    if (!READS_A_BODY.test(h.body)) continue;
    if (VALIDATES.test(h.body)) continue;
    if ((UNVALIDATED[h.file] ?? []).includes(h.method)) continue;
    offenders.push(`${h.file} ${h.method}`);
  }
  assert.deepEqual(offenders, [], `handlers that read a body and hand it to Prisma unchecked:\n  ${offenders.join("\n  ")}`);
});

test("UNVALIDATED names handlers that still exist", () => {
  const seen = new Set(collectHandlers().map((h) => `${h.file} ${h.method}`));
  const stale = Object.entries(UNVALIDATED).flatMap(([file, methods]) => methods.filter((m) => !seen.has(`${file} ${m}`)));
  assert.deepEqual(stale, [], `excused but not found — delete the entry or fix the scanner:\n  ${stale.join("\n  ")}`);
});

// The routes' source, not the handlers' resolved bodies: an import is outside
// the body, and the schema argument is read out of the call where it is used.
const ROUTE_FILES = [...new Set(collectHandlers().map((h) => h.file))];
const routeSource = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

// The reader for the two rules below is vendored — `shared/tests/route-handlers.ts`.
// `schemaArgs` replaced this file's regex, which mis-read two of the four shapes
// §8.19.4 found; the shapes it does read are pinned in the vendored
// `route-scanner.test.ts`, so they are tested in all six apps and not in the one that
// happened to find them.

test("a route validates against a declared table, never an inline one", () => {
  const declared = new Set(Object.keys(FIELDS));
  const offenders: string[] = [];
  for (const file of ROUTE_FILES) {
    for (const arg of schemaArgs(routeSource(file))) {
      if (arg.startsWith("{")) offenders.push(`${file} — an inline schema`);
      else if (!declared.has(arg)) offenders.push(`${file} — ${arg} is not exported from lib/fields`);
    }
  }
  assert.deepEqual(offenders, [], `validate calls with no table in lib/fields:\n  ${offenders.join("\n  ")}`);
});

test("every declared table is used by a route, and every enum set by a table", () => {
  const fieldSource = routeSource("src/lib/fields.ts");
  const unusedTables = Object.keys(FIELDS).filter(
    (name) => !ROUTE_FILES.some((file) => new RegExp(`\\b${name}\\b`).test(routeSource(file)))
      && countCodeMentions(fieldSource, name) === 0,
  );
  assert.deepEqual(unusedTables, [], `tables in lib/fields nothing uses — delete them or wire them:\n  ${unusedTables.join("\n  ")}`);

  const unusedEnums = Object.keys(ENUMS).filter((name) => countCodeMentions(fieldSource, name) === 0);
  assert.deepEqual(unusedEnums, [], `enum sets no field table checks against:\n  ${unusedEnums.join("\n  ")}`);
});

/**
 * `*Id` fields whose value does not name one of our rows, so "prove the row exists"
 * has no row to prove.
 *
 * [prisma] `Activity.messageId` is `String?  // Provider message ID` — the only
 * column the two message routes write from this field, and neither looks anything
 * up by it. The one `where: { id: messageId }` in `src` is `lib/queue.ts:63`, on the
 * *outbound* send job, whose payload key happens to share the name and whose value
 * is a `SentMessage.id` this app minted itself. `INBOUND_EMAIL_EVENT.messageId` is
 * deliberately not here: the provider's id is how that route *finds* the row
 * (`where: { providerMessageId: messageId }`), which is the check this rule wants.
 *
 * What these two do lack is an idempotency check — Twilio redelivers a MessageSid,
 * and a second delivery writes a second REPLIED activity — but that is a different
 * rule about a different column, and it is filed as its own number rather than
 * excused here.
 */
const ID_IS_NOT_A_ROW: Record<string, string> = {
  "INBOUND_MESSAGE_EVENT.messageId": "the provider's handle for the message, stored on Activity.messageId and never resolved",
};

/**
 * A text field called `somethingId` names a row rather than filling a column, so
 * the type check is only half the rule: measured, a `sg_message_id` that was not
 * there at all was a valid request and still wrote an activity and a BOUNCED
 * enrollment for whichever `SentMessage` came back. The route has to say whether
 * the id exists and belongs to this workspace, either through a batch helper that
 * 422s naming the ones it did not find, or through a lookup that 404s — where "no
 * such row" is the whole answer.
 *
 * The lookup may key on any column, not only `id`: `where: { providerMessageId:
 * messageId }` establishes existence just as well as `where: { id: enrollmentId }`
 * does, and the inbound tables deal in the providers' ids, which are not primary
 * keys here. What is *not* accepted is a value that reaches no `where` at all.
 */
test("an id-typed field is checked for existence where it is accepted", () => {
  const offenders: string[] = [];
  for (const [name, schema] of Object.entries(FIELDS)) {
    const idFields = Object.entries(schema as Record<string, { kind?: string }>)
      .filter(([field, spec]) => /Id$/.test(field) && spec?.kind === "text" && !(ID_IS_NOT_A_ROW[`${name}.${field}`]))
      .map(([field]) => field);
    if (!idFields.length) continue;
    for (const file of ROUTE_FILES.filter((f) => new RegExp(`\\b${name}\\b`).test(routeSource(f)))) {
      const src = routeSource(file);
      for (const field of idFields) {
        const batchChecked = new RegExp(`(unknownIdError|unknownIdsError|missingIds)[^)]*\\b${field}\\b`).test(src);
        const lookedUp = new RegExp(`where:\\s*\\{[^}]*:\\s*(?:[\\w.]+\\.)?${field}\\b`).test(src);
        if (!batchChecked && !lookedUp) {
          offenders.push(`${file} accepts ${name}.${field} without checking the row exists`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `foreign keys taken on faith:\n  ${offenders.join("\n  ")}`);
});

test("an id exemption names a field that is really there, and really is an id", () => {
  const stale = Object.keys(ID_IS_NOT_A_ROW).filter((key) => {
    const [name, field] = key.split(".");
    const schema = (FIELDS as Record<string, any>)[name];
    return schema?.[field]?.kind !== "text" || !/Id$/.test(field!);
  });
  assert.deepEqual(stale, [], `excused fields this rule would not have flagged anyway:\n  ${stale.join("\n  ")}`);
});

/**
 * A handler whose body is `return helper(request)` validates nothing and writes nothing
 * until the helper is read. The scanner resolves same-file tail calls (§8.41); this asks
 * it, once per handler, whether the callee's block actually came back — so the day the
 * resolution breaks, the rules above fail loudly instead of passing on a thinner body.
 * Vendored mechanism, local assertion: 181 handlers across the six apps, none hidden.
 */
test("no handler hides a same-file helper behind a tail call", () => {
  const hidden = unresolvedTailCalls(collectHandlers());
  assert.deepEqual(hidden, [], `scanned without the function they return:\n  ${hidden.join("\n  ")}`);
});
