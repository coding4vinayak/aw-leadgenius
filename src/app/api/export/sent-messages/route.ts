import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { canManageRoles } from "@/lib/roles";
import { prisma } from "@/lib/db";
import { exportDownloadHeaders, exportFilename, sentMessageCsvHeader, sentMessageCsvRow } from "@/lib/export";

export const dynamic = "force-dynamic";

/**
 * Sent messages per batch.
 */
const SENT_MESSAGE_BATCH = 500;

/**
 * GET /api/export/sent-messages — the outbound message audit, streamed as CSV.
 *
 * One row per sent message with its channel, subject, body, status and error.
 * Sent messages have no useful upper bound, so they have their own streamed door.
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
        controller.enqueue(encoder.encode(sentMessageCsvHeader()));
        for (;;) {
          const messages = await prisma.sentMessage.findMany({
            where: { sendingAccount: { workspaceId }, ...(cursor ? { id: { gt: cursor } } : {}) },
            orderBy: { id: "asc" },
            take: SENT_MESSAGE_BATCH,
            select: {
              id: true,
              sendingAccountId: true,
              enrollmentId: true,
              contactId: true,
              templateId: true,
              channel: true,
              subject: true,
              body: true,
              providerMessageId: true,
              status: true,
              error: true,
              sentAt: true,
              createdAt: true,
            },
          });
          if (messages.length === 0) break;

          let chunk = "";
          for (const m of messages) chunk += sentMessageCsvRow(m);
          controller.enqueue(encoder.encode(chunk));

          cursor = messages[messages.length - 1].id;
          if (messages.length < SENT_MESSAGE_BATCH) break;
        }
        controller.close();
      } catch (err) {
        console.error("[export] sent message stream failed:", err);
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: exportDownloadHeaders(
      exportFilename(session.workspaceSlug, "sent-messages"),
      "text/csv; charset=utf-8",
    ),
  });
}