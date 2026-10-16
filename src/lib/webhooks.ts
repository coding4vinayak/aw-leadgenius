import { prisma } from "./db";
import { assertAllowedTarget } from "./egress";
import crypto from "crypto";

/**
 * The events this product emits, and the only events a subscription may name.
 *
 * The list exists because the alternative shipped and failed: `triggerWebhooks`
 * below had zero callers, so every subscription filtered on a name nothing ever
 * sent, and a typo in `events` was indistinguishable from a correct name for an
 * event that did not exist yet. `unknownEventsProblem` refuses the typo at
 * subscription time, `tests/unit/webhook-events.test.ts` refuses a declared
 * event with no emitter, and the README documents these three names as the
 * contract. Adding an event is two lines — the name here, the emission there —
 * and the guard fails until both exist.
 */
export const WEBHOOK_EVENTS = ["contact.created", "reply.received", "sequence.completed"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Whether a subscription's stored comma string names this event. */
export function matchesEvent(stored: string, event: string): boolean {
  return stored
    .split(",")
    .map((s) => s.trim())
    .includes(event);
}

/** The reason to show the caller, or null when every name is one this product emits. */
export function unknownEventsProblem(requested: string[]): string | null {
  const invalid = requested.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (invalid.length === 0) return null;
  return `Unknown events: ${invalid.join(", ")}. Valid events: ${WEBHOOK_EVENTS.join(", ")}`;
}

export async function deliverWebhook(webhookId: string, payload: any): Promise<void> {
  const webhook = await prisma.webhook.findUnique({ where: { id: webhookId } });
  if (!webhook || !webhook.isActive) return;

  const signature = generateSignature(webhook.secret, payload);

  try {
    await assertAllowedTarget(webhook.url, "url");
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LeadGenius-Signature": signature,
        // The same digest, spelled the way receivers outside this family
        // expect: `sha256=` + hex over the raw body is GitHub's convention and
        // what an inbound nuCRM plugin webhook verifies. The family header
        // stays byte-identical — a receiver that already verifies it keeps
        // working, and one that only knows the generic name now does too.
        "X-Webhook-Signature": `sha256=${signature}`,
        "X-LeadGenius-Event": payload.event,
        "User-Agent": "LeadGenius-Webhook/1.0",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`Webhook delivery failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error("Webhook delivery error:", error);
  }
}

function generateSignature(secret: string, payload: any): string {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

export function verifySignature(secret: string, payload: string, signature: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  // timingSafeEqual throws when the buffers differ in length, so a caller
  // sending "x" would get a 500 rather than a 401 — and any short body of the
  // right length would do the same. Digest length is public, so comparing it
  // first leaks nothing the attacker does not already know.
  if (typeof signature !== "string" || signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
}

/**
 * Deliver one emitted event to every subscribed webhook.
 *
 * Best-effort and never throwing, because every call site is a route or engine
 * step that already did the thing it was asked and only owes a notification —
 * a receiver's outage must not fail a contact create, a reply ingest or a
 * finished sequence. Inline rather than queued, in the same shape leadworks
 * states for its dispatcher: `deliverWebhook` re-reads the row, signs, makes
 * one attempt and logs a failure. The queue's `webhook` arm stays reserved for
 * the relay path (`POST /api/webhooks/events`), whose jobs carry a caller-built
 * payload the dispatcher has no part in.
 *
 * `id` is stable across every endpoint of one logical event — a receiver that
 * dedupes on it is already correct on the day delivery grows retries.
 */
export async function triggerWebhooks(workspaceId: string, event: WebhookEvent, data: unknown): Promise<void> {
  let webhooks;
  try {
    webhooks = await prisma.webhook.findMany({ where: { workspaceId, isActive: true } });
  } catch (error) {
    console.warn("[webhooks] could not load subscriptions:", error);
    return;
  }

  const matching = webhooks.filter((w) => matchesEvent(w.events, event));
  if (matching.length === 0) return;

  const payload = {
    id: `evt_${crypto.randomBytes(12).toString("base64url")}`,
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  await Promise.allSettled(matching.map((w) => deliverWebhook(w.id, payload)));
}
