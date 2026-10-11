import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { pageParams } from "@/lib/pagination";
import { validateBody } from "@/lib/validate";
import { CONTACT_LIST_CREATE } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const { page, limit } = pageParams(searchParams, 20);


  const [lists, total] = await Promise.all([
    prisma.contactList.findMany({ where: { workspaceId }, include: { _count: { select: { members: true } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.contactList.count({ where: { workspaceId } }),
  ]);
  return NextResponse.json({ lists, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const body = await request.json();
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, CONTACT_LIST_CREATE);
  if (!input.ok) return input.error;

  // `!!isDynamic` used to stand here, which is a type lie in the other
  // direction: `"no"` and `[]` are both truthy, so a caller that meant to
  // switch a list off could not. Omitting it now leaves the schema's own
  // default alone instead of restating it.
  const list = await prisma.contactList.create({ data: { workspaceId, ...input.data } });
  return NextResponse.json(list, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
