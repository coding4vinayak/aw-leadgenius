import { createHash } from "node:crypto";

/** The shape the assignment reads off an `ABTestVariant` row. */
export type AssignableVariant = { id: string; name: string; weight: number; sequenceId: string };

/**
 * Deterministic weighted arm choice: sha256(`${abTestId}:${contactId}`) picks a
 * bucket in [0, total weight), and cumulative weights name the arm.
 *
 * It is an *assignment*, not a draw, on purpose. A `Math.random()` draw means a
 * retried enroll request — the client retrying a 503, the route replaying after
 * a crash — can land the same contact in a *different* arm, and the test then
 * compares copies that people moved between. Hashing the pair (test, contact)
 * makes the arm a property of the contact for that test: every attempt, every
 * process, every restart computes the same one. `abTestId` salts the hash so
 * two live tests split their arms independently — the same contact can be
 * control in one test and variant in another without the cohorts correlating.
 *
 * Cumulative order is the array's own order, so callers must pass variants in
 * a stable order (the enroll route reads them `orderBy name`). Weights that do
 * not sum to 100 are tolerated (bucket is `% total`) — creation validates them,
 * this function does not fail on a stored row.
 */
export function assignVariant<T extends AssignableVariant>(abTestId: string, contactId: string, variants: T[]): T | null {
  if (variants.length === 0) return null;
  const total = variants.reduce((n, v) => n + v.weight, 0);
  const bucket = Number.parseInt(createHash("sha256").update(`${abTestId}:${contactId}`).digest("hex").slice(0, 8), 16) % total;
  let cumulative = 0;
  for (const v of variants) {
    cumulative += v.weight;
    if (bucket < cumulative) return v;
  }
  return variants[variants.length - 1]!;
}

/**
 * One validated variant row. Structurally this is a subset of
 * `Validated<typeof ABTEST_VARIANT>`; naming it here keeps the semantics
 * function — and every test of it — free of the validator's generic types.
 */
export type AbTestVariantInput = { name: string; weight: number; isControl: boolean; sequenceId: string; templateId?: string | null };
export type AbTestCreateInput = { campaignId: string; name: string; hypothesis: string; variants: AbTestVariantInput[] };

/**
 * The cross-entry rules the per-field tables cannot express, run on
 * already-declared-shape entries (`validateBody`/`validateItems` own types,
 * lengths and the 2..10 count at the boundary).
 *
 * Two of these carry the product's meaning rather than the row's: weights must
 * sum to exactly 100 (a 90-total split silently drops 10% of the campaign into
 * the last arm via the `% total` fallback arithmetic), and exactly one
 * `isControl` (attribution compares arms against *a* control; with two or none,
 * "the winner" is undefined). The rest is naming hygiene: attribution groups
 * by name, so duplicate arm names would fold two cohorts into one row.
 */
export function validateAbTestSemantics(
  test: { campaignId: string; name: string; hypothesis: string },
  variants: AbTestVariantInput[],
): { ok: true; value: AbTestCreateInput } | { ok: false; error: string } {
  const names = new Set(variants.map((v) => v.name));
  if (names.size !== variants.length) return { ok: false, error: "variant names must be unique — attribution groups by name" };
  const controls = variants.filter((v) => v.isControl).length;
  if (controls !== 1) return { ok: false, error: `exactly one variant must have isControl: true, got ${controls}` };
  const sum = variants.reduce((n, v) => n + v.weight, 0);
  if (sum !== 100) return { ok: false, error: `variant weights must sum to 100, got ${sum}` };
  return { ok: true, value: { ...test, variants } };
}

/** What the verdict reads off the Activity fold for one arm. */
export type ArmEvidence = { sent: number; replied: number };

/**
 * Two-proportion z on reply rate: `(p_winner - p_control) / se`, the standard
 * error from the *pooled* proportion.
 *
 * The product reason it exists: `ABTest.confidence` is a Float the schema
 * carries and nothing wrote — a winner with no evidence behind it is the same
 * accepted-but-ignored column `templateId` was until #114. The sign tells you
 * which way the data points: a negative z means the "winner" replied *less*
 * than control on its own numbers, and the route stamps it anyway rather than
 * hiding it, because refusing to look is how a losing test gets relaunched
 * until it looks like a win.
 *
 * Edge cases are refusals, not numbers: `null` when either arm has no sends
 * (a rate over zero sends is not evidence, and pooled `se` would divide by
 * zero anyway); `0` when both arms replied at exactly the same rate or the
 * pooled variance collapses (identical cohorts — the winner was picked on
 * nothing, and 0 says so).
 */
export function verdictEvidence(winner: ArmEvidence, control: ArmEvidence): number | null {
  if (winner.sent === 0 || control.sent === 0) return null;
  const p1 = winner.replied / winner.sent;
  const p2 = control.replied / control.sent;
  const pooled = (winner.replied + control.replied) / (winner.sent + control.sent);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / winner.sent + 1 / control.sent));
  if (se === 0) return 0;
  return (p1 - p2) / se;
}
