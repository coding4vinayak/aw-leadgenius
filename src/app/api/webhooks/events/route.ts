import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifySignature } from "@/lib/webhooks";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { validateBody } from "@/lib/validate";
import { EVENTS_ENVELOPE } from "@/lib/fields";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const signature = request.headers.get("x-leadgenius-signature");
  const event = request.headers.get("x-leadgenius-event");
  const rawBody = await request.text();

  const webhookId = request.headers.get("x-leadgenius-webhook-id");
  if (!webhookId) return NextResponse.json({ error: "Missing webhook ID" }, { status: 400 });

  const webhook = await prisma.webhook.findUnique({ where: { id: webhookId } });
  if (!webhook || !webhook.isActive) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });

  // `if (signature && !verify)` only checked the signature when a caller chose
  // to send one, so omitting the header was the bypass. The signature is now
  // what authenticates the request and its absence is the 401.
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  if (!verifySignature(webhook.secret, rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // `payload.event = …` was the 500: assigning a property to a number, a string
  // or null throws, and a signed request can send any of those. The envelope is
  // built instead of mutated, so the object-ness that `EVENTS_ENVELOPE` needs is
  // checked rather than assumed.
  const envelope = validateBody(payload, EVENTS_ENVELOPE);
  if (!envelope.ok) return envelope.error;

  const body = { ...(payload as Record<string, unknown>), event: event || envelope.data.event };

  try {
      await enqueue(queues.webhook, "deliver", { webhookId, payload: body });
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

  return NextResponse.json({ ok: true });
}