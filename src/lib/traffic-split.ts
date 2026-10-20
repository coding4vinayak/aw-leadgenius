/**
 * Whether an A/B test's declared traffic split is the split it is running.
 *
 * `prisma/schema.prisma` comments the column `// e.g., {"control": 50,
 * "variant_a": 50}`, and the create route fills it exactly that way — through
 * `declareSplit` below, from the arm rows it writes in the same statement. So
 * the number a test runs on exists twice: in the JSON, and in
 * `ABTestVariant.weight`. The rows are the operative
 * copy (`assignVariant` walks `variants[].weight` with a `% total` bucket, and
 * `validateAbTestSemantics` refuses a creation whose weights do not sum to 100)
 * while the JSON is believed by nothing in the code — and is still served to the
 * buyer, because `GET /api/campaigns/[id]` includes the whole `abTests` rows.
 * The column is therefore the campaign's *reported* split, checked against
 * nothing.
 *
 * Two questions follow, and the completion door is where both are promised.
 * Naming a winner says "these cohorts got the copy the split declared"; the
 * claim is worth something only if the declaration describes the test, and if
 * the test delivered the declaration:
 *
 *  - `declaredSplit` — the copy against the arm rows it was copied from. No API
 *    caller can write either half after creation (`ABTEST_CREATE` does not list
 *    `trafficSplit`; `ABTEST_PATCH` is `status` and `winningVariant`), so a
 *    disagreement arrived by hand: a migration, a backfill, an operator turning
 *    a 50/50 into a canary and back. The rows keep assigning whatever they
 *    currently say while the report says something else.
 *  - `cohortProblem` — the declaration against the enrollments that actually
 *    landed. This one does not need a corrupt row to be true: assignment is a
 *    hash of `(test, contact)`, so twelve contacts can come out 11/1 on an
 *    honest 50/50 test, and the arms then differ by more than their copy. Judged
 *    arm by arm, one against the rest of the traffic, on the same z-scale
 *    `ABTest.confidence` already reports its verdict in.
 *
 * The floor is why a small test is not scolded: 3 of 7 on a 50/50 is chance, and
 * a split is a promise about the assignment, not about a handful of draws. An
 * arm is judged only once both it and the rest of the traffic have five
 * enrollments expected — the ordinary validity condition for the normal
 * approximation — so a test with a few contacts answers nothing. That is the
 * honest output, not a number invented at the review.
 */

/** One arm, as the copy is checked against it: the name the split keys on and the weight the assignment serves. */
export interface SplitArm {
  name: string;
  weight: number;
}

/** One arm's realized cohort: how many enrollments the assignment put there. */
export interface ArmCohort {
  name: string;
  count: number;
}

/** The column's shape: arm name to declared percentage. */
export type TrafficSplit = Record<string, number>;

/**
 * The promise's shape, written in the one place that writes it. The create
 * route spelled the `Object.fromEntries` inline, which left the check below to
 * re-derive what a correct copy looks like from a schema comment; now the writer
 * and the checker call the same function.
 */
export function declareSplit(variants: readonly SplitArm[]): TrafficSplit {
  return Object.fromEntries(variants.map((v) => [v.name, v.weight]));
}

/** A `Json` column read back as the object it documents itself to be, or `null` when it is not one. */
function asSplit(value: unknown): TrafficSplit | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, weight]) => typeof weight === "number" && Number.isFinite(weight) && weight >= 0)) return null;
  // Null-prototype on purpose: the keys are arm names, and an arm called
  // "toString" or "constructor" would otherwise read a method off
  // `Object.prototype` as the percentage the test declares.
  const copy: TrafficSplit = Object.create(null);
  for (const [name, weight] of entries) copy[name] = weight as number;
  return copy;
}

/**
 * The declared copy against the arm rows it was copied from, and the trusted
 * copy out the other side: a split that is a name→percentage object *and* says
 * what every arm says.
 *
 * Matching by name rather than position is the point — the column keys on
 * `variant.name`, which is also what attribution groups by — so a renamed arm
 * leaves its number behind under the old spelling, and an arm that vanished
 * from the rows still sits in the report.
 */
export function declaredSplit(
  value: unknown,
  arms: readonly SplitArm[],
): { ok: true; split: TrafficSplit } | { ok: false; error: string } {
  const split = asSplit(value);
  if (!split) {
    return {
      ok: false,
      error:
        "the test's trafficSplit is not an object of arm name to percentage, which is what the column's own comment says it is — " +
        "it is what GET /api/campaigns/:id reports as this campaign's split, and there is nothing to compare the arms against",
    };
  }
  const stranded = Object.entries(split).filter(([name]) => !arms.some((a) => a.name === name));
  if (stranded.length) {
    return {
      ok: false,
      error:
        `the declared split carries ${stranded.map(([name, weight]) => `"${name}"=${weight}`).join(", ")} and no variant of this test is named that — ` +
        "trafficSplit is a copy of the arm rows keyed by arm name, so the report describes arms that are not in the test",
    };
  }
  const moved = arms.filter((a) => split[a.name] !== a.weight);
  if (moved.length) {
    return {
      ok: false,
      error:
        `the split reported for this test no longer describes it: ${moved.map((a) => `"${a.name}" carries ${a.weight} in its variant row and ${split[a.name] ?? "nothing"} in the declared split`).join("; ")}. ` +
        "Assignment follows the variant rows, so a verdict here would be judged against a percentage no arm runs on — complete without a winner, " +
        "or put the copy back to what the arms carry",
    };
  }
  return { ok: true, split };
}

/**
 * Two-sided 0.1% point of the standard normal, the alarm line for one arm
 * against the rest of the traffic. 0.1% rather than the familiar 5% because a
 * looser line calls one healthy test in twenty broken, and a campaign runs many
 * tests: at 5% the alarm would fire on the arithmetic, not on the split.
 */
export const SRM_Z = 3.290527;

/** Expected enrollments — in the arm and in the rest of the traffic — before the approximation says anything. */
export const MIN_EXPECTED = 5;

const signed = (n: number): string => (n >= 0 ? "+" : "") + n.toFixed(2);

/** What the arms were declared to be worth, summed — the denominator `assignVariant` takes its modulo from. */
const declaredTotal = (declared: TrafficSplit): number => Object.values(declared).reduce((n, w) => n + w, 0);

/** How much traffic actually arrived. */
const cohortTotal = (cohorts: readonly ArmCohort[]): number => cohorts.reduce((n, c) => n + c.count, 0);

/** An arm with no cohort row is an arm nobody arrived in: a zero, which is a number the check can judge. */
const cohortOf = (name: string, cohorts: readonly ArmCohort[]): number => cohorts.find((c) => c.name === name)?.count ?? 0;

/**
 * One arm's realized share against its declared share:
 * `z = (got - expected) / sqrt(n · p · (1 - p))`, with `p` the arm's declared
 * weight over the *total* declared weight, because `% total` is the arithmetic
 * `assignVariant` buckets with. Mirroring the server's own denominator is what
 * makes a pass mean "the assignment delivered the promise" rather than "the
 * column adds up to 100".
 *
 * `null` when the arm can say nothing: no traffic, a declared share of 0 or of
 * everything (nothing could contradict it, and `p · (1 - p)` is zero anyway), or
 * fewer than `MIN_EXPECTED` enrollments expected on either side of the split.
 */
export function cohortZ(name: string, declared: TrafficSplit, cohorts: readonly ArmCohort[]): number | null {
  const weight = declared[name];
  const total = cohortTotal(cohorts);
  const weightTotal = declaredTotal(declared);
  if (weight === undefined || total === 0 || weightTotal === 0) return null;
  const p = weight / weightTotal;
  if (p <= 0 || p >= 1) return null;
  const expected = total * p;
  if (expected < MIN_EXPECTED || total - expected < MIN_EXPECTED) return null;
  return (cohortOf(name, cohorts) - expected) / Math.sqrt(total * p * (1 - p));
}

/** Every arm whose cohort is further from its declared share than chance explains, in the split's own terms. */
export function cohortProblems(declared: TrafficSplit, cohorts: readonly ArmCohort[]): string[] {
  const total = cohortTotal(cohorts);
  const weightTotal = declaredTotal(declared);
  const out: string[] = [];
  for (const name of Object.keys(declared)) {
    const score = cohortZ(name, declared, cohorts);
    if (score === null || Math.abs(score) < SRM_Z) continue;
    const p = (declared[name] ?? 0) / weightTotal;
    out.push(
      `"${name}" was declared ${declared[name]} of ${weightTotal} (${(p * 100).toFixed(1)}%) and received ${cohortOf(name, cohorts)} of ${total} enrollments ` +
        `where ${(total * p).toFixed(1)} were expected — z=${signed(score)} against the rest of the traffic`,
    );
  }
  return out;
}

/**
 * The verdict door's question: are these the cohorts the split promised?
 *
 * Two arms drifting in opposite directions is one event described twice, which
 * the refusal says rather than pretending to count independent findings. The
 * remedy is the one the route already offers for thin evidence — complete
 * without a winner — because a comparison that never was cannot be re-derived
 * from the contacts who happened to arrive.
 */
export function cohortProblem(declared: TrafficSplit, cohorts: readonly ArmCohort[]): string | null {
  const problems = cohortProblems(declared, cohorts);
  if (!problems.length) return null;
  const head =
    problems.length === 1 ? "a cohort is not the one this test declared" : `the cohorts are not the ones this test declared (${problems.length} arms are off their declared share)`;
  return (
    `${head}: ${problems.join("; ")}. ` +
    "A test whose arms differ in size by more than chance explains is not comparing copy, it is comparing audiences, and the winner would be " +
    "decided by which audience arrived. Complete without a winner, or run a new test"
  );
}
