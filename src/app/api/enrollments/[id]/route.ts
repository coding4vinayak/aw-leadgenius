import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { validateBody } from "@/lib/validate";
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
    include: { campaign: { select: { workspaceId: true } } },
  });
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, current.campaign.workspaceId);

  // `status` is the only thing this route takes, and the `status && {...}`
  // spread had two silent shapes: a request without one wrote an empty update
  // and returned the row unchanged, and `"active"` stored a lowercase value
  // that every comparison in the engine (`=== "ACTIVE"`) then misses.
  const input = validateBody(body, ENROLLMENT_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;
  const { status } = input.data;

  const enrollment = await prisma.enrollment.update({ where: { id }, data: { status } });

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
