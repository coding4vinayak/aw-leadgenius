import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { validateBody } from "@/lib/validate";
import { ABTEST_PATCH } from "@/lib/fields";

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
 */
async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();

  const owned = await prisma.aBTest.findUnique({ where: { id }, select: { workspaceId: true, status: true } });
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
  if (winningVariant) {
    // A name, not an id: the claim is "this arm won", and the only way to
    // check it is membership in this test's own rows.
    const variant = await prisma.aBTestVariant.findFirst({ where: { abTestId: id, name: winningVariant }, select: { id: true } });
    if (!variant) {
      return NextResponse.json({ error: `winningVariant "${winningVariant}" is not a variant of this test` }, { status: 400 });
    }
  }

  const test = await prisma.aBTest.update({
    where: { id },
    data: {
      status,
      ...(status === "COMPLETED" ? { completedAt: new Date(), winningVariant: winningVariant ?? null } : {}),
    },
    include: { variants: { orderBy: { name: "asc" } } },
  });
  return NextResponse.json({ abTest: test });
}

export const PATCH = withAuth(PATCH_impl);
