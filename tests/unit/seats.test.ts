// #111 — the seat meter, tested as the arithmetic it is.
//
// `seatDecision` and `seatSummary` are pure, so the limit gets real assertions
// over real numbers rather than a source-shape reading of them. What is checked
// as source is only the part that cannot run without a database: that the invite
// path actually asks the meter, and that the number it asks for is written by
// the sync that owns it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seatDecision, seatSummary } from "../../src/lib/seats";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const invites = source("../../src/lib/invites.ts");
const stripe = source("../../src/lib/stripe.ts");
const page = source("../../src/app/members/page.tsx");

describe("seatDecision", () => {
  it("lets a workspace invite while a seat is left", () => {
    assert.deepEqual(seatDecision({ cap: 3, used: 0 }), { allowed: true });
    assert.deepEqual(seatDecision({ cap: 3, used: 2 }), { allowed: true });
  });

  it("refuses at the cap, which is the count the invoice carries", () => {
    const decision = seatDecision({ cap: 3, used: 3 });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.match(decision.error, /^All 3 paid seats are taken or already invited/);
  });

  it("refuses past the cap too — a team that grew while the number was unknown", () => {
    const decision = seatDecision({ cap: 1, used: 4 });
    assert.equal(decision.allowed, false);
  });

  it("fails open when there is no known number, because an absent column is not a zero", () => {
    // The alternative locks a paying team out of inviting anyone the first time
    // this runs against a Subscription row written before the column existed.
    assert.deepEqual(seatDecision({ cap: null, used: 40 }), { allowed: true });
  });

  it("names the upgrade in the refusal, not just the refusal", () => {
    const decision = seatDecision({ cap: 2, used: 2 });
    assert.ok(!decision.allowed);
    assert.match(decision.error, /priced per user/i);
    assert.match(decision.error, /billing portal/i);
  });

  it("agrees with itself when the plan is a single seat", () => {
    const one = seatDecision({ cap: 1, used: 1 });
    const five = seatDecision({ cap: 5, used: 5 });
    assert.ok(!one.allowed && !five.allowed);
    assert.match(one.error, /The only paid seat is taken/);
    assert.doesNotMatch(one.error, /All 1 paid seat/);
    assert.match(five.error, /All 5 paid seats are taken/);
  });
});

describe("seatSummary", () => {
  it("says nothing when there is no plan number to compare against", () => {
    assert.equal(seatSummary({ cap: null, used: 7 }), null);
  });

  it("counts what is open while there is room", () => {
    assert.equal(seatSummary({ cap: 5, used: 2 }), "2 of 5 paid seats taken, 3 are still open.");
    assert.equal(seatSummary({ cap: 5, used: 4 }), "4 of 5 paid seats taken, 1 is still open.");
  });

  it("turns amber at the cap and points at the next seat", () => {
    assert.match(seatSummary({ cap: 3, used: 3 }) ?? "", /the next person needs another seat/);
  });

  it("admits an over-cap team rather than rounding it away", () => {
    const line = seatSummary({ cap: 2, used: 5 }) ?? "";
    assert.match(line, /5 of 2 paid seats are taken/);
    assert.match(line, /invoice is short 3 seats/);
    assert.match(seatSummary({ cap: 2, used: 3 }) ?? "", /short 1 seat\.$/);
  });

  it("never disagrees with the check that enforces the same number", () => {
    for (const usage of [{ cap: 3, used: 2 }, { cap: 3, used: 3 }, { cap: 3, used: 4 }]) {
      const allowed = seatDecision(usage).allowed;
      const line = seatSummary(usage) ?? "";
      if (allowed) assert.doesNotMatch(line, /needs another seat|short \d/);
      else assert.match(line, /needs another seat|short \d/, `over-cap copy must say so: ${line}`);
    }
  });
});

describe("the meter is on the path that spends a seat", () => {
  it("asks the meter before a brand-new invitation is written", () => {
    assert.match(invites, /seatDecision\(await seatUsage\(input\.workspaceId, now\)\)/);
    assert.match(invites, /if \(!seat\.allowed\) return \{ ok: false, error: seat\.error \};/);
  });

  it("asks after the rotation branch, so re-sending a link costs nothing", () => {
    const rotate = invites.indexOf("rotated: true");
    const check = invites.indexOf("seatDecision(");
    const create = invites.indexOf("prisma.invite.create");
    assert.ok(rotate > 0 && check > rotate, "a rotated link already counted as a seat");
    assert.ok(check < create, "and a new one is checked before it is written");
  });
});

describe("the number comes from the invoice", () => {
  it("stores the line-item quantity on every sync branch", () => {
    assert.match(stripe, /const seats = typeof item\?\.quantity === "number" \? item\.quantity : null;/);
    assert.equal((stripe.match(/stripeSeats: seats,/g) ?? []).length, 2, "update and create both write it");
  });

  it("has a column to store it in, backed by committed migration SQL", () => {
    const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
    assert.match(schema, /stripeSeats\s+Int\?/);
    // Reads every committed migration, not one dated file: the history was
    // consolidated into a single Postgres init (chore/postgres), and a future
    // reshape must not silently drop the column's only executable proof.
    const dir = fileURLToPath(new URL("../../prisma/migrations", import.meta.url));
    const sql = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readFileSync(join(dir, entry.name, "migration.sql"), "utf8"))
      .join("\n");
    assert.match(sql, /"stripeSeats" INTEGER/);
  });

  it("only meters a workspace that is actually billed", () => {
    const seats = source("../../src/lib/seats.ts");
    assert.match(seats, /SUBSCRIPTION_STATUS_ACTIVE as readonly string\[\]\)\.includes\(subscription\.status\)/);
    assert.match(seats, /\? subscription\.stripeSeats\n\s*: null/);
    assert.doesNotMatch(seats, /stripeSeats \?\? 0/, "an unknown cap stays unknown, never a zero");
  });

  it("shows the count where the owner is about to invite", () => {
    assert.match(page, /seatSummary\(seats\)/);
    assert.match(page, /seatUsage\(session\.workspaceId\)/);
    assert.match(page, /ManageBillingButton/);
  });
});
