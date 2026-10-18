// The A/B writer round. Attribution's `byVariant` was honestly empty because
// nothing in the product could create an ABTest or set `Enrollment.abVariantId`
// — the schema modeled the whole feature and no code used it. Two pure halves
// carry the risk here: the arm assignment (must be deterministic per
// (test, contact) or a retried enroll contaminates the cohorts) and the
// cross-entry semantics (weights summing to 100 and exactly one control are
// what make "which copy won" a defined question). Distribution numbers below
// are measured, not vibes — sha256 is deterministic, so asserting the exact
// split of a fixed id set is a stable regression test for the bucketing math.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assignVariant, validateAbTestSemantics, type AbTestVariantInput } from "../../src/lib/abtest";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const V50 = [
  { id: "a", name: "control", weight: 50, sequenceId: "s1" },
  { id: "b", name: "two_ideas", weight: 50, sequenceId: "s2" },
];
const V8020 = [
  { id: "c", name: "control", weight: 80, sequenceId: "s1" },
  { id: "d", name: "two_ideas", weight: 20, sequenceId: "s2" },
];

describe("assignVariant is an assignment, not a draw", () => {
  const ids = [...Array(2000)].map((_, i) => `contact${i}`);

  // The property the whole feature rests on: 100 calls for one (test, contact)
  // yield one arm. A `Math.random()` draw satisfies nothing here.
  it("never moves a contact between arms across repeated calls", () => {
    for (const id of ["contact0", "contact41", "contact1999"]) {
      const arms = new Set(Array.from({ length: 100 }, () => assignVariant("t3", id, V50)!.name));
      assert.equal(arms.size, 1);
    }
  });

  // Measured exact values for this fixed id set (sha256 is stable across
  // processes; if the hash input format ever changes, this test says so).
  it("splits 50/50 measured: 985 control on 2000 ids", () => {
    let control = 0;
    for (const id of ids) if (assignVariant("test1", id, V50)!.name === "control") control++;
    assert.equal(control, 985);
  });

  it("splits 80/20 measured: 1593 control on the same ids", () => {
    let control = 0;
    for (const id of ids) if (assignVariant("test2", id, V8020)!.name === "control") control++;
    assert.equal(control, 1593);
  });

  // The abTestId salt: the same contact must not be welded to the same arm
  // across unrelated tests, or the campaigns' cohorts correlate forever.
  it("salts per test so cohorts are independent", () => {
    let diff = 0;
    for (const id of ids) {
      if (assignVariant("t1", id, V50)!.name !== assignVariant("t2", id, V50)!.name) diff++;
    }
    assert.equal(diff, 987);
  });

  it("returns null for an empty variant list", () => {
    assert.equal(assignVariant("t", "c", []), null);
  });

  it("carries the arm's sequence — the override the enroll route applies", () => {
    const chosen = assignVariant("test1", "contact13", V50)!;
    assert.ok(["s1", "s2"].includes(chosen.sequenceId));
  });
});

describe("validateAbTestSemantics guards what makes the comparison defined", () => {
  const test = { campaignId: "camp1", name: "Opening line", hypothesis: "A question earns more replies" };
  const v = (over: Partial<AbTestVariantInput> = {}): AbTestVariantInput => ({ name: "two_ideas", weight: 50, isControl: false, sequenceId: "s2", ...over });

  it("accepts the shape the create route forwards", () => {
    const r = validateAbTestSemantics(test, [{ name: "control", weight: 50, isControl: true, sequenceId: "s1" }, v()]);
    assert.equal(r.ok, true);
  });

  it("rejects weights that do not sum to 100 — and says the sum", () => {
    const r = validateAbTestSemantics(test, [{ name: "control", weight: 70, isControl: true, sequenceId: "s1" }, v()]);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /sum to 100, got 120/);
  });

  it("rejects duplicate names — attribution groups by name", () => {
    const r = validateAbTestSemantics(test, [{ name: "control", weight: 50, isControl: true, sequenceId: "s1" }, v({ name: "control" })]);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /unique/);
  });

  it("requires exactly one control", () => {
    const two = validateAbTestSemantics(test, [
      { name: "control", weight: 50, isControl: true, sequenceId: "s1" },
      v({ isControl: true }),
    ]);
    assert.equal(two.ok, false);
    const none = validateAbTestSemantics(test, [
      { name: "control", weight: 50, isControl: false, sequenceId: "s1" },
      v(),
    ]);
    assert.equal(none.ok, false);
    assert.match((none as { error: string }).error, /got 0/);
  });
});

describe("the routes wire the pieces the unit cannot see", () => {
  const enroll = source("../../src/app/api/enrollments/route.ts");
  const create = source("../../src/app/api/abtests/route.ts");
  const fields = source("../../src/lib/fields.ts");

  it("the enroll route assigns through the pure function and persists the arm", () => {
    assert.match(enroll, /assignVariant\(test\.id, contactId, test\.variants\)/);
    assert.match(enroll, /abVariantId = chosen\.id/);
    assert.match(enroll, /sequenceId: armSequenceId/);
    assert.match(enroll, /abVariant: \{ select: \{ name: true, isControl: true \} \}/);
  });

  it("the enroll route reads only a RUNNING test of the campaign's workspace", () => {
    assert.match(enroll, /where: \{ campaignId, workspaceId, status: "RUNNING" \}/);
    assert.match(enroll, /orderBy: \{ startedAt: "asc" \}/);
    assert.match(enroll, /variants: \{ orderBy: \{ name: "asc" \} \}/);
  });

  it("the create route validates on the declared tables, 2..10 variants", () => {
    assert.match(create, /validateBody\(body, ABTEST_CREATE\)/);
    assert.match(create, /validateItems<AbTestVariantInput>\(body\.variants, "variants", ABTEST_VARIANT, \{ required: true, min: 2, max: 10 \}\)/);
    assert.match(create, /validateAbTestSemantics\(input\.data, items\.items\)/);
    assert.match(fields, /weight: \{ kind: "int", required: true, min: 1, max: 100 \}/);
  });

  it("the create route is auth-scoped and validates ownership before writing", () => {
    assert.match(create, /const workspaceId = await authedWorkspaceId\(request, body\.workspaceId\)/);
    assert.match(create, /campaign\.findFirst\(\{ where: \{ id: campaignId, workspaceId \} \}/);
    assert.match(create, /where: \{ id: variant\.sequenceId, workspaceId \}/);
    assert.match(create, /where: \{ id: variant\.templateId, workspaceId \}/);
    assert.match(create, /status: "RUNNING"/);
    assert.doesNotMatch(create, /workspaceId: body\.workspaceId/);
  });
});

describe("the sequence engine renders the arm's template, not a silent fallback", () => {
  const engine = source("../../src/lib/sequence-engine.ts");

  it("the step's enrollment read carries the variant's template", () => {
    assert.match(engine, /abVariant: \{ select: \{ name: true, templateId: true \} \}/);
    assert.match(engine, /abVariant: \{ name: string; templateId: string \| null \} \| null;/);
  });

  // The accepted-but-ignored gap this round closes: a variant template must win
  // over the step's, and the persisted message must record the template it was
  // actually rendered from — the audit row cannot cite the step's copy.
  it("the arm template overrides the step template and is the one recorded", () => {
    assert.match(engine, /const templateId = enrollment\.abVariant\?\.templateId \?\? step\.templateId/);
    assert.match(engine, /template = templateId \? await prisma\.template\.findUnique/);
    assert.match(engine, /templateId,\n      channel: step\.channel/);
  });

  // Falling back would hand the arm the control's copy and convert its cohort
  // without anyone noticing. The send stops and names the arm.
  it("a vanished arm template refuses the send by name instead of falling back", () => {
    assert.match(engine, /if \(enrollment\.abVariant\?\.templateId && !template\)/);
    assert.match(engine, /arm "\$\{enrollment\.abVariant\.name\}" points at a template that no longer exists/);
  });

  it("an arm without a template still renders the step's", () => {
    assert.match(engine, /\?\? step\.templateId/);
    assert.doesNotMatch(engine, /templateId = enrollment\.abVariant\?\.templateId \|\| step\.templateId/);
  });
});
