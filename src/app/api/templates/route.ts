import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { validateBody } from "@/lib/validate";
import { TEMPLATE_CREATE } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const channel = searchParams.get("channel");

  const where: any = { workspaceId };
  if (channel) where.channel = channel;
  const templates = await prisma.template.findMany({ where, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ templates });
}

async function POST_impl(request: Request) {
  const requestBody = await request.json();
  const workspaceId = await authedWorkspaceId(request, requestBody.workspaceId);

  // `body` is NOT NULL with no default and this route never looked at it: a
  // template POSTed without message text answered 500, and the caller got a
  // Prisma stack naming the one field they had actually left out.
  const input = validateBody(requestBody, TEMPLATE_CREATE);
  if (!input.ok) return input.error;

  const template = await prisma.template.create({ data: { workspaceId, ...input.data } });
  return NextResponse.json(template, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
