// #25 refused an EMAIL step whose template was written for another carrier, and
// named the harm in its own message: `sendEmail` titles an unrendered subject
// "New message". It never asked the other half of that sentence. `Template.subject`
// is optional at both template doors — the schema comments it `// For email` and no
// code reads the comment as a rule — so `channel: "EMAIL"` with the subject left out
// is a legal 201 today that still mails the fallback, and a subject written on a
// LinkedIn or WhatsApp template is stored, returned by every read and delivered to
// nobody. This round makes the column mean what the channel says, at both doors that
// write it and at the send that would otherwise meet it in front of a prospect.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EMAIL_CHANNEL,
  hasSubject,
  sendSubjectProblem,
  subjectExpectation,
  subjectProblem,
} from "../../src/lib/subject-fit";
import { STEP_CHANNELS, TEMPLATE_CHANNELS } from "../../src/lib/enums";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const row = (name: string, channel: string, subject: string | null | undefined) => ({ name, channel, subject });
const carrier = (stepNumber: number, channel: string) => ({ stepNumber, channel });

/**
 * A caller re-deriving the verdict would test, in its own sentence, whether the
 * subject is filled. Both doors read the row they are about to write and hand it
 * to the module, so an emptiness test anywhere else is a second definition of
 * "blank" — the exact drift this fleet keeps having to unmake.
 *
 * `channel` compared with the word `EMAIL` is the other half of the same
 * re-derivation, and it is forbidden only in the two template doors: the engine's
 * own `step.channel === "EMAIL"` is not a verdict about a subject but the
 * rendering rule the module's message is built on — the fact the guards below
 * re-read from the source.
 */
const BLANK_TEST = /\.subject\s*[!=]==\s*["'][^"']*["']|\.subject\s*\.\s*(?:trim|length)|!\s*[\w.]+\.subject\b|hasSubject\s*\(/;
const CHANNEL_TEST = /\.channel\s*[!=]==\s*["']EMAIL["']|["']EMAIL["']\s*[!=]==\s*\w*\.?channel/;

describe("subjectExpectation", () => {
  it("makes EMAIL the one channel whose subject is mandatory, and every other its own dead copy", () => {
    assert.equal(subjectExpectation("EMAIL"), "required");
    assert.equal(subjectExpectation("LINKEDIN"), "forbidden");
    assert.equal(subjectExpectation("WHATSAPP"), "forbidden");
    assert.equal(subjectExpectation("MULTI"), "forbidden");
    assert.equal(subjectExpectation("CALL"), "forbidden");
  });

  it("is decided by one word, and the vocabulary says which channels can appear at all", () => {
    const verdicts = (TEMPLATE_CHANNELS as readonly string[]).map(subjectExpectation);
    assert.deepEqual(verdicts, ["required", "forbidden", "forbidden"]);
    // The comparison is not a lookup into a table that could drift: a channel
    // that is not email gets the same answer whether it is a template channel, a
    // step-only channel, or a value no enum lists.
    assert.equal(subjectExpectation("FAX"), "forbidden");
  });
});

describe("hasSubject", () => {
  it("counts written text a subject, and the three shapes of not-written as its absence", () => {
    assert.equal(hasSubject("{{firstName}} - a question"), true);
    assert.equal(hasSubject(""), false);
    assert.equal(hasSubject(null), false);
    assert.equal(hasSubject(undefined), false);
  });

  it("calls whitespace-only blank, because the boundary trims before this is ever asked", () => {
    assert.equal(hasSubject("   "), false);
    assert.equal(hasSubject("\t\n "), false);
    assert.equal(hasSubject(" Re: hello "), true);
  });
});

describe("subjectProblem", () => {
  it("passes an email template that carries the line the email sender will send", () => {
    assert.equal(subjectProblem(row("Intro", "EMAIL", "{{firstName}} - a question")), null);
  });

  it("refuses an email template with no subject by the name of the fallback it would mail", () => {
    for (const blank of [null, undefined, "", "   "]) {
      const problem = subjectProblem(row("Intro", "EMAIL", blank));
      assert.ok(problem, `blank ${JSON.stringify(blank)} must be a refusal`);
      assert.match(problem ?? "", /the template "Intro" is an EMAIL template that carries no subject/);
      assert.match(problem ?? "", /"New message"/);
    }
  });

  it("refuses a subject on a channel whose sender never reads the column", () => {
    const linked = subjectProblem(row("Note", "LINKEDIN", "Written and never sent"));
    assert.match(linked ?? "", /the template "Note" is written for LINKEDIN and carries a subject/);
    assert.match(linked ?? "", /delivered to nobody/);
    const chat = subjectProblem(row("Ping", "WHATSAPP", "Written and never sent"));
    assert.match(chat ?? "", /written for WHATSAPP and carries a subject/);
  });

  it("passes a chat template that asks for nothing its carrier cannot carry", () => {
    assert.equal(subjectProblem(row("Note", "LINKEDIN", null)), null);
    assert.equal(subjectProblem(row("Ping", "WHATSAPP", "")), null);
    assert.equal(subjectProblem(row("Note", "LINKEDIN", undefined)), null);
  });

  it("names the column it polices in both directions, and offers the way out", () => {
    const dead = subjectProblem(row("Note", "LINKEDIN", "x")) ?? "";
    assert.match(dead, /Move the text into the body/);
    assert.match(dead, /declare the template EMAIL/);
    // The mail half has no "or declare it something else" to offer: the fix is
    // the line itself, so the message ends where the fix begins.
    const missing = subjectProblem(row("Intro", "EMAIL", null)) ?? "";
    assert.equal(missing.includes("Move the text into the body"), false);
  });

  it("judges the row it is given, so a caller can overlay a patch before writing it", () => {
    // The doors hand this function the state the update WOULD leave (#22's
    // rule), which means the verdict must depend on nothing but the pair.
    const before = subjectProblem(row("Intro", "EMAIL", "A subject"));
    const after = subjectProblem(row("Intro", "LINKEDIN", "A subject"));
    assert.equal(before, null);
    assert.ok(after);
    assert.equal(subjectProblem({ ...row("Intro", "LINKEDIN", "A subject"), name: "Other" }), after?.replace("Intro", "Other"));
  });
});

describe("sendSubjectProblem", () => {
  it("refuses the email send whose prospect would read the fallback", () => {
    const problem = sendSubjectProblem(carrier(2, "EMAIL"), row("Intro", "EMAIL", ""));
    assert.match(problem ?? "", /step 2 sends EMAIL from the template "Intro", which carries no subject/);
    assert.match(problem ?? "", /"New message"/);
  });

  it("lets an email send with a subject through", () => {
    assert.equal(sendSubjectProblem(carrier(1, "EMAIL"), row("Intro", "EMAIL", "Re: {{company}}")), null);
  });

  it("is deliberately narrower than the door: dead copy on a chat step sends anyway", () => {
    // The template row is illegal at its own door and legal here, because the
    // only party harmed by an unread column is the author, and the message the
    // prospect would receive is complete either way. Refusing a real send to
    // lecture about a column nobody reads is the wrong trade — the same one #25
    // made when it declined to police a sequence's declared channel at the send.
    const template = row("Note", "LINKEDIN", "A subject no carrier reads");
    assert.ok(subjectProblem(template), "the door calls the same row a problem");
    assert.equal(sendSubjectProblem(carrier(1, "LINKEDIN"), template), null);
    assert.equal(sendSubjectProblem(carrier(1, "WHATSAPP"), row("Ping", "WHATSAPP", "unread")), null);
    assert.equal(sendSubjectProblem(carrier(1, "CALL"), row("Intro", "EMAIL", "")), null);
    assert.equal(sendSubjectProblem(carrier(1, "TASK"), row("Intro", "EMAIL", "")), null);
  });

  it("asks about the carrier of this step, not about the template's declared channel", () => {
    // A step and a template that disagree are refused by #25 before this guard is
    // reached, so the order matters; here the point is that the value read is
    // `step.channel` — the thing that picks the sender.
    assert.ok(sendSubjectProblem(carrier(1, "EMAIL"), row("Note", "LINKEDIN", null)));
    assert.equal(sendSubjectProblem(carrier(1, "LINKEDIN"), row("Intro", "EMAIL", "A subject")), null);
  });
});

describe("the message repeats the facts the code holds", () => {
  it("an email titles itself New message when nothing was rendered into subject", () => {
    const email = source("../../src/lib/channels/email.ts");
    assert.match(email, /subject: msg\.subject \|\| "New message"/);
  });

  it("the two other senders cannot read the column even if they wanted to", () => {
    const linkedin = source("../../src/lib/channels/linkedin.ts");
    // Its provider payload carries a literal the template never influences.
    assert.match(linkedin, /subject: "Message from LeadGenius"/);
    assert.equal(linkedin.includes("msg.subject"), false, "the LinkedIn sender never reads a subject");

    const whatsapp = source("../../src/lib/channels/whatsapp.ts");
    const signature = /export async function sendWhatsApp\(msg: \{[^}]*\}\)/.exec(whatsapp)?.[0] ?? "";
    assert.ok(signature.includes("body: string"), "the WhatsApp signature is read");
    assert.equal(signature.includes("subject"), false, "the WhatsApp sender takes no subject at all");
  });

  it("the engine renders a subject only for an EMAIL step, which is why only that step is asked", () => {
    const engine = source("../../src/lib/sequence-engine.ts");
    assert.match(engine, /subject: step\.channel === "EMAIL" && template \? renderTemplate\(template\.subject \|\| ""/);
  });

  it("the schema comment states the rule the round now enforces", () => {
    const schema = source("../../prisma/schema.prisma");
    assert.match(schema, /subject\s+String\?/);
  });
});

describe("the verdict is written once, and every caller asks the module", () => {
  const doors: Array<{ label: string; path: string; channelSpelled: boolean }> = [
    { label: "templates POST", path: "../../src/app/api/templates/route.ts", channelSpelled: true },
    { label: "templates PATCH", path: "../../src/app/api/templates/[id]/route.ts", channelSpelled: true },
    { label: "executeStep", path: "../../src/lib/sequence-engine.ts", channelSpelled: false },
  ];

  for (const { label, path, channelSpelled } of doors) {
    it(`${label} imports the module and never re-derives whether the subject is blank`, () => {
      const text = source(path);
      assert.match(text, /from "@\/lib\/subject-fit"|from "\.\/subject-fit"/, `${label} imports subject-fit`);
      assert.doesNotMatch(text, BLANK_TEST, `${label} tests the subject inline`);
      if (channelSpelled) assert.doesNotMatch(text, CHANNEL_TEST, `${label} decides the channel half inline`);
    });
  }

  it("the module is the only place that spells either half", () => {
    const fit = source("../../src/lib/subject-fit.ts");
    assert.equal((fit.match(/\.trim\(\) !== ""/g) ?? []).length, 1, "one definition of blank");
    assert.equal((fit.match(/=== EMAIL_CHANNEL/g) ?? []).length, 1, "one decision of which channel must have one");
    assert.equal((fit.match(/!== EMAIL_CHANNEL/g) ?? []).length, 1, "one decision of which send is asked at all");
    assert.equal((fit.match(/export function subjectProblem/g) ?? []).length, 1);
    assert.equal((fit.match(/export function sendSubjectProblem/g) ?? []).length, 1);
  });

  it("the guard catches the sentences it forbids", () => {
    assert.match('if (template.subject === "") throw', BLANK_TEST);
    assert.match('if (!input.data.subject) return', BLANK_TEST);
    assert.match("if (row.subject.trim().length === 0) throw", BLANK_TEST);
    assert.match('if (row.channel === "EMAIL") need = true', CHANNEL_TEST);
    assert.match('if ("EMAIL" === step.channel) need = true', CHANNEL_TEST);
    // Reading the row and handing it over is the shape the doors actually use.
    assert.doesNotMatch('subjectProblem({ name, channel, subject })', BLANK_TEST);
    assert.doesNotMatch('input.data.channel !== _owned.channel', CHANNEL_TEST);
  });

  it("the email word the module compares against is the word the enums hold", () => {
    // Not a lookup — a constant the rule is written around, so the guard is that
    // the vocabulary and the module have not drifted apart on how "email" is
    // spelled. Both step and template channels carry it, which is what makes the
    // pair comparable at all (#25).
    assert.equal(EMAIL_CHANNEL, "EMAIL");
    assert.equal((STEP_CHANNELS as readonly string[]).includes(EMAIL_CHANNEL), true);
    assert.equal((TEMPLATE_CHANNELS as readonly string[]).includes(EMAIL_CHANNEL), true);
    assert.equal(subjectExpectation(EMAIL_CHANNEL), "required");
  });
});

describe("the doors refuse before Prisma ever sees the row", () => {
  const create = source("../../src/app/api/templates/route.ts");
  const patch = source("../../src/app/api/templates/[id]/route.ts");
  const engine = source("../../src/lib/sequence-engine.ts");

  it("create judges the row it was given, then creates", () => {
    assert.match(
      create,
      /const subjectVerdict = subjectProblem\(\{ name: input\.data\.name, channel: input\.data\.channel, subject: input\.data\.subject \}\)/,
    );
    assert.match(create, /return fieldProblem\("subject", subjectVerdict\)/);
    assert.ok(
      create.indexOf('fieldProblem("subject", subjectVerdict)') < create.indexOf("prisma.template.create"),
      "verdict < create",
    );
  });

  it("patch overlays the stored channel, so editing either half is judged on the row it leaves", () => {
    assert.match(patch, /hasOwn = \(key: "body" \| "subject" \| "variables" \| "channel"\) => key in input\.data/);
    assert.match(patch, /if \(hasOwn\("channel"\) \|\| hasOwn\("subject"\)\)/);
    assert.match(patch, /channel: hasOwn\("channel"\) \? \(input\.data\.channel as string\) : _owned\.channel/);
    assert.match(patch, /subject: hasOwn\("subject"\) \? \(input\.data\.subject as string \| null\) : _owned\.subject/);
    const verdictAt = patch.indexOf("const verdict = subjectProblem(");
    const strandAt = patch.indexOf("strandedByChannel(");
    const updateAt = patch.indexOf("prisma.template.update");
    assert.ok(strandAt >= 0 && verdictAt > strandAt && updateAt > verdictAt, "referenced rows < own row < update");
  });

  it("a channel edit is refused by the rows beneath it before it is refused by its own subject", () => {
    // Not an accident of layout: an operator who is told to clear a subject line
    // and then, next request, that the edit strands four live steps learns the
    // cheaper half first and makes the change twice.
    assert.match(patch, /if \(stranded\.length\) return fieldProblem\("channel", stranded\.join\("; "\)\)/);
    assert.match(patch, /if \(verdict\) return fieldProblem\("subject", verdict\)/);
  });

  it("patch names the column it polices, and the strand answer keeps its own field", () => {
    assert.match(patch, /return fieldProblem\("subject", verdict\)/);
    assert.match(patch, /return fieldProblem\("channel", stranded\.join\("; "\)\)/);
  });

  it("the send refuses after the pairing and before anything is rendered or stored", () => {
    const subjectAt = engine.indexOf("sendSubjectProblem(step, template)");
    const mismatchAt = engine.indexOf("isChannelMismatch(step, template)");
    const renderAt = engine.indexOf("const messageBody");
    const storeAt = engine.indexOf("prisma.sentMessage.create");
    assert.ok(mismatchAt >= 0 && subjectAt > mismatchAt, "the carrier/copy pairing is refused first");
    assert.ok(subjectAt < renderAt, "no copy is rendered for a send already refused");
    assert.ok(renderAt < storeAt && subjectAt < storeAt, "and no row is stored");
  });

  it("a refusal is the declared envelope: 400 through fieldProblem, naming the field", () => {
    assert.match(create, /fieldProblem\("subject", subjectVerdict\)/);
    assert.match(patch, /fieldProblem\("subject", verdict\)/);
  });

  it("DELETE stays unbothered: removing a row cannot mail a fallback", () => {
    const del = /async function DELETE_impl[\s\S]*?\n\}/.exec(patch)?.[0] ?? "";
    assert.doesNotMatch(del, /subjectProblem|sendSubjectProblem/);
  });
});
