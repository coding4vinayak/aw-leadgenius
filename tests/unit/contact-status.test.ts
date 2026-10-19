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
import { stopStatusForContact, statusAfterProviderSignal } from "../../src/lib/sequence-engine";

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
