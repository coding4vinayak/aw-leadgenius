import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { handleIncomingWhatsApp } from "@/lib/channels/whatsapp";
import { verifyInboundWebhook } from "@/lib/inbound-webhooks";
import { validateBody, type Validated } from "@/lib/validate";
import { enqueueDailyRollup } from "@/lib/analytics";
import { recordInboundActivity, activityIdempotencyKey, undoInboundSideEffect } from "@/lib/activities";
import { providerSignalFromDeliveryStatus, engagementActivityFromDeliveryStatus, statusAfterProviderSignal } from "@/lib/sequence-engine";
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

  // A delivery-status callback shares the MessageSid field — the comment below
  // has known that since it was written — but means the opposite thing: nobody
  // replied, the number could not be reached. Until here the route answered it
  // by accident: the callback passed the inbound shape check (`Body` is absent
  // and optional), its `From` is OUR sending number so the contact lookup
  // missed, and every real delivery failure was absorbed as `{ ok: true }`.
  // The Status field is the dispatch; modern Twilio calls it MessageStatus.
  //
  // Matched on the provider id stored at send time — never on From, which on
  // this shape is OUR number. Two pure tables decide what a status means:
  // `providerSignalFromDeliveryStatus` for the lifecycle (which failures are
  // this channel's bounce) and `engagementActivityFromDeliveryStatus` for the
  // funnel (delivered/read are the provider saying the person got the message
  // and looked at it — the same Activity rows `no_open` steps and attribution
  // already read for email). Everything else — queued, sent, a failed whose
  // code names our sender or the carrier's bad day — is acknowledged and
  // writes nothing. A bounce then follows the email webhook's shape exactly:
  // Activity under the #60 idempotency key, enrollment stopped, message
  // marked, contact stamped through `statusAfterProviderSignal` (an operator's
  // DO_NOT_CONTACT survives), one reverts list so a queue outage replays the
  // whole side effect on redelivery rather than half of it.
  const deliveryStatus = body.MessageStatus ?? body.Status;
  if (typeof deliveryStatus === "string") {
    const signal = providerSignalFromDeliveryStatus(deliveryStatus, body.ErrorCode);
    const engagement = engagementActivityFromDeliveryStatus(deliveryStatus);
    if (signal === null && engagement === null) return NextResponse.json({ ok: true });
    const messageId = body.MessageSid;
    if (typeof messageId !== "string" || messageId === "") return NextResponse.json({ ok: true });

    const sentMessage = await prisma.sentMessage.findFirst({ where: { providerMessageId: messageId } });
    if (!sentMessage?.enrollmentId) return NextResponse.json({ ok: true });
    const enrollmentId = sentMessage.enrollmentId;
    const activityType = engagement === null ? "BOUNCED" : engagement;

    const activity = await recordInboundActivity(
      activityIdempotencyKey({ channel: "WHATSAPP", messageId, activityType }),
      {
        enrollmentId,
        contactId: sentMessage.contactId,
        type: activityType,
        channel: "WHATSAPP",
        messageId,
        metadata: { provider: "twilio", status: deliveryStatus, errorCode: body.ErrorCode ?? null, errorMessage: body.ErrorMessage ?? null },
      },
    );
    if (!activity) return NextResponse.json({ ok: true });
    await enqueueDailyRollup(enrollmentId, activity.createdAt);

    const reverts: Array<() => Promise<unknown>> = [];
    if (signal !== null) {
      const priorEnrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId }, select: { status: true } });
      const priorSentMessageStatus = sentMessage.status;
      await prisma.sentMessage.update({ where: { id: sentMessage.id }, data: { status: "BOUNCED" } });
      await prisma.enrollment.update({ where: { id: enrollmentId }, data: { status: "BOUNCED" } });
      if (priorEnrollment) {
        const back = priorEnrollment.status;
        reverts.push(() => prisma.enrollment.update({ where: { id: enrollmentId }, data: { status: back } }));
      }
      reverts.push(() => prisma.sentMessage.update({ where: { id: sentMessage.id }, data: { status: priorSentMessageStatus } }));

      const priorContact = await prisma.contact.findUnique({ where: { id: sentMessage.contactId }, select: { status: true } });
      const marked = priorContact ? statusAfterProviderSignal(priorContact.status, signal) : null;
      if (priorContact && marked) {
        const back = priorContact.status;
        await prisma.contact.update({ where: { id: sentMessage.contactId }, data: { status: marked } });
        reverts.push(() => prisma.contact.update({ where: { id: sentMessage.contactId }, data: { status: back } }));
      }
    }

    try {
      await enqueue(queues.sequence, "process-step", { enrollmentId, activityType });
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        // Engagement rows undo to just the row delete — the empty reverts list
        // is the point: a read receipt flips nothing, so a redelivery replays
        // the count and re-drives the condition without status rewrites.
        await undoInboundSideEffect(activity.id, reverts);
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
    return NextResponse.json({ ok: true });
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
