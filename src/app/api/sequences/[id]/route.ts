import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { validateBody } from "@/lib/validate";
import { SEQUENCE_PATCH } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sequence = await prisma.sequence.findUnique({
    where: { id },
    include: { steps: { orderBy: { stepNumber: "asc" } }, _count: { select: { enrollments: true } } },
  });
  if (!sequence) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, sequence.workspaceId);
  return NextResponse.json(sequence);
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();

  const _owned = await prisma.sequence.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  // `steps` is a relation, not a column, and this used to spread it into the
  // update anyway: `PATCH { steps: [] }` answered 500, measured as a
  // PrismaClientValidationError out of `sequence.update`. An empty body
  // answered the other way — a 200 holding the unchanged row, because Prisma
  // accepts an update with nothing in `data`. Only the four scalar columns
  // this route has ever meant are writable here; the step rows themselves are
  // created with the sequence.
  const input = validateBody(body, SEQUENCE_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;

  const sequence = await prisma.sequence.update({ where: { id }, data: input.data });
  return NextResponse.json(sequence);
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.sequence.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.sequence.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const DELETE = withAuth(DELETE_impl);
