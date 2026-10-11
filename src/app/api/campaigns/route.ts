import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { queues } from "@/lib/queue";
import { pageParams } from "@/lib/pagination";
import { validateBody } from "@/lib/validate";
import { CAMPAIGN_CREATE } from "@/lib/fields";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const status = searchParams.get("status");
  const { page, limit } = pageParams(searchParams, 20);


  const where: any = { workspaceId };
  if (status) where.status = status;

  const campaignsPromise = prisma.campaign.findMany({
    where,
    include: { sequences: { include: { sequence: true } }, _count: { select: { enrollments: true } } },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * limit,
    take: limit,
  });

  const totalPromise = prisma.campaign.count({ where });

  const [campaigns, total] = await Promise.all([campaignsPromise, totalPromise]);

  return NextResponse.json({ campaigns, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const body = await request.json();
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, CAMPAIGN_CREATE);
  if (!input.ok) return input.error;

  // `new Date(startDate)` used to stand here, and `new Date(42)` is a legal
  // date: the campaign came back dated 1970-01-01T00:00:00.042Z with a 201 on
  // the front. The `date` kind refuses anything that is not a parseable string.
  const campaign = await prisma.campaign.create({ data: { workspaceId, ...input.data } });

  return NextResponse.json(campaign, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
