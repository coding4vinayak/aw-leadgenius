import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { getWorkspaceOverview, getCampaignAnalytics, getSequenceAnalytics, getDailyAnalytics, dayBucket } from "@/lib/analytics";
import { getAttribution } from "@/lib/attribution";
import { intParam } from "@/lib/pagination";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId: claimed } = await params;
  const workspaceId = await authedWorkspaceId(request, claimed);
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") || "overview";
  const days = intParam(searchParams, "days", 30, 1, 365);
  const campaignId = searchParams.get("campaignId");
  const sequenceId = searchParams.get("sequenceId");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");

  switch (type) {
    case "overview":
      const overview = await getWorkspaceOverview(workspaceId, days);
      return NextResponse.json(overview);

    case "campaign":
      if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
      await assertOwns(request, (await prisma.campaign.findUnique({ where: { id: campaignId }, select: { workspaceId: true } }))?.workspaceId);
      const campaign = await getCampaignAnalytics(campaignId, startDate ? new Date(startDate) : new Date(Date.now() - days * 86400000), endDate ? new Date(endDate) : new Date());
      return NextResponse.json(campaign);

    case "sequence":
      if (!sequenceId) return NextResponse.json({ error: "sequenceId required" }, { status: 400 });
      await assertOwns(request, (await prisma.sequence.findUnique({ where: { id: sequenceId }, select: { workspaceId: true } }))?.workspaceId);
      const sequence = await getSequenceAnalytics(sequenceId);
      return NextResponse.json(sequence);

    case "daily":
      const date = searchParams.get("date") ? new Date(searchParams.get("date")!) : new Date();
      const daily = await getDailyAnalytics(workspaceId, date);
      return NextResponse.json(daily);

    case "attribution": {
      // Day-bucketed window (see getAttribution): `days` counts whole days
      // back from today's midnight, so the default compares complete days only.
      const aStart = startDate ? new Date(startDate) : new Date(dayBucket(new Date()).getTime() - days * 86400000);
      const aEnd = endDate ? new Date(endDate) : new Date(dayBucket(new Date()).getTime() + 86400000);
      return NextResponse.json(await getAttribution(workspaceId, aStart, aEnd));
    }

    default:
      return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }
}

export const GET = withAuth(GET_impl);
