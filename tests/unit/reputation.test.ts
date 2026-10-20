// The floor was arithmetic against a frozen number: `reputationScore` is
// read by the sender gate and shown in the health panel, but nothing in the
// live app wrote it — no route, no worker, no job — so every account sat at
// its schema default of 100 and the "reputation floors" the README and the
// onboarding email sell could never refuse anything. This round derives the
// score from the ledger the #31 round made honest, on the events that change
// it and on a throttled calendar pass.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  reputationFrom,
  reputationLedgerWhere,
  reputationWindowWhere,
  reputationWindowStart,
  reputationRefreshDue,
  REPUTATION_FLOOR,
  REPUTATION_WINDOW_DAYS,
  REPUTATION_REFRESH_MINUTES,
} from "../../src/lib/reputation";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

describe("reputationFrom — the deliverability rate, as arithmetic", () => {
  it("an empty ledger is a perfect score: a new account did nothing wrong", () => {
    assert.equal(reputationFrom(0, 0, 0), 100);
    assert.equal(reputationFrom(-5, 0, 0), 100);
  });

  it("a clean window stays 100 and the floor is the named 50", () => {
    assert.equal(reputationFrom(100, 0, 0), 100);
    assert.equal(REPUTATION_FLOOR, 50);
    assert.equal(REPUTATION_WINDOW_DAYS, 14);
  });

  it("bounces cost 1 point, complaints cost 3: the dead address is the list's problem, the complaint is the domain's", () => {
    assert.equal(reputationFrom(100, 1, 0), 99);
    assert.equal(reputationFrom(100, 0, 1), 97);
    assert.equal(reputationFrom(100, 2, 1), 95);
    assert.equal(reputationFrom(10, 1, 0), 90);
    assert.equal(reputationFrom(10, 0, 1), 70);
  });

  it("the floor is crossed at 17 weighted hurts per hundred, and never below it by arithmetic accident", () => {
    assert.equal(reputationFrom(100, 17, 0), 83);
    assert.equal(reputationFrom(100, 40, 0), 60);
    assert.equal(reputationFrom(100, 41, 0), 59);
    // 50 deliverable, 25 bounces + 9 complaints = 52 weighted > the window:
    // the rate cannot go negative; it clamps at zero.
    assert.equal(reputationFrom(50, 25, 9), 0);
    assert.equal(reputationFrom(3, 2, 1), 0);
  });

  it("rounds to the whole point the column and the UI already speak", () => {
    assert.equal(reputationFrom(7, 1, 0), 86); // 100 - 100/7 = 85.71…
    assert.equal(reputationFrom(3, 1, 0), 67); // 66.67 rounds up
  });
});

describe("the window — one definition, shared with the cap ledger", () => {
  it("is the account's rows since now minus 14 days, same NOT-FAILED vocabulary as #31", () => {
    const now = new Date(2026, 6, 15, 14, 30, 0);
    assert.deepEqual(reputationWindowWhere("acct-1", now), {
      sendingAccountId: "acct-1",
      createdAt: { gte: new Date(2026, 6, 1, 14, 30, 0) },
    });
    assert.equal(REPUTATION_WINDOW_DAYS, 14);
  });

  it("does not mutate the clock it is handed", () => {
    const now = new Date(2026, 6, 15, 14, 30, 0);
    const before = now.getTime();
    reputationWindowWhere("acct-1", now);
    reputationWindowStart(now);
    assert.equal(now.getTime(), before);
  });

  it("the unscoped start and the per-account window are the same edge — the batch pass and the event recompute cannot drift", () => {
    const now = new Date(2026, 6, 15, 14, 30, 0);
    assert.equal(reputationWindowStart(now).getTime(), reputationWindowWhere("acct-1", now).createdAt.gte.getTime());
  });
});

describe("the throttle — calendar recovery for an account the floor has gated out", () => {
  it("a cold start passes at once", () => {
    assert.equal(reputationRefreshDue(new Date(2026, 6, 15, 14, 30, 0), null), true);
  });

  it("waits the full window, to the minute", () => {
    const now = new Date(2026, 6, 15, 14, 30, 0);
    assert.equal(reputationRefreshDue(now, new Date(now.getTime() - (REPUTATION_REFRESH_MINUTES - 1) * 60_000)), false);
    assert.equal(reputationRefreshDue(now, new Date(now.getTime() - REPUTATION_REFRESH_MINUTES * 60_000)), true);
    assert.equal(REPUTATION_REFRESH_MINUTES, 15);
  });
});

describe("the ledger events drive the score — one writer, and it is the derivation", () => {
  const reputation = source("../../src/lib/reputation.ts");
  const engine = source("../../src/lib/sequence-engine.ts");
  const queue = source("../../src/lib/queue.ts");
  const emailHook = source("../../src/app/api/webhooks/email/route.ts");
  const whatsappHook = source("../../src/app/api/webhooks/whatsapp/route.ts");
  const scheduler = source("../../src/lib/scheduler.ts");

  it("the score is written ONLY where the ledger is read — no third definition of reputation exists", () => {
    // An update writes `data: { reputationScore: … }`; a read passes it in
    // select/orderBy. The guard wants the first shape absent, not the word.
    assert.match(reputation, /data: \{ reputationScore: reputationFrom\(/);
    for (const [name, file] of [["engine", engine], ["queue", queue], ["email hook", emailHook], ["whatsapp hook", whatsappHook]] as const) {
      assert.doesNotMatch(file, /data: \{[^}]*reputationScore/, `${name} must not invent a score`);
    }
  });

  it("the send worker recomputes after the flip, and a missed recompute never re-sends the message", () => {
    assert.match(queue, /import \{[^}]*\brecomputeAccountReputation\b[^}]*\} from "\.\/reputation"/);
    const flip = queue.indexOf('status: result.success ? "SENT" : "FAILED"');
    const recompute = queue.indexOf("await recomputeAccountReputation(");
    assert.ok(flip >= 0 && recompute > flip, "the row lands before the score reads it");
    const call = queue.slice(recompute - 20, recompute + 200);
    assert.match(call, /try \{[\s\S]*?recomputeAccountReputation[\s\S]*?catch/);
  });

  it("both provider webhook doors recompute after their relabel, and the undo path leaves the old score correct", () => {
    for (const hook of [emailHook, whatsappHook]) {
      assert.match(hook, /import \{[^}]*\brecomputeAccountReputation\b[^}]*\} from "@\/lib\/reputation"/);
      assert.match(hook, /await recomputeAccountReputation\(sentMessage\.sendingAccountId\)/);
    }
    assert.ok(emailHook.indexOf('data: { status: activityType }') < emailHook.indexOf("await recomputeAccountReputation("), "email: relabel first, score after");
    assert.ok(whatsappHook.indexOf('data: { status: "BOUNCED" }') < whatsappHook.indexOf("await recomputeAccountReputation("), "whatsapp: relabel first, score after");
  });

  it("the sweep carries the calendar pass, throttled and isolated from the cadence it serves", () => {
    assert.match(scheduler, /import \{[^}]*refreshAllReputations[^}]*\} from "\.\/reputation"/);
    assert.match(scheduler, /if \(reputationRefreshDue\(now, lastReputationRefresh\)\)/);
    const pass = scheduler.slice(scheduler.indexOf("if (reputationRefreshDue"));
    assert.match(pass, /lastReputationRefresh = now;[\s\S]*?try \{[\s\S]*?refreshAllReputations\(now\)[\s\S]*?catch/);
    assert.ok(scheduler.indexOf("reputationRefreshDue") < scheduler.indexOf("const due ="), "the pass runs before the due-scan work");
  });

  it("the batch pass counts once over every account, not a query per row", () => {
    assert.match(reputation, /prisma\.sentMessage\.groupBy\(\{[\s\S]*?by: \["sendingAccountId", "status"\]/);
    assert.match(reputation, /if \(row\.status !== "FAILED"\) t\.deliverable/);
  });

  it("the window's two readings are one vocabulary — deliverable means NOT FAILED, here and in the cap", () => {
    assert.deepEqual(reputationLedgerWhere("acct-1", new Date(2026, 6, 15)), {
      sendingAccountId: "acct-1",
      createdAt: { gte: new Date(2026, 6, 1) },
      NOT: { status: "FAILED" },
    });
    const email = source("../../src/lib/channels/email.ts");
    assert.match(email, /import \{[^}]*reputationLedgerWhere[^}]*\} from "\.\.\/reputation"/);
    assert.doesNotMatch(email, /complaints: 0/, "the panel does not print a hardcoded zero beside a real score");
    assert.doesNotMatch(email, /status: "SENT" \}/, "the panel is not a second SENT-only definition of a send");
    assert.match(email, /account\?\.reputationScore \?\? 100/, "a clamped 0 displays as 0, not as perfect");
  });
});
