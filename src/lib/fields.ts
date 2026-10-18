import type { Schema } from "./validate";
import {
  ABTEST_STATUSES,
  CAMPAIGN_STATUSES,
  CONTACT_STATUSES,
  ENROLLMENT_STATUSES,
  SENDING_CHANNELS,
  SENDING_PROVIDERS,
  SEQUENCE_CHANNELS,
  SEQUENCE_STATUSES,
  STEP_CHANNELS,
  TEMPLATE_CHANNELS,
} from "./enums";

/**
 * What each write route accepts, one declared table per route. It lives here
 * rather than beside its handler because the collection route and its `[id]`
 * sibling write the same columns — a contact's `PATCH` and `POST` disagreeing
 * about what `title` may hold is exactly the kind of drift a table you can read
 * in one screen prevents. The API's whole input contract is this file.
 *
 * `workspaceId` and `id` are absent everywhere on purpose: they come from the
 * key and the path, never the body. A field not listed here never reaches
 * Prisma, which also retires the `...(steps && { steps })` shape in
 * `sequences/[id]` — a caller-named relation written into an update `data`,
 * answered with a 500.
 *
 * The tables are written out field by field rather than built from a helper,
 * because `validateBody` reads `kind` and `required` as literal types to work
 * out what each key holds; a function returning `Field` widens them and the
 * route loses the typing this is meant to give it.
 *
 * No `json` field below is `nullable`. Prisma writes a NULL into a JSON column
 * with its own `DbNull` sentinel rather than `null`, so "clear this" has no
 * shape a client can send that is not a translation at the boundary; `{}` is
 * the empty value in the same form every reader of those columns expects.
 */

/** Contact, as POSTed. `status` is a create-time default, not an input. */
export const CONTACT_CREATE = {
  email: { kind: "text", nullable: true, format: "email", max: 254 },
  phone: { kind: "text", nullable: true, max: 32 },
  linkedinUrl: { kind: "text", nullable: true, format: "url", max: 500 },
  firstName: { kind: "text", nullable: true, max: 100 },
  lastName: { kind: "text", nullable: true, max: 100 },
  company: { kind: "text", nullable: true, max: 200 },
  title: { kind: "text", nullable: true, max: 200 },
  customFields: { kind: "json" },
} satisfies Schema;

/** Contact, as patched: the same columns plus the lifecycle value. */
export const CONTACT_PATCH = {
  ...CONTACT_CREATE,
  status: { kind: "enum", values: CONTACT_STATUSES },
} satisfies Schema;

export const CAMPAIGN_CREATE = {
  name: { kind: "text", required: true, max: 200 },
  goal: { kind: "text", nullable: true, max: 500 },
  startDate: { kind: "date", nullable: true },
  endDate: { kind: "date", nullable: true },
} satisfies Schema;

export const CAMPAIGN_PATCH = {
  name: { kind: "text", max: 200 },
  goal: { kind: "text", nullable: true, max: 500 },
  startDate: { kind: "date", nullable: true },
  endDate: { kind: "date", nullable: true },
  status: { kind: "enum", values: CAMPAIGN_STATUSES },
} satisfies Schema;

/**
 * `campaignId` is not a column: it links the new sequence to a campaign in the
 * same request, and the route looks it up first. Declared here so it is
 * type-checked rather than passed to a `findFirst` on faith.
 */
export const SEQUENCE_CREATE = {
  name: { kind: "text", required: true, max: 200 },
  description: { kind: "text", nullable: true, max: 2000 },
  channel: { kind: "enum", required: true, values: SEQUENCE_CHANNELS },
  stepsConfig: { kind: "json", max: 256 * 1024 },
  campaignId: { kind: "text", max: 32 },
} satisfies Schema;

export const SEQUENCE_PATCH = {
  name: { kind: "text", max: 200 },
  description: { kind: "text", nullable: true, max: 2000 },
  channel: { kind: "enum", values: SEQUENCE_CHANNELS },
  status: { kind: "enum", values: SEQUENCE_STATUSES },
} satisfies Schema;

/**
 * One entry of `stepsConfig`. The engine reads these back as `SequenceStep`
 * rows, so a step without `stepNumber` is a row that sorts nowhere and a
 * contact that never gets a second message.
 */
export const SEQUENCE_STEP = {
  stepNumber: { kind: "int", required: true, min: 1, max: 1000 },
  channel: { kind: "enum", required: true, values: STEP_CHANNELS },
  // Nullable so the `""` the old handler treated as "no template" still means
  // that, and reaches the row as no reference rather than an empty string that
  // fails the SequenceStep -> Template foreign key.
  templateId: { kind: "text", nullable: true, max: 32 },
  delayDays: { kind: "int", min: 0, max: 365 },
  delayHours: { kind: "int", min: 0, max: 720 },
  conditions: { kind: "json" },
} satisfies Schema;

export const CONTACT_LIST_CREATE = {
  name: { kind: "text", required: true, max: 200 },
  description: { kind: "text", nullable: true, max: 2000 },
  isDynamic: { kind: "bool" },
  filterJson: { kind: "json" },
} satisfies Schema;

export const SENDING_ACCOUNT_CREATE = {
  name: { kind: "text", required: true, max: 200 },
  channel: { kind: "enum", required: true, values: SENDING_CHANNELS },
  provider: { kind: "enum", required: true, values: SENDING_PROVIDERS },
  // The only column on this model that is NOT NULL without a default, and so
  // the one a missing value used to answer with a 500.
  config: { kind: "json", required: true },
  dailyLimit: { kind: "int", min: 1, max: 100000 },
  warmupEnabled: { kind: "bool" },
  isDefault: { kind: "bool" },
} satisfies Schema;

/**
 * `channel` and `provider` are destructured by this handler and have never been
 * in the `data` it writes, so this table leaves them out too: making an account
 * change its provider is a behaviour change, not a validation fix, and it
 * belongs in front of whoever owns the sending path rather than smuggled in
 * beside a type check. A wrong provider today means delete and re-create.
 */
export const SENDING_ACCOUNT_PATCH = {
  name: { kind: "text", max: 200 },
  config: { kind: "json" },
  dailyLimit: { kind: "int", min: 1, max: 100000 },
  warmupEnabled: { kind: "bool" },
  isDefault: { kind: "bool" },
  isActive: { kind: "bool" },
} satisfies Schema;

export const TEMPLATE_CREATE = {
  name: { kind: "text", required: true, max: 200 },
  channel: { kind: "enum", required: true, values: TEMPLATE_CHANNELS },
  // `body` is both the column name and the payload key the handler already
  // reads — the request body is aliased to avoid the collision.
  body: { kind: "text", required: true, max: 50000 },
  subject: { kind: "text", nullable: true, max: 500 },
  variables: { kind: "json" },
} satisfies Schema;

export const TEMPLATE_PATCH = {
  name: { kind: "text", max: 200 },
  channel: { kind: "enum", values: TEMPLATE_CHANNELS },
  body: { kind: "text", max: 50000 },
  subject: { kind: "text", nullable: true, max: 500 },
  variables: { kind: "json" },
} satisfies Schema;

export const ENROLLMENT_CREATE = {
  contactId: { kind: "text", required: true, max: 32 },
  sequenceId: { kind: "text", required: true, max: 32 },
  campaignId: { kind: "text", max: 32 },
} satisfies Schema;

export const ABTEST_CREATE = {
  campaignId: { kind: "text", required: true, max: 32 },
  name: { kind: "text", required: true, max: 80 },
  hypothesis: { kind: "text", required: true, max: 300 },
} satisfies Schema;

// The declared half of a variant row: shapes Prisma could not take, or would
// take wrongly, named at the boundary. The cross-entry rules — names unique,
// exactly one control, weights summing to 100 — cannot live in a per-field
// table and sit in `validateAbTestSemantics` (lib/abtest.ts).
export const ABTEST_VARIANT = {
  name: { kind: "text", required: true, max: 40 },
  weight: { kind: "int", required: true, min: 1, max: 100 },
  isControl: { kind: "bool", required: true },
  sequenceId: { kind: "text", required: true, max: 32 },
  templateId: { kind: "text", max: 32 },
} satisfies Schema;

/**
 * `PATCH /api/abtests/:id`. `winningVariant` is a name, not an id — the route
 * checks it against the test's own variant rows — and `DRAFT` is in the
 * column's domain but is refused as a transition target: no route ever wrote
 * it, and "go back to before it existed" is not a lifecycle step.
 */
export const ABTEST_PATCH = {
  status: { kind: "enum", required: true, values: ABTEST_STATUSES },
  winningVariant: { kind: "text", max: 40 },
} satisfies Schema;

/**
 * The only field `PATCH /api/enrollments/:id` has ever taken. `nextActionAt`
 * and `currentStep` are the engine's, not the caller's: a client that moves an
 * enrollment to step 4 also skips the three messages that would have run.
 */
export const ENROLLMENT_PATCH = {
  status: { kind: "enum", required: true, values: ENROLLMENT_STATUSES },
} satisfies Schema;

/**
 * `events` is deliberately not here: it is the one input whose accepted JSON
 * shape (an array of names, or the comma-separated string the column actually
 * holds) differs from what gets stored, so `eventNames()` in the route checks
 * it and the handler decides the stored form.
 */
export const WEBHOOK_CREATE = {
  url: { kind: "text", required: true, format: "url", max: 2000 },
} satisfies Schema;

export const WEBHOOK_PATCH = {
  url: { kind: "text", format: "url", max: 2000 },
  isActive: { kind: "bool" },
} satisfies Schema;

/* ---------- inbound: the provider's payload, after the adapter renames it ---------- */

/**
 * The four routes above are this file's original rule: a body a caller chose,
 * checked before it reaches a column. These four are a different case and are
 * here for the same reason — a provider payload's values reach the same columns.
 *
 * They are tables over the *normalised* event, not over what SendGrid or Twilio
 * posts: the adapter renames `sg_message_id` to `messageId` and epoch seconds to
 * an ISO string, and passes every other value through untouched, so a wrong type
 * is still the provider's and the message still names the provider's field. One
 * table per shape rather than one per provider, because the three email providers
 * differ in key names and units, not in what the write needs.
 *
 * Measured before any of this existed (improvements §8.19): 16 requests that were
 * correctly signed and answered 500, and two that answered 200 having written a
 * row the request never named — an event with no message id looked up a
 * SentMessage with the filter key dropped, and a LinkedIn event with no sender
 * URN searched `linkedinUrl contains ""`.
 */

/** One delivery event from SendGrid, Mailgun or Postmark. */
export const INBOUND_EMAIL_EVENT = {
  // The lookup key. Required because its absence was the silent wrong row: with
  // the key `undefined`, Prisma drops the filter and returns some message.
  messageId: { kind: "text", required: true, max: 255 },
  // Mapped to an activity type below; a non-text here was `event.toLowerCase is
  // not a function`. Unmapped names stay a 200 that ignores the event, as they
  // always have — this is not a vocabulary the providers agreed with us.
  event: { kind: "text", required: true, max: 64 },
  email: { kind: "text", max: 254 },
  timestamp: { kind: "date" },
  metadata: { kind: "json" },
} satisfies Schema;

/** One inbound chat message, from LinkedIn or Twilio WhatsApp. */
export const INBOUND_MESSAGE_EVENT = {
  messageId: { kind: "text", required: true, max: 255 },
  // `urn:li:person:…` or `whatsapp:+1555…`. Required for both, because each
  // route's whole job is deciding which contact this came from, and a missing or
  // non-text value used to become either a 500 or a match on everybody.
  from: { kind: "text", required: true, max: 500 },
  // Absent on a status callback and on an attachment-only message.
  content: { kind: "text", max: 50000 },
} satisfies Schema;

/**
 * The envelope `POST /api/webhooks/events` re-queues for delivery. Only `event`
 * is declared: the rest of the body is the subscriber's own payload and passes
 * through to them untouched, which is why the route validates a copy of it
 * instead of writing the validated fields back. `event` is the one key the
 * delivery worker reads — it becomes the `X-LeadGenius-Event` header.
 */
export const EVENTS_ENVELOPE = {
  event: { kind: "text", max: 100 },
} satisfies Schema;

/**
 * `POST /api/ai/draft-reply` writes nothing — it reads an enrollment and answers
 * with a suggestion. It is still a table, because three of its fields were
 * measured reaching a crash or a provider request untyped: `enrollmentId: 42`
 * was a Prisma 500, `productContext: 42` was a 500 from `42.trim()` (a 200 only
 * while no `LLM_API_KEY` is set, because the route returns before reaching it),
 * and `model: 42` went out to the model provider as a number.
 */
export const AI_DRAFT_REPLY = {
  enrollmentId: { kind: "text", required: true, max: 32 },
  reply: { kind: "text", required: true, max: 20000 },
  productContext: { kind: "text", max: 20000 },
  // A list of strings the drafting prompt quotes. The engine has no "array of
  // scalars" kind, so this stays `json` and the route keeps filtering to text.
  knownFacts: { kind: "json" },
  model: { kind: "text", max: 100 },
} satisfies Schema;
