// Attribution is the "what is actually working" read: the same Activity rows
// the daily engine rolls up, folded by channel and by A/B variant, plus the
// drift check that keeps the two views honest. The grouping arithmetic lives in
// pure reducers so this file can pin it without a database — the same shape as
// the analytics breakdown, where every segment number comes from the engine's
// own source and a presentation cannot invent a reply.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldAttribution, diffCounters } from "../../src/lib/attribution";

type Row = { type: string; channel?: string; variant?: string | null };

const row = (type: string, channel: string, variant: string | null = null): Row => ({ type, channel, variant });

describe("foldAttribution", () => {
  it("folds the funnel counters per key, mirroring the daily rollup's switch", () => {
    const rows = [
      row("SENT", "EMAIL"), row("SENT", "EMAIL"), row("DELIVERED", "EMAIL"),
      row("OPENED", "EMAIL"), row("REPLIED", "EMAIL"),
      row("SENT", "WHATSAPP"), row("REPLIED", "WHATSAPP"), row("REPLIED", "WHATSAPP"),
    ];
    const byChannel = foldAttribution(rows, (r) => r.channel!);
    assert.deepEqual(byChannel.map((r) => [r.key, r.sent, r.delivered, r.opened, r.replied]), [
      ["WHATSAPP", 1, 0, 0, 2],
      ["EMAIL", 2, 1, 1, 1],
    ]);
  });

  it("orders by replies first, then sends, then name — the money answer is the top row", () => {
    const rows = [
      row("REPLIED", "A"), row("REPLIED", "A"),
      row("REPLIED", "B"),
      row("SENT", "C"), row("SENT", "C"), row("SENT", "C"),
    ];
    assert.deepEqual(foldAttribution(rows, (r) => r.channel!).map((r) => r.key), ["A", "B", "C"]);
  });

  it("ignores event types the funnel does not count instead of crashing on them", () => {
    const rows = [row("FAILED", "EMAIL"), row("UNSUBSCRIBED", "EMAIL"), row("SENT", "EMAIL")];
    const [email] = foldAttribution(rows, (r) => r.channel!);
    assert.deepEqual([email.sent, email.replied, email.bounced], [1, 0, 0]);
  });

  it("groups by variant only when one is named", () => {
    const rows = [
      row("SENT", "EMAIL", "control"), row("REPLIED", "EMAIL", "control"),
      row("SENT", "EMAIL", "variant_a"), row("SENT", "EMAIL", "variant_a"), row("REPLIED", "EMAIL", "variant_a"), row("REPLIED", "EMAIL", "variant_a"),
    ];
    const byVariant = foldAttribution(rows.filter((r) => r.variant), (r) => r.variant!);
    assert.deepEqual(byVariant.map((r) => [r.key, r.sent, r.replied]), [["variant_a", 2, 2], ["control", 1, 1]]);
  });
});

describe("diffCounters", () => {
  const zero = { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0 };

  it("returns nothing when the fold and the rollup agree", () => {
    assert.deepEqual(diffCounters({ ...zero, sent: 9, replied: 2 }, { ...zero, sent: 9, replied: 2 }), []);
  });

  it("names every counter that disagrees, in both directions", () => {
    const drift = diffCounters({ ...zero, sent: 12, replied: 1 }, { ...zero, sent: 11, replied: 3 });
    assert.deepEqual(drift, [
      { counter: "sent", activities: 12, rollup: 11 },
      { counter: "replied", activities: 1, rollup: 3 },
    ]);
  });
});
