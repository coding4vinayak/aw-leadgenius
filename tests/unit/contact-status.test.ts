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
import { stopStatusForContact } from "../../src/lib/sequence-engine";

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
