import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { canManageRoles } from "@/lib/roles";
import { prisma } from "@/lib/db";
import { exportDownloadHeaders, exportFilename, replyCsvHeader, replyCsvRow } from "@/lib/export";

export const dynamic = "force-dynamic";

/**
 * Replies per batch.
 */
const REPLY_BATCH = 500;

/**
 * GET /api/export/replies — the inbound reply audit, streamed as CSV.
 *
 * One row per reply with its sentiment, intent and processing status.
 * Replies have no useful upper bound, so they have their own streamed door.
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
        controller.enqueue(encoder.encode(replyCsvHeader()));
        for (;;) {
          const replies = await prisma.reply.findMany({
            where: { workspaceId, ...(cursor ? { id: { gt: cursor } } : {}) },
            orderBy: { id: "asc" },
            take: REPLY_BATCH,
            select: {
              id: true,
              enrollmentId: true,
              contactId: true,
              workspaceId: true,
              channel: true,
              content: true,
              sentiment: true,
              intent: true,
              isAutoReply: true,
              processed: true,
              createdAt: true,
            },
          });
          if (replies.length === 0) break;

          let chunk = "";
          for (const r of replies) chunk += replyCsvRow(r);
          controller.enqueue(encoder.encode(chunk));

          cursor = replies[replies.length - 1].id;
          if (replies.length < REPLY_BATCH) break;
        }
        controller.close();
      } catch (err) {
        console.error("[export] reply stream failed:", err);
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: exportDownloadHeaders(
      exportFilename(session.workspaceSlug, "replies"),
      "text/csv; charset=utf-8",
    ),
  });
}