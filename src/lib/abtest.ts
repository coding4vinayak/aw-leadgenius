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
