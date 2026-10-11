import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { enrichContact } from "@/lib/enrichment";
import { validateBody } from "@/lib/validate";
import { CONTACT_PATCH } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // This read used to be authenticated but not scoped: any valid key could
  // fetch any contact by id, and the payload carries list memberships,
  // campaign enrollments and the last 20 activities — another tenant's whole
  // relationship with the person.
  const _owned = await prisma.contact.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  const contact = await prisma.contact.findUnique({
    where: { id },
    include: { listMemberships: { include: { list: true } }, enrollments: { include: { campaign: true, sequence: true } }, activities: { take: 20 } },
  });
  if (!contact) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(contact);
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();

  const _owned = await prisma.contact.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  // The `&&` spreads this replaces dropped every falsy value: `PATCH
  // { company: "" }` answered a 200 carrying the unchanged row, so a caller
  // clearing a field had nothing to tell it that it had failed.
  // `validateBody` keeps absent and null distinct instead — omit the key to
  // leave it alone, send null (or blank text, on a nullable column) to clear.
  const input = validateBody(body, CONTACT_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;

  const contact = await prisma.contact.update({ where: { id }, data: input.data });
  return NextResponse.json(contact);
}

async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  const _owned = await prisma.contact.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  if (action === "enrich") {
    const result = await enrichContact(id);
    return NextResponse.json({ enriched: !!result, data: result });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.contact.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.contact.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
