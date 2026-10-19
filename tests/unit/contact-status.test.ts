// #120 — the lifecycle column the outreach paths never read.
//
// `Contact.status` has carried BOUNCED / UNSUBSCRIBED / DO_NOT_CONTACT in its
// schema comment since the first migration, and `PATCH /api/contacts/{id}`
// lets an operator set it — but nothing read it: enrolling a DO_NOT_CONTACT
// contact was a clean 201, and the minute sweep emailed the address anyway.
// "Outreach that earns replies, not spam complaints" is the sentence the
// product sells; this round is that sentence enforced at the two places mail
// can leave: the enroll boundary (a refusal the caller sees) and the engine
// (a stop for statuses that change mid-sequence). The mapping is pure —
// `stopStatusForContact` gets known answers; the two call sites are read from
// source, in the house pattern for wiring a database cannot show in node:test.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stopStatusForContact, statusAfterProviderSignal, providerSignalFromDeliveryStatus } from "../../src/lib/sequence-engine";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

describe("stopStatusForContact", () => {
  it("lets an ACTIVE contact run", () => {
    assert.equal(stopStatusForContact("ACTIVE"), null);
  });

  it("maps the two provider-shaped statuses onto their identical enrollment statuses", () => {
    // The same rows the email webhook writes when the bounce or unsubscribe
    // arrives live — a manually-marked contact stops the sequence the way the
    // signal does, not a third way.
    assert.equal(stopStatusForContact("BOUNCED"), "BOUNCED");
    assert.equal(stopStatusForContact("UNSUBSCRIBED"), "UNSUBSCRIBED");
  });

  it("pauses for DO_NOT_CONTACT instead of lying with a completion", () => {
    // COMPLETED would fire the CRM's sequence.completed webhook on a refusal;
    // PAUSED keeps the enrollment for the record and says nothing happened.
    assert.equal(stopStatusForContact("DO_NOT_CONTACT"), "PAUSED");
  });
});

describe("the enroll boundary refuses a dead contact before anything is written", () => {
  const enroll = source("../../src/app/api/enrollments/route.ts");

  it("reads the contact's status and 409s naming it, before the A/B arm or the row", () => {
    assert.match(enroll, /if \(contact\.status !== "ACTIVE"\)/);
    assert.match(enroll, /contact is \$\{contact\.status\} — only an ACTIVE contact can start an outreach/);
    assert.match(enroll, /status: 409/);
    const refusal = enroll.indexOf('contact is ${contact.status}');
    const armAssignment = enroll.indexOf("assignVariant(");
    const creation = enroll.indexOf("prisma.enrollment.create");
    assert.ok(refusal < armAssignment && armAssignment < creation, "refusal must precede arm assignment and row creation");
  });
});

describe("the engine stops a mid-sequence contact whose status changed", () => {
  const engine = source("../../src/lib/sequence-engine.ts");

  it("consults the pure mapping on every trigger, before any step is read or sent", () => {
    assert.match(engine, /const stop = stopStatusForContact\(enrollment\.contact\.status\)/);
    assert.match(engine, /if \(stop\)[\s\S]{0,160}data: \{ status: stop \}[\s\S]{0,40}return/);
    const guard = engine.indexOf("stopStatusForContact(enrollment.contact.status)");
    const stepRead = engine.indexOf("const currentStep = steps[enrollment.currentStep]");
    assert.ok(guard < stepRead, "the guard must run before the step machinery");
  });

  it("is called from the trigger funnel, not only the sweep", () => {
    // processSequenceStep is the single door every trigger walks through
    // (webhooks, send worker, sweep); a guard in the sweep alone would let a
    // REPLIED or SENT event send the next step to a DO_NOT_CONTACT contact.
    assert.match(engine, /export async function processSequenceStep/);
    assert.doesNotMatch(source("../../src/lib/scheduler.ts"), /stopStatusForContact/);
  });
});

// #121 — the writer side of the same column. The email webhook flipped the
// enrollment on BOUNCED/COMPLAINED and the contact stayed ACTIVE forever, so
// the round-13 guard opened the door again for the next enrollment; and an
// `unsubscribe` event — the one signal the recipient themselves sent — flipped
// nothing at all. The stamp must also never overwrite the operator's stronger
// mark, so the decision is a pure table and the route only applies it.
describe("statusAfterProviderSignal", () => {
  it("marks an ACTIVE contact from each signal", () => {
    assert.equal(statusAfterProviderSignal("ACTIVE", "BOUNCED"), "BOUNCED");
    assert.equal(statusAfterProviderSignal("ACTIVE", "UNSUBSCRIBED"), "UNSUBSCRIBED");
    // A spam complaint is the recipient's strongest unsubscribe action; the
    // enrollment branch already treats it as one, so the contact agrees.
    assert.equal(statusAfterProviderSignal("ACTIVE", "COMPLAINED"), "UNSUBSCRIBED");
  });

  it("never overwrites a status that is already not ACTIVE", () => {
    // DO_NOT_CONTACT is an operator decision and outranks a provider event;
    // an already-marked address gains nothing from a second signal.
    for (const marked of ["BOUNCED", "UNSUBSCRIBED", "DO_NOT_CONTACT"]) {
      for (const signal of ["BOUNCED", "COMPLAINED", "UNSUBSCRIBED"] as const) {
        assert.equal(statusAfterProviderSignal(marked, signal), null, `${marked} + ${signal}`);
      }
    }
  });
});

describe("the email webhook stamps the contact, not only the enrollment", () => {
  const hook = source("../../src/app/api/webhooks/email/route.ts");

  it("the unsubscribe event joins the flip branch the bounce and complaint live in", () => {
    assert.match(hook, /activityType === "BOUNCED" \|\| activityType === "COMPLAINED" \|\| activityType === "UNSUBSCRIBED"/);
  });

  it("consults the pure table and writes the contact only when it says to", () => {
    assert.match(hook, /statusAfterProviderSignal\(priorContact\.status, activityType\)/);
    assert.match(hook, /if \(priorContact && marked\)[\s\S]{0,200}prisma\.contact\.update/);
    // The mark comes from the table, not from a status the route invented.
    assert.doesNotMatch(hook, /prisma\.contact\.update[\s\S]{0,80}status: "BOUNCED"/);
  });

  it("the contact stamp carries a #65 revert, in the same reverts list", () => {
    assert.match(hook, /reverts\.push\(\(\) => prisma\.contact\.update\([\s\S]{0,120}status: back/);
    const flip = hook.indexOf('activityType === "UNSUBSCRIBED"');
    const stamp = hook.indexOf("statusAfterProviderSignal(priorContact.status");
    const enqueueTry = hook.indexOf("await enqueue(queues.sequence");
    assert.ok(flip < stamp && stamp < enqueueTry, "stamp must run inside the flip branch, before the enqueue that can revert it");
  });

  it("the flip decision is typed, so no route can feed the table a stray string", () => {
    assert.match(hook, /function mapEmailEvent\(event: string\): EmailActivityType \| null/);
  });
});

// #122 — the same lifecycle signal on the WhatsApp channel. Twilio posts a
// delivery-status callback (MessageSid + MessageStatus, and on failures an
// ErrorCode) to the same route that receives incoming messages. The route knew
// the shape existed — its own comment named the shared MessageSid — but had no
// branch for it: the callback passed the inbound shape check (Body is optional),
// its From is OUR sending number so the contact lookup missed, and every real
// delivery failure became a silent 200. The decision of which status+code pair
// counts as this channel's bounce is the pure table's; the route applies it and
// writes the same rows the email webhook does.
describe("providerSignalFromDeliveryStatus", () => {
  it("treats undelivered as the channel's bounce, whatever the code says", () => {
    assert.equal(providerSignalFromDeliveryStatus("undelivered", undefined), "BOUNCED");
    assert.equal(providerSignalFromDeliveryStatus("UNDELIVERED", 30001), "BOUNCED");
  });

  it("reads failed as a bounce only when the code names the recipient", () => {
    for (const code of [21601, 21602, 21612, 21614, 30004, 30006, 30008]) {
      assert.equal(providerSignalFromDeliveryStatus("failed", code), "BOUNCED", `failed + ${code}`);
      // Twilio posts form-encoded, so the code arrives as a string.
      assert.equal(providerSignalFromDeliveryStatus("failed", String(code)), "BOUNCED", `failed + "${code}"`);
    }
  });

  it("keeps a failure that names OUR sender or the carrier off the contact", () => {
    // 21211/21408 are configuration faults, 30005/30007 are carrier-side
    // generic errors, and an unseen code must not default to killing a
    // contact — the bias is "guessed nothing", not "guessed dead".
    for (const code of [21211, 21408, 30005, 30007, 11200, undefined, null, "not-a-number"]) {
      assert.equal(providerSignalFromDeliveryStatus("failed", code), null, `failed + ${String(code)}`);
    }
  });

  it("ignores the statuses that are not lifecycle events at all", () => {
    for (const status of ["queued", "sent", "delivered", "reading", "received", "partically_delivered", "whatever-twilio-invents"]) {
      assert.equal(providerSignalFromDeliveryStatus(status, 30008), null, status);
    }
  });
});

describe("the WhatsApp route branches a delivery-status callback before the inbound path", () => {
  const hook = source("../../src/app/api/webhooks/whatsapp/route.ts");
  // The delivery branch, sliced out of the handler: everything between the
  // status dispatch and the inbound-message guard that no longer sees those
  // payloads.
  const branch = hook.slice(
    hook.indexOf('typeof deliveryStatus === "string"'),
    hook.indexOf("body.MessageSid === undefined"),
  );

  it("dispatches on the status field, accepting both modern and legacy names", () => {
    assert.match(hook, /const deliveryStatus = body\.MessageStatus \?\? body\.Status/);
    assert.match(hook, /if \(typeof deliveryStatus === "string"\)/);
    const dispatch = hook.indexOf('typeof deliveryStatus === "string"');
    const inboundGuard = hook.indexOf("body.MessageSid === undefined");
    assert.ok(dispatch < inboundGuard, "the status branch must run before the inbound-message guard");
  });

  it("matches on the stored provider id, never on From", () => {
    // From on this shape is our sending number; reading it as a contact is how
    // every failure used to slip through.
    assert.match(branch, /prisma\.sentMessage\.findFirst\(\{ where: \{ providerMessageId: messageId \} \}/);
    assert.doesNotMatch(branch, /handleIncomingWhatsApp/);
  });

  it("non-bouncing signals answer 200 before any database read", () => {
    assert.match(branch, /if \(signal === null\) return NextResponse\.json\(\{ ok: true \}\)/);
    const earlyReturn = branch.indexOf("if (signal === null)");
    const firstRead = branch.indexOf("prisma.sentMessage.findFirst");
    assert.ok(earlyReturn < firstRead, "a delivered/sent callback must not touch the database");
  });

  it("writes the same three rows the email webhook writes, under the same guards", () => {
    assert.match(branch, /type: "BOUNCED",\s*channel: "WHATSAPP"/);
    assert.match(branch, /prisma\.enrollment\.update\(\{ where: \{ id: enrollmentId \}, data: \{ status: "BOUNCED" \} \}\)/);
    assert.match(branch, /const marked = priorContact \? statusAfterProviderSignal\(priorContact\.status, signal\) : null/);
    assert.match(branch, /if \(priorContact && marked\)/);
    // #60 idempotency gates the writes; #65 reverts cover all three of them.
    assert.match(branch, /if \(!activity\) return NextResponse\.json\(\{ ok: true \}\)/);
    assert.match(branch, /reverts\.push\(\(\) => prisma\.contact\.update/);
    assert.match(branch, /undoInboundSideEffect\(activity\.id, reverts\)/);
    const rowGate = branch.indexOf("if (!activity) return");
    const flip = branch.indexOf('data: { status: "BOUNCED" }');
    assert.ok(rowGate < flip, "a redelivered callback must not re-flip anything");
  });
});
