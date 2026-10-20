// `ABTest.trafficSplit` is commented `// e.g., {"control": 50, "variant_a": 50}`,
// filled by the create route from the arm rows in the same statement, and served to
// the buyer by `GET /api/campaigns/[id]` — while nothing in the product read it:
// `assignVariant` buckets on `ABTestVariant.weight` and `validateAbTestSemantics`
// sums those same rows, so the reported split and the operating one were two copies
// of a number with no check between them. #26 made a column mean what another field
// says of it; this round makes a column mean what the SAME number says in its two
// other places — the arms it was copied from, and the cohorts the assignment
// actually filled. Both are asked at the completion door, the only place the promise
// is made: naming a winner claims these cohorts were the declared split.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cohortProblem,
  cohortProblems,
  cohortZ,
  declareSplit,
  declaredSplit,
  MIN_EXPECTED,
  SRM_Z,
  type ArmCohort,
  type SplitArm,
} from "../../src/lib/traffic-split";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const mod = source("../../src/lib/traffic-split.ts");
const create = source("../../src/app/api/abtests/route.ts");
const patch = source("../../src/app/api/abtests/[id]/route.ts");
const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");

const HALF = [
  { name: "ledger", weight: 50 },
  { name: "margin", weight: 50 },
] satisfies SplitArm[];
const SPLIT = declareSplit(HALF);
const cohort = (name: string, count: number): ArmCohort => ({ name, count });
const cohorts = (a: number, b: number): ArmCohort[] => [cohort("ledger", a), cohort("margin", b)];

/**
 * The standard normal CDF by Simpson's rule, computed HERE rather than imported:
 * the module states its alarm line as a two-sided 0.1% point, and the only way
 * that claim is checkable instead of asserted is for the test to integrate the
 * density and disagree with the constant if it is wrong.
 */
function normalCdf(x: number, steps = 100_000): number {
  const density = (t: number) => Math.exp(-(t * t) / 2) / Math.sqrt(2 * Math.PI);
  const h = x / steps;
  let sum = density(0) + density(x);
  for (let i = 1; i < steps; i += 1) sum += density(i * h) * (i % 2 === 1 ? 4 : 2);
  return 0.5 + (h / 3) * sum;
}

describe("declareSplit is the shape the promise takes", () => {
  it("keys the arms by name and carries their weights", () => {
    assert.deepEqual(SPLIT, { ledger: 50, margin: 50 });
    assert.deepEqual(declareSplit([{ name: "only", weight: 100 }]), { only: 100 });
  });

  it("has nothing to say about no arms", () => {
    assert.deepEqual(declareSplit([]), {});
  });

  it("is keyed by name, not by position — the same key attribution groups by", () => {
    const reordered = declareSplit([{ name: "margin", weight: 50 }, { name: "ledger", weight: 50 }]);
    assert.deepEqual(Object.keys(reordered).sort(), Object.keys(SPLIT).sort());
    assert.equal(reordered["ledger"], 50);
  });
});

describe("declaredSplit: the copy against the rows it was copied from", () => {
  it("hands back the split when the copy says what every arm says", () => {
    const read = declaredSplit(SPLIT, HALF);
    assert.equal(read.ok, true);
    if (read.ok) assert.equal(read.split["ledger"], 50);
  });

  it("refuses a number that moved, naming the arm and both copies", () => {
    const read = declaredSplit({ ledger: 40, margin: 50 }, HALF);
    assert.equal(read.ok, false);
    if (!read.ok) {
      assert.match(read.error, /"ledger" carries 50 in its variant row and 40 in the declared split/);
      assert.match(read.error, /Assignment follows the variant rows/);
      assert.match(read.error, /complete without a winner/);
    }
  });

  it("lists every arm whose number moved, in one refusal", () => {
    const read = declaredSplit({ ledger: 40, margin: 60 }, HALF);
    assert.equal(read.ok, false);
    if (!read.ok) {
      assert.match(read.error, /"ledger" carries 50 .* and 40 in the declared split; "margin" carries 50 .* and 60/);
    }
  });

  it("an arm the copy never mentions is a number that is missing, not a zero", () => {
    const read = declaredSplit({ ledger: 50 }, HALF);
    assert.equal(read.ok, false);
    if (!read.ok) assert.match(read.error, /"margin" carries 50 in its variant row and nothing in the declared split/);
  });

  it("a name in the copy with no arm behind it is refused before it is compared", () => {
    const read = declaredSplit({ ledger: 50, ghost: 50 }, HALF);
    assert.equal(read.ok, false);
    if (!read.ok) {
      assert.match(read.error, /the declared split carries "ghost"=50 and no variant of this test is named that/);
      assert.match(read.error, /keyed by arm name/);
    }
  });

  it("an empty copy is refused by every arm it left out", () => {
    const read = declaredSplit({}, HALF);
    assert.equal(read.ok, false);
    if (!read.ok) assert.match(read.error, /"ledger" carries 50 in its variant row and nothing/);
  });

  it("refuses a column that is not a name-to-percentage object at all", () => {
    for (const junk of [null, undefined, "50/50", 50, [50, 50], { ledger: "fifty", margin: 50 }, { ledger: -10, margin: 110 }, { ledger: NaN, margin: 50 }, { ledger: Infinity, margin: 50 }]) {
      const read = declaredSplit(junk, HALF);
      assert.equal(read.ok, false, `junk ${JSON.stringify(junk) ?? String(junk)} must not be believed as a split`);
      if (!read.ok) assert.match(read.error, /not an object of arm name to percentage/);
    }
  });

  it("says who reads the column, because that is the harm", () => {
    const read = declaredSplit("50/50", HALF);
    assert.equal(read.ok, false);
    if (!read.ok) assert.match(read.error, /GET \/api\/campaigns\/:id/);
  });

  it("an arm named after an Object.prototype member is judged by its own number", () => {
    // `split["toString"]` on a plain object is a function even when the copy
    // says nothing about that arm, and a function is not a percentage: the copy
    // is built without a prototype so an inherited member cannot answer for an
    // arm, and the refusal can print `[Function: toString]` at an operator.
    const arms = [
      { name: "toString", weight: 50 },
      { name: "margin", weight: 50 },
    ];
    const read = declaredSplit({ margin: 50 }, arms);
    assert.equal(read.ok, false);
    if (!read.ok) assert.match(read.error, /"toString" carries 50 in its variant row and nothing in the declared split/);
  });
});

describe("cohortZ is one arm against the rest of the traffic", () => {
  it("is the signed normalized distance from the declared share", () => {
    assert.equal(cohortZ("ledger", SPLIT, cohorts(16, 0)), 4);
    assert.equal(cohortZ("margin", SPLIT, cohorts(16, 0)), -4);
  });

  it("a cohort that matches its declaration scores zero", () => {
    assert.equal(cohortZ("a", { a: 80, b: 20 }, [cohort("a", 40), cohort("b", 10)]), 0);
  });

  it("says nothing about a test nobody was enrolled in", () => {
    assert.equal(cohortZ("ledger", SPLIT, []), null);
    assert.equal(cohortZ("ledger", SPLIT, cohorts(0, 0)), null);
  });

  it("says nothing about a share that no cohort could contradict", () => {
    assert.equal(cohortZ("all", { all: 100, none: 0 }, [cohort("all", 90), cohort("none", 10)]), null);
    assert.equal(cohortZ("none", { all: 100, none: 0 }, [cohort("all", 90), cohort("none", 10)]), null);
  });

  it("says nothing about an arm the split does not declare", () => {
    assert.equal(cohortZ("ghost", SPLIT, cohorts(16, 0)), null);
  });

  it("holds its peace while the sample is too small to say anything", () => {
    // 3 of 7 on a 50/50 test is what a fair coin does, and the module that
    // alarms on it would be cried wolf by the third campaign.
    assert.equal(cohortZ("ledger", SPLIT, cohorts(3, 4)), null);
    assert.equal(cohortZ("ledger", SPLIT, cohorts(7, 0)), null);
  });

  it("applies the floor to the rest of the traffic, not only to the arm", () => {
    // 90/10 with ten contacts: the big arm has nine expected, the small side
    // has one, and the normal approximation is not a thing you may do there.
    assert.equal(cohortZ("a", { a: 90, b: 10 }, [cohort("a", 9), cohort("b", 1)]), null);
    assert.notEqual(cohortZ("a", { a: 90, b: 10 }, [cohort("a", 100), cohort("b", 0)]), null);
  });

  it("divides by the total declared weight, which is the arithmetic assignVariant buckets with", () => {
    // {a:2,b:2} declares a half-and-half test just as {a:50,b:50} does, and a
    // check that read 2/100 would call every cohort of a non-100 total broken.
    const z = cohortZ("a", { a: 2, b: 2 }, [cohort("a", 16), cohort("b", 0)]);
    assert.equal(z, 4);
    assert.equal(cohortZ("a", { a: 80, b: 20 }, [cohort("a", 100), cohort("b", 0)])! > SRM_Z, true);
  });

  it("an arm with no cohort row is an arm with nothing in it", () => {
    assert.equal(cohortZ("margin", SPLIT, [cohort("ledger", 16)]), -4);
  });

  it("the two-sided 0.1% line is where the normal distribution says it is", () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-12, "the integrator's own sanity");
    assert.ok(Math.abs(normalCdf(1.959964) - 0.975) < 1e-6, "the integrator agrees with the familiar 5% point");
    const twoSided = 2 * (1 - normalCdf(SRM_Z));
    assert.ok(Math.abs(twoSided - 0.001) < 1e-5, `SRM_Z=${SRM_Z} is the two-sided ${(twoSided * 100).toFixed(4)}% point, not 0.1%`);
  });

  it("the floor is the expected-count condition it is documented as", () => {
    assert.equal(MIN_EXPECTED, 5);
  });

  it("crosses the alarm line where the arithmetic does, not where the story wants it", () => {
    // 17 of 20 on a 50/50 test is a surprise; 18 of 20 is not a surprise.
    assert.ok(cohortZ("ledger", SPLIT, cohorts(17, 3))! < SRM_Z);
    assert.ok(cohortZ("ledger", SPLIT, cohorts(18, 2))! > SRM_Z);
  });
});

describe("cohortProblem refuses the verdict the split cannot support", () => {
  it("is silent on the cohorts chance is allowed to produce", () => {
    assert.equal(cohortProblem(SPLIT, cohorts(3, 4)), null);
    assert.equal(cohortProblem(SPLIT, cohorts(10, 10)), null);
    assert.equal(cohortProblem(SPLIT, cohorts(17, 3)), null);
    assert.equal(cohortProblem(SPLIT, []), null);
  });

  it("names the arm, the declaration, what arrived and what that expects", () => {
    const why = cohortProblem(SPLIT, cohorts(16, 0));
    assert.ok(why);
    assert.match(why!, /"ledger" was declared 50 of 100 \(50\.0%\) and received 16 of 16 enrollments where 8\.0 were expected/);
    assert.match(why!, /z=\+4\.00 against the rest of the traffic/);
  });

  it("signs the arm that was starved as well as the one that was flooded", () => {
    const why = cohortProblem(SPLIT, cohorts(16, 0))!;
    assert.match(why, /"margin" was declared 50 of 100 .* received 0 of 16 enrollments .* z=-4\.00/);
    assert.match(why, /\(2 arms are off their declared share\)/);
  });

  it("says one arm off as one arm, and does not dress it up as several findings", () => {
    // Two arms cannot be off by themselves: on a two-arm test the starved side
    // is the flooded side, so the honest count here needs a third arm that came
    // out within chance — 11 of what 25 expects is a surprise of its own, at
    // z=-3.23, just this side of the line.
    const why = cohortProblem({ a: 50, b: 25, c: 25 }, [cohort("a", 78), cohort("b", 11), cohort("c", 11)])!;
    assert.match(why, /^a cohort is not the one this test declared/);
    assert.doesNotMatch(why, /2 arms/);
    assert.match(why, /"a" was declared 50 of 100 \(50\.0%\) and received 78 of 100 enrollments where 50\.0 were expected/);
  });

  it("gives the remedy the route already offers, and the reason a verdict is the wrong use of these cohorts", () => {
    const why = cohortProblem(SPLIT, cohorts(16, 0))!;
    assert.match(why, /not comparing copy, it is comparing audiences/);
    assert.match(why, /Complete without a winner, or run a new test/);
  });

  it("lists each offending arm once, in the declaration's own order", () => {
    const problems = cohortProblems(SPLIT, cohorts(16, 0));
    assert.equal(problems.length, 2);
    assert.match(problems[0]!, /^"ledger"/);
    assert.match(problems[1]!, /^"margin"/);
    assert.equal(cohortProblems(SPLIT, cohorts(3, 4)).length, 0);
  });
});

describe("the messages repeat the facts the code holds", () => {
  it("the column is the JSON the schema comments, and is not nullable", () => {
    assert.match(schema, /trafficSplit\s+Json\s+\/\/ e\.g\., \{"control": 50, "variant_a": 50\}/);
  });

  it("the weight is the percentage the copy copies", () => {
    assert.match(schema, /weight\s+Int\s+\/\/ Percentage of traffic/);
  });

  it("the buyer reads the column: the campaign detail includes the test rows", () => {
    assert.match(source("../../src/app/api/campaigns/[id]/route.ts"), /abTests: \{ include: \{ variants: true \} \}/);
  });

  it("the assignment runs on the arm rows, with a % total bucket", () => {
    const abtest = source("../../src/lib/abtest.ts");
    assert.match(abtest, /variants\.reduce\(\(n, v\) => n \+ v\.weight, 0\)/);
    assert.match(abtest, /% total/);
    assert.match(abtest, /sum !== 100/);
  });

  it("no caller can write either half of the number after creation", () => {
    const fields = source("../../src/lib/fields.ts");
    const createTable = /export const ABTEST_CREATE = \{[\s\S]*?\n\} satisfies Schema;/.exec(fields)?.[0] ?? "";
    const patchTable = /export const ABTEST_PATCH = \{[\s\S]*?\n\} satisfies Schema;/.exec(fields)?.[0] ?? "";
    assert.ok(createTable.length > 0 && patchTable.length > 0, "both tables are readable");
    assert.doesNotMatch(createTable, /trafficSplit/, "the split is derived from the arms, never typed by a caller");
    assert.doesNotMatch(createTable, /weight/, "weights arrive as variant rows, not as a test field");
    assert.match(patchTable, /status: \{ kind: "enum", required: true, values: ABTEST_STATUSES \}/);
    assert.doesNotMatch(patchTable, /trafficSplit|weight/, "the lifecycle door cannot move an arm");
  });
});

describe("the doors read the split once, and the verdict door asks before it decides", () => {
  it("the create route writes the copy through the module", () => {
    assert.match(create, /import \{ declareSplit \} from "@\/lib\/traffic-split"/);
    assert.match(create, /trafficSplit: declareSplit\(variants\)/);
    assert.doesNotMatch(create, /Object\.fromEntries\(variants/, "the shape is not spelled twice");
  });

  it("the completion door imports both checks and no arithmetic of its own", () => {
    assert.match(patch, /import \{ cohortProblem, declaredSplit \} from "@\/lib\/traffic-split"/);
    assert.doesNotMatch(patch, /Math\.sqrt|weight\s*\/\s*100|trafficSplit: Object/);
  });

  it("the copy is believed only after it is compared with the arms it was copied from", () => {
    const splitAt = patch.indexOf("declaredSplit(owned.trafficSplit, owned.variants)");
    const cohortAt = patch.indexOf("cohortProblem(declared.split, cohorts)");
    const evidenceAt = patch.indexOf("verdictEvidence(winnerArm, controlArm)");
    const updateAt = patch.indexOf("prisma.aBTest.update");
    assert.ok(splitAt >= 0 && cohortAt > splitAt, "the declaration is read before the cohorts are judged");
    assert.ok(cohortAt < evidenceAt, "and both before the verdict's evidence is counted");
    assert.ok(evidenceAt < updateAt && cohortAt < updateAt, "and none of it happens after the row is written");
  });

  it("the split is judged only when a winner is being named", () => {
    // Completing without a verdict is the remedy both messages give, so the
    // door must not refuse the close it is recommending.
    const winnerAt = patch.indexOf('if (winningVariant) {');
    const splitAt = patch.indexOf("declaredSplit(owned.trafficSplit");
    const block = patch.slice(winnerAt, patch.indexOf("const test = await prisma.aBTest.update"));
    assert.ok(winnerAt >= 0 && splitAt > winnerAt, "inside the winner branch");
    assert.match(block, /if \(!declared\.ok\) return NextResponse\.json\(\{ error: declared\.error \}, \{ status: 409 \}\)/);
    assert.match(block, /if \(imbalance\) return NextResponse\.json\(\{ error: imbalance \}, \{ status: 409 \}\)/);
    assert.ok(block.indexOf("declaredSplit") < block.indexOf("cohortProblem"), "declaration, then cohorts, then evidence");
  });

  it("cohorts are counted by variant id, the way the evidence already is", () => {
    assert.match(patch, /prisma\.enrollment\.count\(\{ where: \{ abVariantId: v\.id \} \}/);
    assert.doesNotMatch(patch, /enrollment\.count\(\{ where: \{ abVariant: \{ name/);
  });

  it("the verdict door reads the copy and the weights it compares them with", () => {
    assert.match(patch, /select: \{[^}]*trafficSplit: true,[^}]*startedAt: true,\s*variants: \{ select: \{ id: true, name: true, weight: true, isControl: true \}/);
  });

  it("the module states each arithmetic once", () => {
    assert.equal((mod.match(/const declaredTotal = /g) ?? []).length, 1);
    assert.equal((mod.match(/const cohortTotal = /g) ?? []).length, 1);
    assert.equal((mod.match(/Object\.values\(declared\)\.reduce/g) ?? []).length, 1);
    assert.equal((mod.match(/reduce\(\(n, c\) => n \+ c\.count/g) ?? []).length, 1);
    assert.equal((mod.match(/Math\.sqrt\(total \* p \* \(1 - p\)\)/g) ?? []).length, 1);
    assert.doesNotMatch(mod, /weight\s*\/\s*100/, "the total is the denominator, not the number 100");
  });

  it("the pause, the resume and the terminal refusal are untouched", () => {
    assert.match(patch, /status must be one of \$\{targets\.join\(", "\)\} — DRAFT is not a transition target/);
    assert.match(patch, /if \(owned\.status === "COMPLETED"\)/);
    assert.match(patch, /if \(winningVariant && status !== "COMPLETED"\)/);
  });
});
