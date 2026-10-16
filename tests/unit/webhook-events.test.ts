// The dispatcher that almost nobody noticed was dead.
//
// `triggerWebhooks` shipped with zero call sites: subscriptions could be
// created, and nothing ever called the function that reads them, so every
// webhook this product advertised delivered nothing. This file pins both
// halves of the repair — the pure logic behaviorally, and the wiring that
// cannot be imported without a database by reading the source, the way the
// route scanners in this suite already do.
//
// If an event is added to `WEBHOOK_EVENTS` without an emitter, the per-event
// test below fails. If the emission is later deleted, the same test fails.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { WEBHOOK_EVENTS, matchesEvent, unknownEventsProblem } from "../../src/lib/webhooks";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "generated" ? [] : walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const SRC = walk(join(process.cwd(), "src"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

describe("webhook event matching", () => {
  it("matches an exact name in the stored comma string", () => {
    assert.equal(matchesEvent("contact.created,reply.received", "reply.received"), true);
    assert.equal(matchesEvent("contact.created", "contact.created"), true);
  });

  it("tolerates spaces a hand-edited row may carry", () => {
    assert.equal(matchesEvent("contact.created, reply.received", "reply.received"), true);
  });

  it("does not match a prefix of, or a different, event", () => {
    assert.equal(matchesEvent("reply.received", "reply.receive"), false);
    assert.equal(matchesEvent("contact.created", "contact.created_2"), false);
    assert.equal(matchesEvent("contact.created", "sequence.completed"), false);
  });
});

describe("unknown event refusal", () => {
  it("accepts every declared event", () => {
    assert.equal(unknownEventsProblem([...WEBHOOK_EVENTS]), null);
  });

  it("names the unknown ones and lists the valid set", () => {
    const problem = unknownEventsProblem(["lead.created", "deal.won"]);
    assert.ok(problem);
    assert.match(problem, /Unknown events: lead\.created, deal\.won/);
    for (const event of WEBHOOK_EVENTS) assert.ok(problem.includes(event), `problem must list ${event}`);
  });

  it("reports only the invalid names", () => {
    const problem = unknownEventsProblem(["contact.created", "nope.happened"]);
    assert.ok(problem);
    const invalidPart = problem.split(". Valid events:")[0];
    assert.equal(invalidPart, "Unknown events: nope.happened");
  });
});

describe("emission wiring", () => {
  for (const event of WEBHOOK_EVENTS) {
    it(`emits ${event} from a call site`, () => {
      const pattern = new RegExp(`triggerWebhooks\\([^\\n]*"${event.replace(/\./g, "\\.")}"`);
      assert.match(SRC, pattern, `no triggerWebhooks call site names ${event}`);
    });
  }

  it("stamps each logical event with a stable id", () => {
    assert.match(SRC, /id: `evt_\$\{crypto\.randomBytes/);
  });

  it("delivers the family header and the generic one, so nuCRM can verify it", () => {
    assert.match(SRC, /"X-LeadGenius-Signature": signature/);
    assert.match(SRC, /"X-Webhook-Signature": `sha256=\$\{signature\}`/);
  });

  it("refuses unknown names on both subscription writes", () => {
    const list = readFileSync(join(process.cwd(), "src/app/api/webhooks/route.ts"), "utf8");
    const patch = readFileSync(join(process.cwd(), "src/app/api/webhooks/[id]/route.ts"), "utf8");
    assert.match(list, /unknownEventsProblem\(events\.values\)/);
    assert.match(patch, /unknownEventsProblem\(events\.values\)/);
  });
});
