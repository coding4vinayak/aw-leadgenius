// The channel with no feedback loop gets one voice: the words the send itself
// returns. Before this, `sendLinkedIn` failures — no URL, an unresolvable
// member, a provider 400 that names the recipient — stamped the row `FAILED`
// and stopped, so a prospect who could NEVER receive a LinkedIn message stayed
// ACTIVE to the enroll guard and failed every LinkedIn step forever, while the
// sequence walked on as if they were reachable.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sendFailureDisposition } from "../../src/lib/sequence-engine";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

describe("sendFailureDisposition — what a send-time rejection means", () => {
  it("reads the channel function's own recipient-named reasons as this channel's bounce", () => {
    assert.equal(sendFailureDisposition("LINKEDIN", "Contact has no LinkedIn URL"), "BOUNCED");
    assert.equal(sendFailureDisposition("LINKEDIN", "Could not resolve LinkedIn member URN"), "BOUNCED");
    assert.equal(sendFailureDisposition("LINKEDIN", "contact has no linkedin url"), "BOUNCED");
  });

  it("reads a provider 400/404 that says the word recipient as a bounce", () => {
    assert.equal(sendFailureDisposition("LINKEDIN", "LinkedIn API error 400: The requested recipient could not be found"), "BOUNCED");
    assert.equal(sendFailureDisposition("LINKEDIN", "LinkedIn API error 404: recipient unavailable"), "BOUNCED");
  });

  it("a rejection that names our token, the rate limiter or the day accuses nobody", () => {
    assert.equal(sendFailureDisposition("LINKEDIN", "LinkedIn API error 401: invalid access token"), null);
    assert.equal(sendFailureDisposition("LINKEDIN", "LinkedIn API error 403: not authorized"), null);
    assert.equal(sendFailureDisposition("LINKEDIN", "LinkedIn API error 429: too many requests, retry for recipient later"), null);
    assert.equal(sendFailureDisposition("LINKEDIN", "LinkedIn API error 500: The requested recipient exists on our side"), null);
  });

  it("an error this table has never seen marks nobody dead — guessed nothing, not guessed dead", () => {
    assert.equal(sendFailureDisposition("LINKEDIN", "ECONNREFUSED 127.0.0.1:3311"), null);
    assert.equal(sendFailureDisposition("LINKEDIN", "LinkedIn API error 451: recipient legal hold"), null);
    assert.equal(sendFailureDisposition("LINKEDIN", ""), null);
    assert.equal(sendFailureDisposition("LINKEDIN", null), null);
    assert.equal(sendFailureDisposition("LINKEDIN", undefined), null);
  });

  it("says nothing for channels whose providers can still post back — their loop is the webhook", () => {
    assert.equal(sendFailureDisposition("EMAIL", "Message failed: 550 no such user"), null);
    assert.equal(sendFailureDisposition("WHATSAPP", "Twilio API error 21211: Not a valid mobile number"), null);
    assert.equal(sendFailureDisposition("SMTP", "Contact has no LinkedIn URL"), null);
  });
});

describe("the send worker consults the disposition", () => {
  const queue = source("../../src/lib/queue.ts");
  const branch = /if \(!result\.success && msg\.enrollmentId\) \{[\s\S]*?\n    \}\n\n    if \(result\.success && msg\.enrollmentId\)/.exec(queue)?.[0] ?? "";

  it("the row flips first — the message's own state never depends on the lifecycle read", () => {
    const flip = queue.indexOf('status: result.success ? "SENT" : "FAILED"');
    const consult = queue.indexOf("sendFailureDisposition(");
    assert.ok(flip >= 0 && consult > flip, "FAILED/SENT flip precedes the disposition");
  });

  it("a BOUNCED disposition writes the email webhook's bounce shape", () => {
    assert.ok(branch, "the failure branch is defined");
    assert.match(branch, /disposition === "BOUNCED"/);
    assert.match(branch, /recordInboundActivity\(\s*activityIdempotencyKey\(\{ channel: msg\.channel, messageId: msg\.id, activityType: "BOUNCED" \}\)/);
    assert.match(branch, /statusAfterProviderSignal\(priorContact\.status, "BOUNCED"\)/);
    assert.match(branch, /data: \{ status: "BOUNCED" \}/);
  });

  it("a dead Redis cannot undo a stop that has no redelivery to replay it", () => {
    assert.match(branch, /error instanceof QueueUnavailableError/);
    assert.doesNotMatch(branch, /undoInboundSideEffect/);
  });

  it("LinkedIn's stand-in host is the operator's env, like every legal host — and the status names the rejecter", () => {
    const channel = source("../../src/lib/channels/linkedin.ts");
    assert.match(channel, /process\.env\.LINKEDIN_API_BASE \?\? "https:\/\/api\.linkedin\.com"/);
    assert.match(channel, /fetch\(`\$\{apiBase\}\/v2\/messages`,/);
    assert.match(channel, /LinkedIn API error \$\{response\.status\}: /);
  });
});
