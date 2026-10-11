import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Inbound provider webhooks (SendGrid/Mailgun/Postmark events, Twilio WhatsApp,
 * LinkedIn messages).
 *
 * These endpoints used to trust the request: no key, no signature, nothing. Any
 * anonymous caller could POST `{"sg_message_id": "…", "event": "bounce"}` and
 * mark another tenant's message BOUNCED — which sets the enrollment to
 * BOUNCED/UNSUBSCRIBED and drives the sequence engine. Forging `open`/`click`
 * inflates the engagement numbers the AI reply step reads. Unsubscribe state is
 * the one thing here that has a legal consequence, so "we'll verify when real
 * providers are connected" is not a defensible way to leave it.
 *
 * Provider-native verification (SendGrid's ECDSA events token, Twilio's
 * X-Twilio-Signature, Postmark's HMAC) needs per-account credentials that no
 * deployment has yet, and an implementation that cannot be checked against real
 * traffic is worse than one that can be: it reads as verified while being
 * guesswork. So this is the portable construction instead — a shared signing
 * secret per deployment, HMAC over the raw body with a timestamp, the same shape
 * Stripe and GitHub use. It proves the sender holds the secret, which is the
 * property the endpoint was missing.
 *
 * Fail-closed by design: with INBOUND_WEBHOOK_SIGNING_SECRET unset the endpoint
 * answers 503 rather than accepting anything. A misconfigured deployment shows
 * up as a broken integration, not as a silent open door.
 */

const MAX_SKEW_SECONDS = 300;

function sign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** The header value an integrator computes for a given body — also what the tests use. */
export function inboundSignature(secret: string, timestamp: string, rawBody: string): string {
  return sign(secret, timestamp, rawBody);
}

/**
 * Returns null when the request is authenticated, otherwise the response to
 * send. The raw body is passed in rather than re-read, because a Request stream
 * can only be consumed once and the signature is over those exact bytes.
 */
export function verifyInboundWebhook(request: Request, rawBody: string): NextResponse | null {
  const secret = process.env.INBOUND_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Inbound webhook verification is not configured on this deployment (set INBOUND_WEBHOOK_SIGNING_SECRET)." },
      { status: 503 },
    );
  }

  const timestamp = request.headers.get("x-inbound-timestamp");
  const signature = request.headers.get("x-inbound-signature");
  if (!timestamp || !signature) {
    return NextResponse.json({ error: "Missing x-inbound-timestamp or x-inbound-signature." }, { status: 401 });
  }

  const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_SECONDS) {
    return NextResponse.json({ error: "Webhook timestamp is outside the accepted window." }, { status: 401 });
  }

  // Both sides are hex digests of a fixed length, so equal length is expected —
  // but a caller can send anything, and timingSafeEqual throws on a length
  // mismatch. A throw here would be a 500 for a wrong signature, i.e. a free way
  // to make the endpoint fail loudly.
  const expected = Buffer.from(sign(secret, timestamp, rawBody), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  return null;
}
