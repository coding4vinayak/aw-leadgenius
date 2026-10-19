// #125 — warmup that warms anything up at all.
//
// Three holes, same shape as everything else this suite has been prying out:
// (1) `runWarmup` wrote SentMessage rows claiming `QUEUED` and stopped there —
// no job, no sender, the vocabulary lying while `executeStep` next door had
// the queue call in the same breath as its insert; (2) the recipients were
// real ACTIVE workspace contacts — warmup mailed your own prospect list its
// "just checking in" filler, while WARMUP_POOL, the constant that names the
// addresses the tool is *supposed* to talk to, sat unreferenced (one of the
// repo's standing lint warnings); (3) non-email accounts were *attempted*
// through a lookup keyed on `[channel.toLowerCase()]`, and `whatsapp`/`linkedin`
// are not Contact fields — enabling warmup on them threw a Prisma validation
// error into the daily job. The plan math and the channel refusal are pure;
// the queueing, the pool, and the refusal ordering are read from source.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { warmupPlan, warmupChannelSupported, WARMUP_POOL } from "../../src/lib/warmup";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

describe("warmupPlan", () => {
  it("a stage-0 account sends nothing — the ramp starts at zero, not at one", () => {
    assert.equal(warmupPlan({ warmupStage: 0, dailyLimit: 100 }, 0), 0);
  });

  it("the ramp is five per stage", () => {
    assert.equal(warmupPlan({ warmupStage: 1, dailyLimit: 100 }, 0), 5);
    assert.equal(warmupPlan({ warmupStage: 4, dailyLimit: 100 }, 0), 20);
  });

  it("the day's remaining budget caps the ramp", () => {
    assert.equal(warmupPlan({ warmupStage: 3, dailyLimit: 100 }, 90), 10);
    assert.equal(warmupPlan({ warmupStage: 2, dailyLimit: 50 }, 50), 0);
  });

  it("an over-sent day plans zero, never a negative", () => {
    assert.equal(warmupPlan({ warmupStage: 2, dailyLimit: 50 }, 60), 0);
  });

  it("stage 20 is the ramp's ceiling — 100 per day at an open limit", () => {
    assert.equal(warmupPlan({ warmupStage: 20, dailyLimit: 1000 }, 0), 100);
    assert.equal(warmupPlan({ warmupStage: 25, dailyLimit: 1000 }, 0), 125);
  });
});

describe("warmupChannelSupported", () => {
  it("email is the channel with a reputation feedback loop here", () => {
    assert.equal(warmupChannelSupported("EMAIL"), true);
  });

  it("the others are refused rather than crashed into", () => {
    // `whatsapp: { not: null }` is not a Contact filter — the old lookup
    // reached Prisma with it and the daily job threw.
    assert.equal(warmupChannelSupported("WHATSAPP"), false);
    assert.equal(warmupChannelSupported("LINKEDIN"), false);
    assert.equal(warmupChannelSupported("MULTI"), false);
  });
});

describe("WARMUP_POOL", () => {
  it("is three distinct partner addresses and now actually read", () => {
    assert.equal(WARMUP_POOL.length, 3);
    assert.equal(new Set(WARMUP_POOL).size, 3);
    assert.ok(WARMUP_POOL.every((a) => a.endsWith("@warmup.leadgenius.io")));
  });
});

describe("runWarmup wires the rows it writes to the queue that sends them", () => {
  const warmup = source("../../src/lib/warmup.ts");

  it("every QUEUED insert is followed by the send-message job, in the same function — the executeStep shape", () => {
    const sender = /async function sendWarmupMessage\([\s\S]*?\n\}/.exec(warmup)?.[0] ?? "";
    const create = sender.indexOf('status: "QUEUED"');
    const queue = sender.indexOf('enqueue(queues.send, "send-message", { messageId: message.id })');
    assert.ok(create >= 0 && queue > create, "the row must be handed to the queue right after it is claimed queued");
  });

  it("a queue outage flips the row to FAILED with the outage's words and stops the run — a QUEUED with no job is the lie being removed", () => {
    assert.match(warmup, /QueueUnavailableError/);
    assert.match(warmup, /data: \{ status: "FAILED", error: `warmup queue unavailable: \$\{error\.message\}` \}/);
    const sender = /async function sendWarmupMessage\([\s\S]*?\n\}/.exec(warmup)?.[0] ?? "";
    assert.match(sender, /\n\s*throw error;/, "the caller must see the outage, not a completed run");
  });

  it("the recipients are the pool, and no call in the file lists workspace contacts any more", () => {
    assert.match(warmup, /for \(const email of WARMUP_POOL\)/);
    assert.match(warmup, /pool\[i % pool\.length\]/);
    assert.doesNotMatch(warmup, /prisma\.contact\.findMany/, "prospects left the picture entirely, not just the send");
  });

  it("pool rows are DO_NOT_CONTACT from source warmup — round 13's boundary refuses to enroll them into campaigns", () => {
    assert.match(warmup, /status: "DO_NOT_CONTACT"/);
    assert.match(warmup, /source: "warmup"/);
    assert.match(warmup, /where: \{ workspaceId_email: \{ workspaceId, email \} \}/, "the pool upserts on the workspace-unique, so re-runs never mint rows");
  });

  it("an unsupported channel returns before any pool or plan work", () => {
    const run = /export async function runWarmup\([\s\S]*?\n\}/.exec(warmup)?.[0] ?? "";
    const refuse = run.indexOf("warmupChannelSupported(account.channel)");
    const pool = run.indexOf("ensureWarmupPoolContacts");
    assert.ok(refuse >= 0 && pool > refuse, "the refusal must precede every write in the run");
  });

  it("the budget is measured against rows the worker already flipped to SENT", () => {
    assert.match(warmup, /getSentToday[\s\S]{0,200}status: "SENT"/);
  });
});
