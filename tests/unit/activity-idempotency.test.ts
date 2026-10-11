// #60: the three provider webhooks committed an Activity row, then answered 503
// when the inline sequence enqueue failed. The provider retries a 503, and the
// retry re-inserted the row — the rollup then counted the same open twice. The fix
// is a database-level idempotency gate (`Activity.idempotencyKey @unique`) driven by
// a provider-derived key, so a redelivery collides on the index and is skipped, while
// a genuine second event — a different message, or the provider's own new event time
// — still records.
//
// Two kinds of check live here. The key's *behaviour* is a pure function and is
// tested directly (this is the property the HTTP after-probe could only show for
// email). The wiring that keeps the routes from drifting back to a bare
// `prisma.activity.create` is read from source, comment-stripped so a prose mention
// of the old call can never satisfy the guard.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activityIdempotencyKey } from "../../src/lib/activities";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const helper = source("../../src/lib/activities.ts");
const routes: Record<string, string> = {
  email: source("../../src/app/api/webhooks/email/route.ts"),
  whatsapp: source("../../src/app/api/webhooks/whatsapp/route.ts"),
  linkedin: source("../../src/app/api/webhooks/linkedin/route.ts"),
};

describe("activityIdempotencyKey reproduces a provider redelivery", () => {
  const at = new Date(1700000000000);
  const base = { channel: "EMAIL", messageId: "msg-1", activityType: "OPENED", timestamp: at };

  // The whole point: a retry replays the provider's own fields verbatim, so the key
  // is byte-identical and the unique index rejects the second insert.
  it("is byte-identical for the same event fields", () => {
    assert.equal(activityIdempotencyKey(base), activityIdempotencyKey({ ...base }));
  });

  // Each of these is a *genuine* second event, and must not be swallowed by the gate.
  it("differs when the provider's own event timestamp differs", () => {
    assert.notEqual(
      activityIdempotencyKey({ ...base, timestamp: new Date(1700000600000) }),
      activityIdempotencyKey(base),
    );
  });
  it("differs when the message differs", () => {
    assert.notEqual(activityIdempotencyKey({ ...base, messageId: "msg-2" }), activityIdempotencyKey(base));
  });
  it("differs when the activity type differs", () => {
    assert.notEqual(activityIdempotencyKey({ ...base, activityType: "CLICKED" }), activityIdempotencyKey(base));
  });
  it("differs across channels that share a message id", () => {
    assert.notEqual(activityIdempotencyKey({ ...base, channel: "WHATSAPP" }), activityIdempotencyKey(base));
  });

  // The key is the provider's event time, never our clock: a fresh `new Date()` on
  // every attempt would mint a new key per retry and deduplicate nothing.
  it("encodes the provider ms, not wall-clock construction", () => {
    assert.match(activityIdempotencyKey(base), /:1700000000000$/);
  });

  // WhatsApp/LinkedIn key on the message id alone (one REPLIED per inbound message),
  // so a message with no provider timestamp must still produce a stable, distinct key.
  it("pins the timestamp segment to no-ts when none is given", () => {
    const noTs = { channel: "WHATSAPP", messageId: "sid-1", activityType: "REPLIED" };
    assert.equal(activityIdempotencyKey(noTs), activityIdempotencyKey({ ...noTs }));
    assert.match(activityIdempotencyKey(noTs), /:no-ts$/);
    assert.notEqual(activityIdempotencyKey({ ...noTs, messageId: "sid-2" }), activityIdempotencyKey(noTs));
  });
});

describe("the webhook routes write through the idempotency gate", () => {
  for (const [name, body] of Object.entries(routes)) {
    it(`${name} imports the helper and the key builder`, () => {
      assert.match(body, /from "@\/lib\/activities"/);
      assert.match(body, /recordInboundActivity/);
      assert.match(body, /activityIdempotencyKey\(/);
    });

    // The regression itself: a bare insert is what a provider retry re-ran.
    it(`${name} records no Activity with a bare prisma.activity.create`, () => {
      assert.doesNotMatch(body, /prisma\.activity\.create/);
    });

    // null means "already recorded"; the route must stop, not re-drive the rollup/step.
    it(`${name} short-circuits when the gate returns null`, () => {
      assert.match(body, /if \(!activity\)/);
    });
  }

  // The key a redelivery can reproduce is what makes EMAIL dedupe across the day;
  // the reply channels key on the message alone (no timestamp), which is the shape
  // the routes declare — so assert the two differ on purpose, not by accident.
  it("EMAIL keys on the provider event time; REPLIED channels key on the message", () => {
    assert.match(routes.email, /activityIdempotencyKey\(\{ channel: "EMAIL", messageId, activityType, timestamp \}\)/);
    assert.match(routes.whatsapp, /activityIdempotencyKey\(\{ channel: "WHATSAPP", messageId: message\.messageId, activityType: "REPLIED" \}\)/);
    assert.match(routes.linkedin, /activityIdempotencyKey\(\{ channel: "LINKEDIN", messageId: message\.messageId, activityType: "REPLIED" \}\)/);
  });
});

describe("recordInboundActivity treats only a unique clash as already-recorded", () => {
  // The gate is the P2002 unique-violation, not a read-then-write (which races the
  // retry). Anything else must propagate so a real fault is not silently dropped.
  it("returns null only for P2002 and rethrows everything else", () => {
    assert.match(helper, /code === "P2002"\) return null/);
    assert.match(helper, /throw error/);
    assert.doesNotMatch(helper, /findFirst[\s\S]*create/);
  });
});
