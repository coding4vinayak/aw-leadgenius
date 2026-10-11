import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { verifyInboundWebhook } from "@/lib/inbound-webhooks";
import { validateItems, type Validated } from "@/lib/validate";
import { enqueueDailyRollup } from "@/lib/analytics";
import { recordInboundActivity, activityIdempotencyKey, undoInboundSideEffect } from "@/lib/activities";
import { INBOUND_EMAIL_EVENT } from "@/lib/fields";

export const dynamic = "force-dynamic";

type EmailEvent = Validated<typeof INBOUND_EMAIL_EVENT>;

export async function POST(request: Request) {
  // The signature is over the exact bytes, so the body is read as text once and
  // parsed from there rather than streamed through request.json().
  const rawBody = await request.text();
  const denied = verifyInboundWebhook(request, rawBody);
  if (denied) return denied;

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const provider = request.headers.get("x-provider") || "unknown";

  // Normalize different provider formats to our internal format, then hold the
  // normalised event to the one table every provider's values have to satisfy
  // before a column sees them.
  const normalized = normalizeEmailEvents(provider, body);
  if (!normalized.ok) return normalized.error;

  const shape = validateItems<EmailEvent>(normalized.events, "events", INBOUND_EMAIL_EVENT);
  if (!shape.ok) return shape.error;

  for (const evt of shape.items) {
    const { messageId, event: eventType, metadata, timestamp } = evt;

    const sentMessage = await prisma.sentMessage.findFirst({ where: { providerMessageId: messageId } });
    if (!sentMessage) continue;

    const activityType = mapEmailEvent(eventType);
    if (!activityType) continue;

    if (sentMessage.enrollmentId) {
      const activity = await recordInboundActivity(
        activityIdempotencyKey({ channel: "EMAIL", messageId, activityType, timestamp }),
        {
          enrollmentId: sentMessage.enrollmentId,
          contactId: sentMessage.contactId,
          type: activityType,
          channel: "EMAIL",
          messageId,
          // No provider timestamp is no event time: the row keeps saying when we
          // heard it, the way it did before this table existed.
          metadata: { provider, ...metadata, timestamp: timestamp ?? new Date() },
        },
      );
      // A redelivery of an event we already recorded is a no-op. The row and its
      // side effects ran on the delivery that won the unique insert (#60), so this
      // one adds nothing and must not re-drive them.
      if (!activity) continue;

      // The day this row landed in is the day the rollup recomputes, because
      // aggregateAnalytics windows on createdAt, not on the provider's timestamp.
      await enqueueDailyRollup(sentMessage.enrollmentId, activity.createdAt);

      // #65. Pre-images captured before any write in the BOUNCED/COMPLAINED
      // branch, so the catch has something to revert to. OPENED and CLICKED
      // never flip a status, so they carry no reverts and the undo only
      // deletes the Activity row for them.
      const reverts: Array<() => Promise<unknown>> = [];

      if (activityType === "BOUNCED" || activityType === "COMPLAINED") {
        const enrollmentId = sentMessage.enrollmentId;
        const priorEnrollment = await prisma.enrollment.findUnique({
          where: { id: enrollmentId },
          select: { status: true },
        });
        const priorSentMessageStatus = sentMessage.status;
        await prisma.sentMessage.update({ where: { id: sentMessage.id }, data: { status: activityType } });
        await prisma.enrollment.update({
          where: { id: enrollmentId },
          data: { status: activityType === "BOUNCED" ? "BOUNCED" : "UNSUBSCRIBED" },
        });
        if (priorEnrollment) {
          const back = priorEnrollment.status;
          reverts.push(() => prisma.enrollment.update({ where: { id: enrollmentId }, data: { status: back } }));
        }
        reverts.push(() => prisma.sentMessage.update({ where: { id: sentMessage.id }, data: { status: priorSentMessageStatus } }));
      }

      try {
        await enqueue(queues.sequence, "process-step", { enrollmentId: sentMessage.enrollmentId, activityType });
      } catch (error) {
        if (error instanceof QueueUnavailableError) {
          // #65. Undo the committed side so a redelivery replays rather than
          // silently skipping on the idempotency gate.
          await undoInboundSideEffect(activity.id, reverts);
          return NextResponse.json({ error: error.message }, { status: error.status });
        }
        throw error;
      }
    }
  }

  return NextResponse.json({ ok: true });
}

/**
 * Rename the provider's keys and nothing else. Every value is passed through as
 * the provider sent it, so a wrong type arrives at `INBOUND_EMAIL_EVENT` as the
 * provider's own mistake and is named as one; the single translation is units,
 * because two of these three post epoch seconds where the table speaks ISO.
 *
 * `?.` everywhere: the entries are provider JSON, and reading a property of one
 * is total even when the entry is `null` or a number.
 */
function normalizeEmailEvents(provider: string, body: unknown): { ok: true; events: unknown[] } | { ok: false; error: NextResponse } {
  const entry = (e: any, messageId: unknown, event: unknown, timestamp: unknown, metadata: Record<string, unknown>) => ({
    messageId,
    event,
    email: e?.email,
    timestamp: epochToIso(timestamp) ?? timestamp,
    metadata,
  });

  switch (provider) {
    case "sendgrid":
      // SendGrid posts an array and the other two a single object; `body.map` was
      // the 500 when the array was not there.
      if (!Array.isArray(body)) {
        return {
          ok: false,
          error: NextResponse.json({ error: `sendgrid posts an array of events, got ${describe(body)}` }, { status: 400 }),
        };
      }
      return {
        ok: true,
        events: body.map((e: any) =>
          entry(e, e?.sg_message_id || e?.sg_event_id, e?.event, e?.timestamp, {
            ip: e?.ip,
            useragent: e?.useragent,
            url: e?.url,
            reason: e?.reason,
            status: e?.status,
          }),
        ),
      };
    case "mailgun": {
      const e = body as any;
      return {
        ok: true,
        events: [entry(e, e?.["message-id"] || e?.["Message-Id"], e?.event, e?.timestamp, {
          ip: e?.ip,
          useragent: e?.["client-user-agent"],
          url: e?.url,
          reason: e?.reason,
          code: e?.code,
        })],
      };
    }
    case "postmark": {
      const e = body as any;
      return {
        ok: true,
        events: [entry(e, e?.MessageID, e?.Type, e?.ReceivedAt, {
          bounceType: e?.BounceType,
          bounceDescription: e?.Description,
          tag: e?.Tag,
        })],
      };
    }
    default:
      // A provider this deployment does not know how to read. Not a 400: the
      // signature already authorized the sender, and the header is ours to set,
      // so a wrong one is a configuration to fix rather than a payload to refuse.
      return { ok: true, events: [] };
  }
}

/** Epoch seconds, which is what all three post. Anything else is left alone. */
function epochToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function mapEmailEvent(event: string): string | null {
  const map: Record<string, string> = {
    delivered: "DELIVERED",
    open: "OPENED",
    click: "CLICKED",
    bounce: "BOUNCED",
    spamreport: "COMPLAINED",
    unsubscribe: "UNSUBSCRIBED",
    blocked: "BOUNCED",
    deferred: "FAILED",
    processed: "SENT",
    accepted: "SENT",
    sent: "SENT",
  };
  return map[event.toLowerCase()] || null;
}
