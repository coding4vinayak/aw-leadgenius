// The three provider event receivers (/api/webhooks/email, /linkedin,
// /whatsapp) wrote tenant data on an unauthenticated request: a posted
// `event: "bounce"` set a SentMessage to BOUNCED and the enrollment under it to
// BOUNCED or UNSUBSCRIBED, and `open`/`click` fed the engagement numbers the AI
// reply step reads. Verification is a deployment-wide HMAC over the exact bytes,
// and the endpoints fail closed while it is unconfigured.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyInboundWebhook } from "../../src/lib/inbound-webhooks";
import { verifySignature } from "../../src/lib/webhooks";

const SECRET = "1f2f3a4b5c6d7e8f90a1b2c3d4e5f607";
const BODY = JSON.stringify([{ sg_message_id: "abc@example.com", event: "bounce" }]);

function signed(timestamp: string, body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function request(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/webhooks/email", { method: "POST", headers });
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

afterEach(() => {
  delete process.env.INBOUND_WEBHOOK_SIGNING_SECRET;
});

describe("verifyInboundWebhook", () => {
  it("fails closed when no signing secret is configured", async () => {
    const res = verifyInboundWebhook(request({ "x-inbound-timestamp": nowSeconds(), "x-inbound-signature": signed(nowSeconds(), BODY) }), BODY);
    assert.equal(res?.status, 503);
    assert.match((await res!.json() as { error: string }).error, /not configured/);
  });

  it("accepts a correctly signed, current request", () => {
    process.env.INBOUND_WEBHOOK_SIGNING_SECRET = SECRET;
    const ts = nowSeconds();
    assert.equal(verifyInboundWebhook(request({ "x-inbound-timestamp": ts, "x-inbound-signature": signed(ts, BODY) }), BODY), null);
  });

  it("rejects a signature computed over a different body", () => {
    process.env.INBOUND_WEBHOOK_SIGNING_SECRET = SECRET;
    const ts = nowSeconds();
    const res = verifyInboundWebhook(request({ "x-inbound-timestamp": ts, "x-inbound-signature": signed(ts, "[]") }), BODY);
    assert.equal(res?.status, 401);
  });

  it("rejects a valid signature for another secret", () => {
    process.env.INBOUND_WEBHOOK_SIGNING_SECRET = SECRET;
    const ts = nowSeconds();
    const res = verifyInboundWebhook(request({ "x-inbound-timestamp": ts, "x-inbound-signature": signed(ts, BODY, "attacker") }), BODY);
    assert.equal(res?.status, 401);
  });

  it("rejects the headers being omitted, which was the old bypass", () => {
    process.env.INBOUND_WEBHOOK_SIGNING_SECRET = SECRET;
    assert.equal(verifyInboundWebhook(request({}), BODY)?.status, 401);
    assert.equal(verifyInboundWebhook(request({ "x-inbound-timestamp": nowSeconds() }), BODY)?.status, 401);
  });

  it("rejects a replay from outside the accepted window", () => {
    process.env.INBOUND_WEBHOOK_SIGNING_SECRET = SECRET;
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const res = verifyInboundWebhook(request({ "x-inbound-timestamp": stale, "x-inbound-signature": signed(stale, BODY) }), BODY);
    assert.equal(res?.status, 401);
  });

  it("rejects a non-numeric timestamp rather than comparing NaN", () => {
    process.env.INBOUND_WEBHOOK_SIGNING_SECRET = SECRET;
    const res = verifyInboundWebhook(request({ "x-inbound-timestamp": "soon", "x-inbound-signature": signed("soon", BODY) }), BODY);
    assert.equal(res?.status, 401);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    process.env.INBOUND_WEBHOOK_SIGNING_SECRET = SECRET;
    const ts = nowSeconds();
    const res = verifyInboundWebhook(request({ "x-inbound-timestamp": ts, "x-inbound-signature": "deadbeef" }), BODY);
    assert.equal(res?.status, 401);
  });
});

describe("verifySignature", () => {
  const secret = "whsec_local";

  it("accepts its own HMAC", () => {
    const body = '{"event":"sent"}';
    const hex = createHmac("sha256", secret).update(body).digest("hex");
    assert.equal(verifySignature(secret, body, hex), true);
  });

  it("rejects a tampered body", () => {
    const hex = createHmac("sha256", secret).update('{"event":"sent"}').digest("hex");
    assert.equal(verifySignature(secret, '{"event":"bounced"}', hex), false);
  });

  // This used to be a 500: timingSafeEqual throws when the buffers differ in
  // length, so a short or non-hex signature crashed the handler instead of
  // being refused.
  it("returns false for a malformed signature instead of throwing", () => {
    for (const bad of ["", "x", "zz".repeat(64), "0".repeat(63), "0".repeat(65), "nope"]) {
      assert.equal(verifySignature(secret, "{}", bad), false, `accepted ${JSON.stringify(bad.slice(0, 12))}`);
    }
  });
});
