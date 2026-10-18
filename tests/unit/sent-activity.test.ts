// The gap the attribution demo walked into: `sent` in both analytics engines
// only ever counted Activity rows, and the only Activity writers were the
// provider webhooks — so a workspace whose provider never posts
// sent/accepted/processed events showed `sent: 0` on days with real traffic.
// The fix is in two halves, and both are guards read from comment-stripped
// source: the send worker records its own SENT row (keyed on the message,
// no provider timestamp exists at send time), and the email webhook reads for
// that row before inserting, so a provider that *does* post sent events
// corroborates instead of double-counting.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activityIdempotencyKey } from "../../src/lib/activities";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const worker = source("../../src/lib/queue.ts");
const emailRoute = source("../../src/app/api/webhooks/email/route.ts");

describe("the send worker records its own SENT activity", () => {
  it("writes through the idempotency gate, never a bare create", () => {
    assert.match(worker, /recordInboundActivity\(/);
    assert.doesNotMatch(worker, /prisma\.activity\.create/);
  });

  // `providerRef` is the provider's id when the channel returned one and the
  // message id when it did not — either way it is the same string the webhook
  // will carry back, which is what the double-count guard joins on.
  it("keys on channel, message and type — no provider timestamp exists at send time", () => {
    assert.match(
      worker,
      /activityIdempotencyKey\(\{ channel: msg\.channel, messageId: providerRef, activityType: "SENT" \}\)/,
    );
    const k = activityIdempotencyKey({ channel: "EMAIL", messageId: "m1", activityType: "SENT" });
    assert.equal(k, activityIdempotencyKey({ channel: "EMAIL", messageId: "m1", activityType: "SENT" }));
    assert.match(k, /:no-ts$/);
  });

  // The hazard that makes this the load-bearing line: a throw here fails the
  // job, and a retried send job re-sends the prospect's email.
  it("best-effort: the record sits in its own try, outside the enqueue that may fail the job", () => {
    assert.match(worker, /SENT activity not recorded for message/);
    const recordStart = worker.indexOf("const providerRef");
    const enqueueStart = worker.indexOf('enqueue(queues.sequence, "process-step"', recordStart);
    assert.ok(recordStart > 0 && enqueueStart > recordStart, "own-record must precede the sequence enqueue");
    assert.ok(worker.slice(recordStart, enqueueStart).includes("catch"), "own-record is guarded");
  });

  it("feeds the day's rollup with the row it just wrote", () => {
    assert.match(worker, /enqueueDailyRollup\(msg\.enrollmentId, activity\.createdAt\)/);
  });

  // Retry of the same job: findFirst sees the row (or the gate's P2002 does),
  // so one send yields exactly one SENT activity.
  it("reads before writing so a retried job cannot add a second row", () => {
    assert.match(
      worker,
      /where: \{ enrollmentId: msg\.enrollmentId, type: "SENT", messageId: providerRef \}/,
    );
    assert.match(worker, /if \(!known\)/);
  });
});

describe("the email webhook corroborates, never double-counts, a SENT", () => {
  it("guards the insert on the worker's own row before the gate sees it", () => {
    assert.match(emailRoute, /if \(activityType === "SENT"\)/);
    assert.match(
      emailRoute,
      /where: \{ enrollmentId: sentMessage\.enrollmentId, type: "SENT", messageId \}/,
    );
    assert.match(emailRoute, /if \(already\) continue;/);
  });

  // The guard covers SENT only — opens, clicks and bounces remain genuine
  // provider-derived events, counted the same way #60 made them idempotent.
  it("leaves every non-SENT event to the existing gate", () => {
    const guard = emailRoute.indexOf('if (activityType === "SENT")');
    const record = emailRoute.indexOf("recordInboundActivity(");
    assert.ok(guard > 0 && record > guard, "SENT guard sits before the insert, not around other types");
    assert.match(emailRoute, /if \(!activity\)\s*continue;/);
  });
});
