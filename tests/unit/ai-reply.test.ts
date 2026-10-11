// Guard-rail tests for AI reply drafting. No network, no key, no DB.
// The property under test: the deterministic classifier is authoritative,
// and drafting degrades to null — never to a fabricated reply.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReplyDeterministic,
  draftReply,
} from "../../src/lib/ai-reply";

beforeEach(() => {
  // These tests prove the offline contract; a stray key in CI would turn
  // them into network tests, so the environment is pinned, not assumed.
  delete process.env.LLM_API_KEY;
});

const base = {
  originalMessage: "Hi — we help teams follow up faster. Worth a look?",
  productContext: "LeadGenius sends outreach sequences.",
  knownFacts: ["14-day trial"],
  lead: { firstName: "Ada", company: "Acme", email: "ada@acme.test" },
};

describe("classifyReplyDeterministic", () => {
  it("catches every common phrasing of an opt-out", () => {
    for (const text of [
      "Please unsubscribe me",
      "STOP EMAILING ME",
      "remove me from your list",
      "do not contact me again",
      "Not interested, thanks",
      "no thanks",
      "Please opt out",
    ]) {
      const signal = classifyReplyDeterministic(text);
      assert.equal(signal.kind, "unsubscribe", `missed opt-out: "${text}"`);
    }
  });

  it("distinguishes objections, positives and questions", () => {
    assert.equal(classifyReplyDeterministic("Too expensive for us right now").kind, "objection");
    assert.equal(classifyReplyDeterministic("Sounds good, let's schedule a call").kind, "positive");
    assert.equal(classifyReplyDeterministic("Sounds interesting, tell me more").kind, "positive");
    assert.equal(classifyReplyDeterministic("How much does the team plan cost?").kind, "question");
    assert.equal(classifyReplyDeterministic("ok").kind, "other");
  });
});

describe("draftReply offline contract", () => {
  it("returns null when no model is configured — no fabricated fallback", async () => {
    const draft = await draftReply({ ...base, reply: "Tell me more" });
    assert.equal(draft, null);
  });

  it("honours an opt-out without calling a model, even with a key set", async () => {
    // A fake key proves the point: if the code path touched the provider,
    // this would hang on the network instead of returning instantly.
    process.env.LLM_API_KEY = "test-key-that-must-never-be-used";
    const began = Date.now();
    const draft = await draftReply({ ...base, reply: "Unsubscribe me please" });
    const elapsed = Date.now() - began;
    assert.equal(draft, null);
    assert.ok(elapsed < 2000, `opt-out took ${elapsed}ms — it must never wait on a provider`);
    delete process.env.LLM_API_KEY;
  });
});
