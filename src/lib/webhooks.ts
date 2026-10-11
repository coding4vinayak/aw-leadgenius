import { prisma } from "./db";
import { assertAllowedTarget } from "./egress";
import crypto from "crypto";

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

export async function triggerWebhooks(workspaceId: string, event: string, data: any): Promise<void> {
  const webhooks = await prisma.webhook.findMany({
    where: { workspaceId, isActive: true },
  });

  const matchingWebhooks = webhooks.filter(w => w.events.split(",").includes(event));
  const payload = { event, timestamp: new Date().toISOString(), data };
  await Promise.all(matchingWebhooks.map(w => deliverWebhook(w.id, payload)));
}