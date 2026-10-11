import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { verifyInboundWebhook } from "@/lib/inbound-webhooks";
import { validateItems, type Validated } from "@/lib/validate";
import { enqueueDailyRollup } from "@/lib/analytics";
import { recordInboundActivity, activityIdempotencyKey, undoInboundSideEffect } from "@/lib/activities";
import { INBOUND_MESSAGE_EVENT } from "@/lib/fields";

export const dynamic = "force-dynamic";

type InboundMessage = Validated<typeof INBOUND_MESSAGE_EVENT>;
type Entry = Record<string, unknown>;

export async function POST(request: Request) {
  const rawBody = await request.text();
  const denied = verifyInboundWebhook(request, rawBody);
  if (denied) return denied;

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // LinkedIn posts `value: [ … ]`. Reading it as an array is the whole gate here:
  // `for (const event of body.value)` threw on a number and walked the characters
  // of a string, answering 200 to a payload it had not looked at.
  const value = (body as { value?: unknown })?.value;
  if (value === undefined) return NextResponse.json({ ok: true });
  if (!Array.isArray(value)) {
    return NextResponse.json({ error: `linkedin posts value as an array, got ${describe(value)}` }, { status: 400 });
  }

  // Only messages are this route's business; the rest of LinkedIn's event
  // vocabulary is not something it has an opinion about.
  const messages = value.filter(isMessageReceived).map(toInboundMessage);
  const shape = validateItems<InboundMessage>(messages, "value", INBOUND_MESSAGE_EVENT);
  if (!shape.ok) return shape.error;

  for (const message of shape.items) {
    // Find contact by LinkedIn URN. `from` is required and text, and that is not
    // a type nit: an absent URN used to reach `contains: ""`, which matches every
    // contact that has a LinkedIn URL at all, and the reply was filed under the
    // first one.
    const handle = message.from.replace("urn:li:person:", "");
    const contact = await prisma.contact.findFirst({
      where: { linkedinUrl: { contains: handle } },
    });
    if (!contact) continue;

    const enrollment = await prisma.enrollment.findFirst({
      where: { contactId: contact.id, status: "ACTIVE" },
      orderBy: { enrolledAt: "desc" },
    });
    if (!enrollment) continue;

    const activity = await recordInboundActivity(
      activityIdempotencyKey({ channel: "LINKEDIN", messageId: message.messageId, activityType: "REPLIED" }),
      {
        enrollmentId: enrollment.id,
        contactId: contact.id,
        type: "REPLIED",
        channel: "LINKEDIN",
        messageId: message.messageId,
        metadata: { content: message.content },
      },
    );
    // A LinkedIn replay of the same messageUrn is already recorded; the row and its
    // side effects ran on the delivery that won the insert (#60). Skip, add nothing.
    if (!activity) continue;
    await enqueueDailyRollup(enrollment.id, activity.createdAt);
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: "REPLIED" } });
    try {
      await enqueue(queues.sequence, "process-step", { enrollmentId: enrollment.id, activityType: "REPLIED" });
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        // #65. The row, the day-count and the enrollment flip have committed;
        // the sequence step has not. A provider redelivery would see the row
        // and skip, so nothing downstream would drive this event. Undo the
        // committed side so the retry replays the whole shape rather than
        // silently swallowing it.
        await undoInboundSideEffect(activity.id, [
          () => prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: enrollment.status } }),
        ]);
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  }

  return NextResponse.json({ ok: true });
}

/**
 * The nesting is LinkedIn's, the fields are ours. `eventType` is compared as a
 * string first, so a non-object entry is filtered out rather than read; the three
 * values that reach a column are unwound here and type-checked as one
 * `INBOUND_MESSAGE_EVENT`, which is what the WhatsApp route posts too.
 */
function isMessageReceived(entry: unknown): entry is Entry {
  return entry !== null && typeof entry === "object" && !Array.isArray(entry) && (entry as Entry).eventType === "MESSAGE_RECEIVED";
}

function toInboundMessage(entry: Entry) {
  const from = entry.from as { comLinkedinVoyagerMessagingMemberUrn?: unknown } | undefined;
  const messageBody = entry.body as { text?: unknown } | undefined;
  return {
    messageId: entry.messageUrn,
    from: from?.comLinkedinVoyagerMessagingMemberUrn,
    content: messageBody?.text,
  };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
