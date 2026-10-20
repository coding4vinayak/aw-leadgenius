// The ramp used to be theatre: `runWarmup` wrote "just checking in" QUEUED
// rows addressed to the workspace's own contacts — messages nothing sent, and
// a spam cannon if anything ever had — while the send gate ignored the stage
// entirely (an account at stage 0 could burn its full daily limit on day one).
// The fix splits the two honestly: `warmupDailyLimit` is the cap the sender
// gate enforces, and a pass only advances the stage. Both halves are pinned
// here — the arithmetic as a function, the wiring as comment-stripped source.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { warmupDailyLimit, WARMUP_MAX_STAGE, WARMUP_STEP_DAILY_SENDS } from "../../src/lib/warmup";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const warmupModule = source("../../src/lib/warmup.ts");
const engineModule = source("../../src/lib/sequence-engine.ts");

describe("warmupDailyLimit — the ramp as a send cap", () => {
  it("leaves the workspace's own limit alone when warmup is off", () => {
    assert.equal(warmupDailyLimit(200, false, 0), 200);
    assert.equal(warmupDailyLimit(200, false, 12), 200);
  });

  it("starts a warming account at 5 sends/day", () => {
    assert.equal(warmupDailyLimit(200, true, 0), 5);
    assert.equal(WARMUP_STEP_DAILY_SENDS, 5);
  });

  it("grows by one step for every nightly pass", () => {
    assert.equal(warmupDailyLimit(200, true, 1), 10);
    assert.equal(warmupDailyLimit(200, true, 5), 30);
    assert.equal(warmupDailyLimit(200, true, 19), 100);
  });

  it("hands the account its own daily limit once the ramp is over", () => {
    assert.equal(warmupDailyLimit(200, true, WARMUP_MAX_STAGE), 200);
    assert.equal(warmupDailyLimit(200, true, WARMUP_MAX_STAGE + 7), 200);
  });

  it("never raises a modest daily limit — the ramp only caps", () => {
    assert.equal(warmupDailyLimit(12, true, 10), 12);
    assert.equal(warmupDailyLimit(3, true, 0), 3);
  });

  it("treats a nonsense stage as the start, and a fractional one as its floor", () => {
    assert.equal(warmupDailyLimit(200, true, -3), 5);
    assert.equal(warmupDailyLimit(200, true, 2.9), 15);
  });
});

describe("a warmup pass writes no messages", () => {
  const run = /export async function runWarmup\([\s\S]*?\n\}/.exec(warmupModule)?.[0] ?? "";

  it("runWarmup only advances the stage", () => {
    assert.ok(run, "runWarmup is defined");
    assert.match(run, /warmupStage: \{ increment: 1 \}/);
  });

  it("the fake-message machinery and the dead pool are gone", () => {
    assert.doesNotMatch(warmupModule, /sentMessage/);
    assert.doesNotMatch(warmupModule, /WARMUP_POOL/);
    assert.doesNotMatch(warmupModule, /just checking in/);
  });
});

describe("the sender gate enforces the ramp", () => {
  it("selects senders through warmupDailyLimit, not raw dailyLimit", () => {
    const gate = /async function selectSendingAccount\([\s\S]*?\n\}/.exec(engineModule)?.[0] ?? "";
    assert.ok(gate, "selectSendingAccount is defined");
    assert.match(gate, /warmupDailyLimit\(/);
    assert.match(engineModule, /import \{[^}]*\bwarmupDailyLimit\b[^}]*\} from "\.\/warmup"/);
    assert.doesNotMatch(gate, /health\.dailySent < account\.dailyLimit/);
  });

  it("a blocked send records a retry time instead of stranding the enrollment", () => {
    const blocked = /if \(!sendingAccount\) \{[\s\S]*?throw new Error\(`No active sending account/.exec(engineModule)?.[0] ?? "";
    assert.ok(blocked, "the no-sender branch has its shape");
    assert.match(blocked, /nextActionAt: now/);
  });
});
