import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { getEmailAccountHealth } from "@/lib/channels/email";
import { runWarmup, scheduleWarmup } from "@/lib/warmup";
import { validateBody } from "@/lib/validate";
import { SENDING_ACCOUNT_PATCH } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Scoped, and deliberately before the health lookup: the row carries the
  // provider `config`, so an unscoped read here handed another tenant's sending
  // credentials to any valid key.
  const _owned = await prisma.sendingAccount.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  const account = await prisma.sendingAccount.findUnique({ where: { id } });
  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const health = account.channel === "EMAIL" ? await getEmailAccountHealth(id) : { reputation: account.reputationScore, dailySent: 0, bounces: 0, complaints: 0 };
  return NextResponse.json({ ...account, health });
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();

  const _owned = await prisma.sendingAccount.findUnique({ where: { id }, select: { workspaceId: true, channel: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  const input = validateBody(body, SENDING_ACCOUNT_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;

  if (input.data.isDefault) {
    // One account per channel is default, so the others on this channel are
    // cleared first. The channel is the stored one, since this route has never
    // let `channel` be patched.
    await prisma.sendingAccount.updateMany({ where: { workspaceId: _owned.workspaceId, channel: _owned.channel, isDefault: true }, data: { isDefault: false } });
  }

  const account = await prisma.sendingAccount.update({ where: { id }, data: input.data });
  return NextResponse.json(account);
}

async function POST_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  const _owned = await prisma.sendingAccount.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  if (action === "warmup") {
    await runWarmup(id);
    return NextResponse.json({ ok: true });
  }
  if (action === "schedule-warmup") {
    await scheduleWarmup(id);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.sendingAccount.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);
  await prisma.sendingAccount.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const POST = withAuth(POST_impl);
export const DELETE = withAuth(DELETE_impl);
