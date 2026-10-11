import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { classifyTarget } from "@/lib/egress";
import { validateBody, eventNames, NO_FIELD_TO_UPDATE, fieldProblem } from "@/lib/validate";
import { WEBHOOK_PATCH } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const webhook = await prisma.webhook.findUnique({ where: { id } });
  if (!webhook) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, webhook.workspaceId);
  return NextResponse.json(webhook);
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();

  const _owned = await prisma.webhook.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  const input = validateBody(body, WEBHOOK_PATCH);
  if (!input.ok) return input.error;

  // Same rule as POST: the array the column comment describes and the comma
  // string the reader splits are both accepted, and neither reaches Prisma
  // unchanged.
  const events = body.events === undefined ? undefined : eventNames(body.events);
  if (events && !events.ok) return events.error;

  const data = { ...input.data, ...(events?.values ? { events: events.values.join(",") } : {}) };
  if (!Object.keys(data).length) return NextResponse.json({ error: NO_FIELD_TO_UPDATE }, { status: 400 });

  if (typeof data.url === "string") {
    const target = await classifyTarget(data.url, "url");
    if (!target.ok) return fieldProblem("url", target.reason);
  }

  const webhook = await prisma.webhook.update({ where: { id }, data });
  return NextResponse.json(webhook);
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.webhook.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.webhook.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const DELETE = withAuth(DELETE_impl);
