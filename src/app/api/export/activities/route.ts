import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { canManageRoles } from "@/lib/roles";
import { prisma } from "@/lib/db";
import { exportDownloadHeaders, exportFilename, activityCsvHeader, activityCsvRow } from "@/lib/export";

export const dynamic = "force-dynamic";

/**
 * Activities per batch.
 */
const ACTIVITY_BATCH = 500;

/**
 * GET /api/export/activities — the engagement audit, streamed as CSV.
 *
 * One row per activity (SENT, DELIVERED, OPENED, CLICKED, REPLIED, BOUNCED,
 * FAILED, UNSUBSCRIBED) with its metadata. Activities have no useful upper
 * bound, so loading them into the workspace JSON would turn a data-rights
 * feature into an out-of-memory error. The stream pages by primary key
 * (`id > cursor`) and writes each batch as it arrives.
 *
 * Authentication is checked before the stream is constructed. The stream only
 * reads the workspaceId captured from that session.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!canManageRoles(session.role)) {
    return NextResponse.json(
      { error: "Only an owner or admin can export the workspace." },
      { status: 403 },
    );
  }

  const workspaceId = session.workspaceId;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor: string | undefined;
      try {
        controller.enqueue(encoder.encode(activityCsvHeader()));
        for (;;) {
          const activities = await prisma.activity.findMany({
            where: { enrollment: { campaign: { workspaceId } }, ...(cursor ? { id: { gt: cursor } } : {}) },
            orderBy: { id: "asc" },
            take: ACTIVITY_BATCH,
            select: {
              id: true,
              enrollmentId: true,
              contactId: true,
              type: true,
              channel: true,
              messageId: true,
              idempotencyKey: true,
              metadata: true,
              createdAt: true,
            },
          });
          if (activities.length === 0) break;

          let chunk = "";
          for (const a of activities) chunk += activityCsvRow(a);
          controller.enqueue(encoder.encode(chunk));

          cursor = activities[activities.length - 1].id;
          if (activities.length < ACTIVITY_BATCH) break;
        }
        controller.close();
      } catch (err) {
        console.error("[export] activity stream failed:", err);
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: exportDownloadHeaders(
      exportFilename(session.workspaceSlug, "activities"),
      "text/csv; charset=utf-8",
    ),
  });
}