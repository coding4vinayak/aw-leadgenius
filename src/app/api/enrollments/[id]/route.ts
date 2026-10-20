import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { validateBody, fieldProblem } from "@/lib/validate";
import { normalizeMergeValues, unfilledMergeTokens } from "@/lib/template-vars";
import { mergePromisesForSteps } from "@/lib/merge-promise";
import { ENROLLMENT_PATCH } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const enrollment = await prisma.enrollment.findUnique({
    where: { id },
    include: { campaign: true, sequence: true, contact: true, activities: { orderBy: { createdAt: "desc" } } },
  });
  if (!enrollment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, enrollment.campaign.workspaceId);
  return NextResponse.json(enrollment);
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();

  const current = await prisma.enrollment.findUnique({
    where: { id },
    include: { campaign: { select: { workspaceId: true } }, sequence: { include: { steps: true } } },
  });
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, current.campaign.workspaceId);

  // `status` used to be the only thing this route took, and it used to be
  // required: an empty request wrote an empty update and returned the row
  // unchanged, and `"active"` stored a lowercase value that every comparison in
  // the engine (`=== "ACTIVE"`) then misses. `metadata` is the second door this
  // round opens, and it replaces the object rather than merging into it — so
  // the promises the sequence still makes are checked against the values being
  // stored, and clearing a promised value by leaving it out is refused the same
  // way enroll refuses a missing one. Fixing a moved meeting is allowed;
  // un-filling it is not.
  const input = validateBody(body, ENROLLMENT_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;
  const { status } = input.data;

  if (input.data.metadata !== undefined) {
    const normalized = normalizeMergeValues(input.data.metadata);
    if (!normalized.ok) return fieldProblem("metadata", normalized.error);
    const unfilled = unfilledMergeTokens(
      await mergePromisesForSteps([...current.sequence.steps].sort((a, b) => a.stepNumber - b.stepNumber)),
      normalized.values,
    );
    if (unfilled.length) return fieldProblem("metadata", unfilled.join("; "));
    input.data.metadata = normalized.values;
  }

  const enrollment = await prisma.enrollment.update({ where: { id }, data: input.data });

  if (status === "ACTIVE") {
    try {
      await enqueue(queues.sequence, "process-step", { enrollmentId: id, activityType: "ENROLLED" });
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  }
  return NextResponse.json(enrollment);
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const current = await prisma.enrollment.findUnique({
    where: { id },
    include: { campaign: { select: { workspaceId: true } } },
  });
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, current.campaign.workspaceId);
  await prisma.enrollment.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const DELETE = withAuth(DELETE_impl);
