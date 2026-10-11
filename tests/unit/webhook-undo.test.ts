// #65. When the inline `enqueue(queues.sequence, …)` throws after the Activity
// row has committed, the delivery's downstream side effect (the sequence step)
// is silently lost: a provider redelivery hits `recordInboundActivity`, gets
// `null` from the unique-insert gate, and skips. Row is right; step never runs.
//
// The fix is `undoInboundSideEffect` — a compensating write the route calls on
// the QueueUnavailableError catch so the redelivery can replay the whole shape
// rather than skip on the dedup.
//
// The guard reads the three routes and the lib as text. It is not a live probe
// of Redis-unavailable behaviour; that is the operations-console harness. What
// it pins is that the invariant survives a refactor: every route that answers
// 503 on the sequence enqueue must also roll back what it committed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const LIB = read("src/lib/activities.ts");
const LINKEDIN = read("src/app/api/webhooks/linkedin/route.ts");
const WHATSAPP = read("src/app/api/webhooks/whatsapp/route.ts");
const EMAIL = read("src/app/api/webhooks/email/route.ts");

describe("undoInboundSideEffect (#65)", () => {
  it("is exported as an async function taking an activity id and revert thunks", () => {
    assert.match(
      LIB,
      /export async function undoInboundSideEffect\s*\(\s*activityId:\s*string,\s*reverts:\s*Array<\(\)\s*=>\s*Promise<unknown>\s*>\s*,?\s*\)/,
    );
  });

  it("deletes the Activity row before the reverts run — the row is the redelivery's gate", () => {
    assert.match(LIB, /prisma\.activity\.delete\(\{\s*where:\s*\{\s*id:\s*activityId\s*\}\s*\}\)/);
  });

  it("runs every arm under Promise.allSettled, so a failed revert does not hide the queue error", () => {
    assert.match(LIB, /await Promise\.allSettled\(\s*tasks\s*\)/);
  });

  it("logs each rejected arm rather than swallowing it silently", () => {
    assert.match(LIB, /r\.status\s*===\s*"rejected"[\s\S]*console\.error/);
  });
});

for (const [name, src] of [
  ["linkedin", LINKEDIN],
  ["whatsapp", WHATSAPP],
  ["email", EMAIL],
] as const) {
  describe(`${name} route — commits-then-enqueues-then-undoes`, () => {
    it("imports undoInboundSideEffect from @/lib/activities", () => {
      assert.match(src, /import\s*\{[^}]*\bundoInboundSideEffect\b[^}]*\}\s*from\s*"@\/lib\/activities"/);
    });

    it("calls undoInboundSideEffect on the QueueUnavailableError catch of the sequence enqueue", () => {
      // The specific catch that reads `error instanceof QueueUnavailableError`
      // and returns `error.status` must be the same block that awaits the undo.
      // A revert added to a different catch, or after the return, is a revert
      // that never fires.
      assert.match(
        src,
        /catch\s*\(\s*error\s*\)\s*\{[\s\S]*?if\s*\(\s*error instanceof QueueUnavailableError\s*\)[\s\S]*?await undoInboundSideEffect\([\s\S]*?return NextResponse\.json\([\s\S]*?status:\s*error\.status/,
      );
    });

    it("passes activity.id to the undo, so the delete keys the row the route just committed", () => {
      assert.match(src, /undoInboundSideEffect\(\s*activity\.id\s*,/);
    });
  });
}

describe("email route — status reverts are captured BEFORE the writes", () => {
  // #65 is compensation-shaped: you cannot revert to a value you never read.
  // The email route writes both `sentMessage.status` and `enrollment.status`
  // inside the BOUNCED/COMPLAINED branch; the undo needs the pre-images, so the
  // pre-images have to be taken before the update, not inferred after it.
  it("reads the enrollment's prior status before flipping it", () => {
    const prior = EMAIL.indexOf("priorEnrollment = await prisma.enrollment.findUnique");
    const flip = EMAIL.indexOf('data: { status: activityType === "BOUNCED" ? "BOUNCED" : "UNSUBSCRIBED" }');
    assert.ok(prior > -1, "no priorEnrollment read on the email route — the enroll-status revert has no target");
    assert.ok(flip > -1, "email route no longer flips enrollment status; this test's premise is gone");
    assert.ok(prior < flip, "the enrollment status is flipped before it is read — the revert would restore the new value");
  });

  it("captures the sentMessage's prior status from the row it already has", () => {
    assert.match(EMAIL, /priorSentMessageStatus\s*=\s*sentMessage\.status/);
    const capture = EMAIL.indexOf("priorSentMessageStatus = sentMessage.status");
    const flip = EMAIL.indexOf("data: { status: activityType }");
    assert.ok(capture < flip, "the sentMessage status is flipped before it is captured");
  });

  it("pushes both reverts onto the array the catch hands to undoInboundSideEffect", () => {
    assert.match(EMAIL, /reverts\.push\(\s*\(\)\s*=>\s*prisma\.enrollment\.update/);
    assert.match(EMAIL, /reverts\.push\(\s*\(\)\s*=>\s*prisma\.sentMessage\.update/);
    assert.match(EMAIL, /undoInboundSideEffect\(\s*activity\.id\s*,\s*reverts\s*\)/);
  });

  it("OPENED/CLICKED deliveries carry no reverts but still undo the row", () => {
    // The reverts array is initialised outside the `if` branch, so the shape is
    // "empty array + row-delete", which is what the undo does for anything that
    // does not touch a status.
    assert.match(EMAIL, /const reverts:\s*Array<\(\)\s*=>\s*Promise<unknown>>\s*=\s*\[\s*\]/);
    assert.match(EMAIL, /if\s*\(\s*activityType === "BOUNCED" \|\| activityType === "COMPLAINED"\s*\)/);
  });
});
