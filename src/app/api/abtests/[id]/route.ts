import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { validateBody } from "@/lib/validate";
import { ABTEST_PATCH } from "@/lib/fields";
import { verdictEvidence } from "@/lib/abtest";
import { cohortProblem, declaredSplit } from "@/lib/traffic-split";

export const dynamic = "force-dynamic";

/**
 * The lifecycle a buyer hits from the review screen. The create route arrives
 * RUNNING, and two error messages in this product already tell the operator to
 * "pause the test" — the enroll route's 409 for a vanished arm sequence and
 * the engine's for a vanished arm template — with no route that could do the
 * pausing. That promise is kept here: RUNNING ↔ PAUSED stops and restarts arm
 * assignment (the enroll route reads only RUNNING tests), and COMPLETED is the
 * terminal decision, where the winner is named.
 *
 * Transitions are the whole vocabulary: `DRAFT` is the column's default but no
 * transition target — nothing reads it and no route wrote it, and "return to
 * before the test existed" is not a lifecycle step. A COMPLETED test is frozen
 * because its cohorts are what the winner was decided on; re-opening it would
 * re-bucket new enrollments against a verdict already cast.
 *
 * Completing *with a winner* also stamps `confidence`: the two-proportion z on
 * reply rate between the winning arm and the control (see `verdictEvidence`),
 * counted from the live Activity rows scoped by *variant id* — not the
 * name-keyed `byVariant` rollup, which merges cohorts when two live tests
 * share arm names. A test whose winner or control never sent answers 409:
 * `confidence` may stay null (no verdict yet), but a verdict with no evidence
 * behind it is the accepted-but-ignored column this repository keeps having
 * to come back for.
 *
 * Completing *with a winner* is also the only place the declared split gets
 * read: `trafficSplit` is a copy of the arm rows and is what
 * `GET /api/campaigns/:id` reports as the campaign's split, so the verdict
 * refuses a copy that no longer describes its arms and a set of cohorts that is
 * not the split's (`./traffic-split`). Refusing a verdict is not refusing to
 * close: completing without a winner stays available, and is the remedy both
 * messages give — a test can end without claiming a comparison it did not run.
 */
async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();

  const owned = await prisma.aBTest.findUnique({
    where: { id },
    select: {
      workspaceId: true,
      status: true,
      trafficSplit: true,
      startedAt: true,
      variants: { select: { id: true, name: true, weight: true, isControl: true } },
    },
  });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, owned.workspaceId);

  const input = validateBody(body, ABTEST_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;
  const { status, winningVariant } = input.data as { status: string; winningVariant?: string };

  const targets = ["RUNNING", "PAUSED", "COMPLETED"] as const;
  if (!(targets as readonly string[]).includes(status)) {
    return NextResponse.json({ error: `status must be one of ${targets.join(", ")} — DRAFT is not a transition target` }, { status: 400 });
  }
  if (owned.status === "COMPLETED") {
    return NextResponse.json({ error: "a COMPLETED test is terminal — its cohorts are what the winner was decided on" }, { status: 409 });
  }
  if (winningVariant && status !== "COMPLETED") {
    return NextResponse.json({ error: "winningVariant can only be declared when the test is COMPLETED" }, { status: 400 });
  }
  if (status === owned.status) {
    const same = await prisma.aBTest.findUnique({ where: { id }, include: { variants: { orderBy: { name: "asc" } } } });
    return NextResponse.json({ abTest: same });
  }
  let confidence: number | undefined;
  if (winningVariant) {
    // A name, not an id: the claim is "this arm won", and the only way to
    // check it is membership in this test's own rows.
    const winner = owned.variants.find((v) => v.name === winningVariant);
    if (!winner) {
      return NextResponse.json({ error: `winningVariant "${winningVariant}" is not a variant of this test` }, { status: 400 });
    }
    // Naming a winner promises that these cohorts were the ones the split
    // declared, and the split is a number that lives twice: as the JSON the
    // create route copied off the arm rows, and as the enrollments the
    // assignment actually filled. Both questions are asked here, before the
    // evidence below, because a verdict resting on an audience that is not the
    // one promised is not thin evidence — it is a different test, and that is
    // what the operator needs to hear first.
    const declared = declaredSplit(owned.trafficSplit, owned.variants);
    if (!declared.ok) return NextResponse.json({ error: declared.error }, { status: 409 });
    // Every enrollment the test placed, whatever the contact has since done:
    // the cohort is who arrived, and a contact that bounced was assigned to this
    // arm just the same. Scoped by variant id for the same reason the evidence
    // below is — arm names are shared between live tests.
    const cohorts = await Promise.all(
      owned.variants.map(async (v) => ({ name: v.name, count: await prisma.enrollment.count({ where: { abVariantId: v.id } }) })),
    );
    const imbalance = cohortProblem(declared.split, cohorts);
    if (imbalance) return NextResponse.json({ error: imbalance }, { status: 409 });
    // Creation validated exactly one control (validateAbTestSemantics), so a
    // stored test always has one.
    const control = owned.variants.find((v) => v.isControl)!;
    const since = owned.startedAt ? { createdAt: { gte: owned.startedAt } } : {};
    const counts = async (variantId: string) => ({
      sent: await prisma.activity.count({ where: { enrollment: { abVariantId: variantId }, type: "SENT", ...since } }),
      replied: await prisma.activity.count({ where: { enrollment: { abVariantId: variantId }, type: "REPLIED", ...since } }),
    });
    const [winnerArm, controlArm] = [await counts(winner.id), await counts(control.id)];
    const z = verdictEvidence(winnerArm, controlArm);
    if (z === null) {
      const silent = [winnerArm.sent === 0 && winner.name, controlArm.sent === 0 && control.name].filter(Boolean).join(" and ");
      return NextResponse.json(
        { error: `${silent} recorded no sends — completing a verdict on cohorts that never sent an email is not evidence; enroll contacts (or complete without a winner)` },
        { status: 409 },
      );
    }
    confidence = z;
  }

  const test = await prisma.aBTest.update({
    where: { id },
    data: {
      status,
      ...(status === "COMPLETED"
        ? { completedAt: new Date(), winningVariant: winningVariant ?? null, ...(confidence !== undefined ? { confidence } : {}) }
        : {}),
    },
    include: { variants: { orderBy: { name: "asc" } } },
  });
  return NextResponse.json({ abTest: test });
}

export const PATCH = withAuth(PATCH_impl);
