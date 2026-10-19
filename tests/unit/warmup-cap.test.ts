// The cap's ledger (#27's gate, corrected): what counts as spent on a warming
// account's day. The arithmetic of the cap (`warmupDailyLimit`) is pinned in
// warmup.test.ts; this file pins the other half — the number it is compared
// against — which counted only rows the worker had already flipped to `SENT`,
// so a sweep tick could mint six "5/day" emails while five rows sat `QUEUED`,
// and every bounce webhook relabel took a row out of the count.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { capSpendTodayWhere } from "../../src/lib/warmup";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

describe("capSpendTodayWhere — the day's ledger", () => {
  it("is a whole local day of this account's rows, everything but a dispatch failure", () => {
    const now = new Date(2026, 6, 15, 14, 30, 0);
    const where = capSpendTodayWhere("acct-1", now);
    assert.equal(where.sendingAccountId, "acct-1");
    assert.deepEqual(where.createdAt, { gte: new Date(2026, 6, 15), lt: new Date(2026, 6, 16) });
    assert.deepEqual(where.NOT, { status: "FAILED" });
  });

  it("asks for a row that has not started the day yet as much as one ending it", () => {
    // QUEUED (job in flight, not flipped), BOUNCED/COMPLAINED/UNSUBSCRIBED
    // (an SMTP conversation completed and the provider relabeled the row) and
    // DELIVERED all spent the domain; only FAILED means nothing left.
    const { NOT } = capSpendTodayWhere("a", new Date(2026, 0, 1, 12));
    assert.equal(NOT.status, "FAILED");
    assert.notEqual(NOT.status, "SENT");
  });

  it("reads midnight from the clock it is given and does not move it", () => {
    const now = new Date(2026, 11, 31, 23, 59, 59);
    const before = now.getTime();
    const where = capSpendTodayWhere("a", now);
    assert.equal(now.getTime(), before);
    assert.equal(where.createdAt.gte.getTime(), new Date(2026, 11, 31).getTime());
    assert.equal(where.createdAt.lt.getTime(), new Date(2027, 0, 1).getTime());
  });
});

describe("the sender gate consults the ledger, not the worker's progress", () => {
  const engine = source("../../src/lib/sequence-engine.ts");
  const gate = /async function selectSendingAccount\([\s\S]*?\n\}/.exec(engine)?.[0] ?? "";

  it("counts through capSpendTodayWhere and compares the spent number to the cap", () => {
    assert.ok(gate, "selectSendingAccount is defined");
    assert.match(gate, /capSpendTodayWhere\(account\.id/);
    assert.match(gate, /spent < cap/);
    assert.match(engine, /import \{ warmupDailyLimit, capSpendTodayWhere \} from "\.\/warmup"/);
  });

  it("the SENT-only health copy is gone from the engine — one ledger, one definition", () => {
    assert.doesNotMatch(engine, /async function getEmailAccountHealth/);
    assert.doesNotMatch(engine, /health\.dailySent/);
  });

  it("still reads reputation from the account row it already has — through the named floor", () => {
    // #31 wrote this against the bare `50`; #32's stack renamed the number,
    // and the guard was widened exactly like the import guard above was —
    // the intent was always "the row's own score, compared to the floor".
    assert.match(gate, /account\.reputationScore > REPUTATION_FLOOR/);
  });
});
