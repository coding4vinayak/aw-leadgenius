// The four `then` actions, the accepted condition names, and the write-time
// twin that refuses typos — pure, no server, no DB.
//
// Before the sweep this file guards, `then` was destructured into a variable
// nothing read: `{if: "no_reply", then: "end"}` sent the follow-up anyway and
// `branch` never branched. These cases are the behavior the README's "branch
// conditions" sentence actually sells.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conditionProblem, stepOutcome, type SequenceStepConfig, type StepFacts } from "../../src/lib/sequence-engine";

const step = (n: number, conditions?: SequenceStepConfig["conditions"]): SequenceStepConfig => ({
  stepNumber: n,
  channel: "EMAIL",
  delayDays: 0,
  delayHours: 0,
  ...(conditions ? { conditions } : {}),
});

const facts = (over: Partial<StepFacts> = {}): StepFacts => ({
  due: false,
  replied: false,
  opened: false,
  clicked: false,
  ...over,
});

describe("stepOutcome", () => {
  it("a step with no condition of its own is the calendar's", () => {
    assert.deepEqual(stepOutcome(step(1), "SENT", facts({ due: true })), { kind: "send" });
    assert.deepEqual(stepOutcome(step(1), "SENT", facts({ due: false })), { kind: "wait" });
  });

  it("no_reply sends the follow-up on the calendar tick, never on the SENT job", () => {
    const s = step(2, { if: "no_reply", then: "next" });
    assert.deepEqual(stepOutcome(s, "TIME_ELAPSED", facts()), { kind: "send" });
    assert.deepEqual(stepOutcome(s, "SENT", facts()), { kind: "wait" });
    assert.deepEqual(stepOutcome(s, "TIME_ELAPSED", facts({ replied: true })), { kind: "wait" });
  });

  it("then defaults to next when omitted", () => {
    assert.deepEqual(stepOutcome(step(2, { if: "no_reply" }), "TIME_ELAPSED", facts()), { kind: "send" });
  });

  it("end ends the enrollment instead of sending the guarded step", () => {
    assert.deepEqual(stepOutcome(step(2, { if: "no_reply", then: "end" }), "TIME_ELAPSED", facts()), { kind: "end" });
  });

  it("skip advances past the step without sending it", () => {
    assert.deepEqual(stepOutcome(step(2, { if: "no_reply", then: "skip" }), "TIME_ELAPSED", facts()), { kind: "skip" });
  });

  it("branch names a later step of the sequence", () => {
    assert.deepEqual(
      stepOutcome(step(2, { if: "no_reply", then: "branch", branchToStep: 4 }), "TIME_ELAPSED", facts()),
      { kind: "branch", stepNumber: 4 },
    );
  });

  it("refuses a backward, self, or missing branch target at run time — a loop is not a branch", () => {
    const backward = step(2, { if: "no_reply", then: "branch", branchToStep: 1 });
    assert.throws(() => stepOutcome(backward, "TIME_ELAPSED", facts()), /branchToStep must name a later step number/);
    const self = step(2, { if: "no_reply", then: "branch", branchToStep: 2 });
    assert.throws(() => stepOutcome(self, "TIME_ELAPSED", facts()), /later step/);
    const missing = step(2, { if: "no_reply", then: "branch" });
    assert.throws(() => stepOutcome(missing, "TIME_ELAPSED", facts()), /later step/);
  });

  it("event conditions fire on their own triggers, not on the calendar", () => {
    const replied = step(3, { if: "replied", then: "end" });
    assert.deepEqual(stepOutcome(replied, "REPLIED", facts()), { kind: "end" });
    assert.deepEqual(stepOutcome(replied, "TIME_ELAPSED", facts()), { kind: "wait" });
    assert.deepEqual(stepOutcome(step(3, { if: "clicked", then: "next" }), "CLICKED", facts()), { kind: "send" });
    assert.deepEqual(stepOutcome(step(3, { if: "bounced", then: "end" }), "BOUNCED", facts()), { kind: "end" });
  });

  it("refuses an unknown condition by naming the menu — the old default spent the step on any trigger", () => {
    assert.throws(
      () => stepOutcome(step(2, { if: "typo" as never, then: "next" }), "TIME_ELAPSED", facts()),
      /unknown condition "typo" \(allowed: no_reply, no_open, no_click, replied, bounced, clicked\)/,
    );
  });

  it("refuses an unknown action by naming the menu", () => {
    assert.throws(
      () => stepOutcome(step(2, { if: "no_reply", then: "weird" as never }), "TIME_ELAPSED", facts()),
      /unknown action "weird" \(allowed: next, skip, end, branch\)/,
    );
  });
});

// #124 — the else. An unsatisfied wait-condition used to mean WAIT FOREVER:
// `{if: "no_open", then: "end"}` ended the unread and PARKED the opened —
// ACTIVE, overdue, silent, no follow-up and no signal to anyone. "Nudge the
// readers, end the unread" was inexpressible on a product page that sells
// branch conditions. `elseThen` is the other half of the sentence, with two
// disciplines: only the sweep's TIME_ELAPSED tick consults it (an event
// receipt must not spend the step ahead of its calendar — a read at 8pm must
// not send tomorrow's nudge tonight), and no `elseThen` is exactly the old
// behavior, so every stored row keeps the sequence its author configured.
describe("elseThen (#124)", () => {
  it("runs the else on the calendar tick when the condition fails — and never over the satisfied branch", () => {
    const s = step(2, { if: "no_open", then: "end", elseThen: "next" });
    assert.deepEqual(stepOutcome(s, "TIME_ELAPSED", facts({ opened: true })), { kind: "send" });
    assert.deepEqual(stepOutcome(s, "TIME_ELAPSED", facts()), { kind: "end" });
  });

  it("skip and end are as available to the else as to the then", () => {
    assert.deepEqual(
      stepOutcome(step(2, { if: "no_reply", then: "next", elseThen: "skip" }), "TIME_ELAPSED", facts({ replied: true })),
      { kind: "skip" },
    );
    assert.deepEqual(
      stepOutcome(step(2, { if: "no_click", then: "next", elseThen: "end" }), "TIME_ELAPSED", facts({ clicked: true })),
      { kind: "end" },
    );
  });

  it("an event trigger never consults the else — the calendar owns the moment", () => {
    const s = step(2, { if: "no_open", then: "end", elseThen: "next" });
    assert.deepEqual(stepOutcome(s, "OPENED", facts({ opened: true })), { kind: "wait" });
    assert.deepEqual(stepOutcome(s, "DELIVERED", facts()), { kind: "wait" });
  });

  it("no elseThen means wait — the pre-#124 behavior, unchanged for every stored row", () => {
    const s = step(2, { if: "no_open", then: "end" });
    assert.deepEqual(stepOutcome(s, "TIME_ELAPSED", facts({ opened: true })), { kind: "wait" });
  });

  it("refuses an unknown elseThen at run time by naming the menu — rows outlive their validation", () => {
    assert.throws(
      () => stepOutcome(step(2, { if: "no_reply", then: "end", elseThen: "weird" as never }), "TIME_ELAPSED", facts({ replied: true })),
      /unknown elseThen "weird" \(allowed: next, skip, end\)/,
    );
  });

  it("conditionProblem accepts the else the engine can run", () => {
    const numbers = [1, 2, 3];
    assert.equal(conditionProblem({ stepNumber: 2, conditions: { if: "no_open", then: "end", elseThen: "next" } }, numbers), null);
    assert.equal(conditionProblem({ stepNumber: 2, conditions: { if: "no_reply", elseThen: "skip" } }, numbers), null);
  });

  it("refuses an else with no moment: an event condition has no else worth running", () => {
    assert.match(
      conditionProblem({ stepNumber: 2, conditions: { if: "replied", elseThen: "next" } }, [1, 2, 3])!,
      /elseThen only applies to the wait conditions \(no_reply, no_open, no_click\)/,
    );
  });

  it("refuses else actions outside the menu — no branch, because a second branchToStep vocabulary is not this round", () => {
    const numbers = [1, 2, 3];
    assert.match(
      conditionProblem({ stepNumber: 2, conditions: { if: "no_open", elseThen: "branch", branchToStep: 3 } }, numbers)!,
      /conditions\.elseThen must be one of next, skip, end/,
    );
    assert.match(
      conditionProblem({ stepNumber: 2, conditions: { if: "no_open", elseThen: "weird" } }, numbers)!,
      /elseThen must be one of next, skip, end/,
    );
  });
});

describe("conditionProblem (the write-time twin)", () => {
  const numbers = [1, 2, 3];

  it("passes the configurations the engine can honour", () => {
    assert.equal(conditionProblem({ stepNumber: 1 }, numbers), null);
    assert.equal(conditionProblem({ stepNumber: 2, conditions: { if: "no_reply", then: "next" } }, numbers), null);
    assert.equal(conditionProblem({ stepNumber: 2, conditions: { if: "replied" } }, numbers), null);
    assert.equal(conditionProblem({ stepNumber: 2, conditions: { if: "no_reply", then: "branch", branchToStep: 3 } }, numbers), null);
  });

  it("refuses typos by naming the accepted sets", () => {
    assert.match(conditionProblem({ stepNumber: 2, conditions: { if: "typo" } }, numbers)!, /conditions\.if must be one of no_reply, no_open, no_click, replied, bounced, clicked/);
    assert.match(conditionProblem({ stepNumber: 2, conditions: { if: "no_reply", then: "weird" } }, numbers)!, /conditions\.then must be one of next, skip, end, branch/);
  });

  it("refuses a branch target that is not a later step of this sequence", () => {
    assert.match(conditionProblem({ stepNumber: 2, conditions: { if: "no_reply", then: "branch" } }, numbers)!, /later step number/);
    assert.match(conditionProblem({ stepNumber: 2, conditions: { if: "no_reply", then: "branch", branchToStep: 1 } }, numbers)!, /later step/);
    assert.match(conditionProblem({ stepNumber: 2, conditions: { if: "no_reply", then: "branch", branchToStep: 9 } }, numbers)!, /names step 9, which this sequence does not have/);
    assert.match(conditionProblem({ stepNumber: 2, conditions: { if: "no_reply", branchToStep: 3 } }, numbers)!, /only applies when conditions\.then is "branch"/);
  });

  it("refuses conditions that are not an object", () => {
    assert.match(conditionProblem({ stepNumber: 1, conditions: ["no_reply"] }, numbers)!, /conditions must be an object/);
    assert.equal(conditionProblem({ stepNumber: 1, conditions: null }, numbers), null);
  });

  it("is what the sequences route consults, so a typo is a 400 and not a silently-spent step", () => {
    const route = readFileSync(new URL("../../src/app/api/sequences/route.ts", import.meta.url), "utf8");
    assert.match(route, /conditionProblem\(step, stepNumbers\)/);
    assert.match(route, /stepsConfig\[\$\{i\}\]: \$\{problem\}/);
  });
});
