// N1, same helper in every app because the apps are standalone: `page=0` used
// to reach Prisma as a negative `skip` and `page=abc` as NaN, both of which
// throw (a 500 for a mistyped URL), and `limit=999999999` was the full-table
// read that pagination exists to prevent.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { intParam, pageParams } from "../../src/lib/pagination";

const params = (query: Record<string, string>) => new URLSearchParams(query);

describe("page and limit are bounded by the server", () => {
  it("defaults to the first page at the route's own page size", () => {
    assert.deepEqual(pageParams(new URLSearchParams(""), 50), { page: 1, limit: 50 });
  });

  it("refuses to ask for the whole table", () => {
    assert.equal(pageParams(params({ limit: "999999999" }), 20).limit, 100);
  });

  it("treats a zero or negative page as the first page, not as a negative skip", () => {
    for (const page of ["0", "-4"]) assert.equal(pageParams(params({ page }), 20).page, 1, page);
  });

  it("treats a non-numeric or zero limit as the default, never as NaN or take:0", () => {
    for (const limit of ["abc", "", "0", "-1", "  "]) {
      assert.equal(pageParams(params({ limit }), 20).limit, 20, JSON.stringify(limit));
    }
  });
});

describe("the analytics window is bounded", () => {
  it("days=abc used to make an Invalid Date, which Prisma rejects", () => {
    assert.equal(intParam(params({ days: "abc" }), "days", 30, 1, 365), 30);
    assert.equal(intParam(params({ days: "-1" }), "days", 30, 1, 365), 30);
    assert.equal(intParam(params({ days: "99999" }), "days", 30, 1, 365), 365, "clamped, not refused");
    assert.equal(intParam(params({ days: "7" }), "days", 30, 1, 365), 7);
  });
});
