import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { handleIncomingWhatsApp } from "@/lib/channels/whatsapp";
import { verifyInboundWebhook } from "@/lib/inbound-webhooks";
import { validateBody, type Validated } from "@/lib/validate";
import { enqueueDailyRollup } from "@/lib/analytics";
import { recordInboundActivity, activityIdempotencyKey, undoInboundSideEffect } from "@/lib/activities";
import { INBOUND_MESSAGE_EVENT } from "@/lib/fields";
import { triggerWebhooks } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

type InboundMessage = Validated<typeof INBOUND_MESSAGE_EVENT>;

export async function POST(request: Request) {
  const rawBody = await request.text();
  const denied = verifyInboundWebhook(request, rawBody);
  if (denied) return denied;

  // Twilio posts application/x-www-form-urlencoded, not JSON, so the previous
  // `await request.json()` threw on every real delivery — the route could only
  // ever answer 500 to the provider it is named after. Both shapes are accepted
  // here, and the parameter names are the same in either.
  const contentType = request.headers.get("content-type") ?? "";
  let body: Record<string, unknown>;
  try {
    body = (contentType.includes("application/x-www-form-urlencoded")
      ? Object.fromEntries(new URLSearchParams(rawBody).entries())
      : JSON.parse(rawBody)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Twilio names a MessageSid on its delivery-status callbacks as well as on an
  // inbound message, so naming one is the only dispatch there is. What a named
  // message has to look like is the table's business; reading the names without
  // checking them was the 500 — `body.From?.startsWith` on a number — and the
  // silent 200 for everything the condition could not understand.
  if (body.MessageSid === undefined || body.MessageSid === null) return NextResponse.json({ ok: true });

  const shape = validateBody(
    { messageId: body.MessageSid, from: body.From, content: body.Body },
    INBOUND_MESSAGE_EVENT,
  );
  if (!shape.ok) return shape.error;
  const message = shape.data;

  if (!message.from.startsWith("whatsapp:")) return NextResponse.json({ ok: true });

  const { contactId } = await handleIncomingWhatsApp(body);
  if (!contactId) return NextResponse.json({ ok: true });

  // Find active enrollment for this contact. The campaign is joined because
  // this row has no `workspaceId` of its own — the workspace comes through it.
  const enrollment = await prisma.enrollment.findFirst({
    where: { contactId, status: "ACTIVE" },
    orderBy: { enrolledAt: "desc" },
    include: { campaign: { select: { workspaceId: true } } },
  });
  if (!enrollment) return NextResponse.json({ ok: true });

  const activity = await recordInboundActivity(
    activityIdempotencyKey({ channel: "WHATSAPP", messageId: message.messageId, activityType: "REPLIED" }),
    {
      enrollmentId: enrollment.id,
      contactId: enrollment.contactId,
      type: "REPLIED",
      channel: "WHATSAPP",
      messageId: message.messageId,
      metadata: { content: message.content },
    },
  );
  // A Twilio redelivery of the same inbound message (MessageSid) is already
  // recorded; the row, the day and the sequence step ran on the delivery that won
  // the insert (#60). Answer 200 so Twilio stops retrying, and add nothing.
  if (!activity) return NextResponse.json({ ok: true });
  // Before the enrollment update and before the sequence enqueue: this one never throws,
  // and the two of those that can must not decide whether the day gets counted.
  await enqueueDailyRollup(enrollment.id, activity.createdAt);
  await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "REPLIED" } });
  try {
    await enqueue(queues.sequence, "process-step", { enrollmentId: enrollment.id, activityType: "REPLIED" });
  } catch (error) {
    if (error instanceof QueueUnavailableError) {
      // #65. Same shape as the linkedin route: the Activity row and the
      // enrollment flip have committed, the enqueue has not. Undo so the
      // redelivery can replay.
      await undoInboundSideEffect(activity.id, [
        () => prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: enrollment.status } }),
      ]);
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  // After the enqueue has succeeded — the 503 path above undoes the flip and
  // earns a Twilio redelivery, and that replay should be the one that notifies.
  // Best-effort, so a subscriber is never Twilio's problem.
  void triggerWebhooks(enrollment.campaign.workspaceId, "reply.received", {
    contactId: enrollment.contactId,
    enrollmentId: enrollment.id,
    channel: "WHATSAPP",
    messageId: message.messageId,
    preview: message.content,
  });

  return NextResponse.json({ ok: true });
}
