// #22 gave a template a declaration, #23 gave the enrollment a way to answer it,
// #24 made both ask which copy the send will actually use. None of them asked the
// other half of the question: `SequenceStep.channel` chooses the carrier and
// `Template.channel` describes the copy, each validated at its own door against
// its own vocabulary, and nothing compared the pair — so an EMAIL step on a
// LinkedIn template mails a subjectless body under `sendEmail`'s "New message"
// fallback, and a WHATSAPP step on an email sends its HTML as one bubble. This
// round makes the two columns answer to one rule, at the doors that write them and
// at the send that would otherwise discover it in front of a prospect.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MULTI_CHANNEL,
  armChannelProblem,
  isChannelMismatch,
  sequenceChannelProblem,
  sequenceChannelProblems,
  stepChannelProblem,
} from "../../src/lib/channel-fit";
import { SEQUENCE_CHANNELS, STEP_CHANNELS, TEMPLATE_CHANNELS } from "../../src/lib/enums";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const step = (stepNumber: number, channel: string) => ({ stepNumber, channel });
const template = (name: string, channel: string) => ({ name, channel });

/**
 * A caller re-deriving the pairing would compare a step's channel with a
 * template's in its own sentence. `input.data.channel !== _owned.channel` — "did
 * this edit change anything" — is a different question and must not be caught.
 */
const PAIRING = /\b(?:step|s)\.channel\s*[!=]==\s*(?:tpl|template|found)\b|\b(?:tpl|template|found)\.channel\s*[!=]==\s*(?:step|s)\b/;

describe("isChannelMismatch", () => {
  it("calls the same channel a fit, and every other pair a mismatch", () => {
    assert.equal(isChannelMismatch(step(1, "EMAIL"), template("A", "EMAIL")), false);
    assert.equal(isChannelMismatch(step(1, "WHATSAPP"), template("A", "WHATSAPP")), false);
    assert.equal(isChannelMismatch(step(1, "LINKEDIN"), template("A", "LINKEDIN")), false);
    assert.equal(isChannelMismatch(step(1, "EMAIL"), template("A", "LINKEDIN")), true);
    assert.equal(isChannelMismatch(step(1, "LINKEDIN"), template("A", "EMAIL")), true);
    assert.equal(isChannelMismatch(step(1, "EMAIL"), template("A", "WHATSAPP")), true);
  });

  it("needs no exemption, because neither side's vocabulary has a mixed value", () => {
    // `MULTI` is a word a SEQUENCE declares about its track. A step that meant
    // "some channel" and a template "written for anything" would make the
    // comparison meaningless, and neither exists.
    assert.equal((STEP_CHANNELS as readonly string[]).includes(MULTI_CHANNEL), false);
    assert.equal((TEMPLATE_CHANNELS as readonly string[]).includes(MULTI_CHANNEL), false);
    assert.equal(SEQUENCE_CHANNELS.includes(MULTI_CHANNEL), true);
  });

  it("says nothing about names, so it is a comparison of two words and nothing else", () => {
    assert.equal(isChannelMismatch(step(2, "CALL"), template("Same name", "CALL")), false);
    assert.equal(isChannelMismatch(step(2, "CALL"), template("Same name", "EMAIL")), true);
  });

  it("leaves a CALL or TASK step no copy it could be given, by vocabulary alone", () => {
    // Not an exemption to write: `TEMPLATE_CHANNELS` has three values and neither
    // of these is among them, so `CALL`/`TASK` + `templateId` is a reference no
    // sender would ever render. The door says so instead of storing it.
    for (const channel of ["CALL", "TASK"]) {
      assert.equal((TEMPLATE_CHANNELS as readonly string[]).includes(channel), false);
      for (const written of TEMPLATE_CHANNELS) {
        assert.equal(isChannelMismatch(step(1, channel), template("Any copy", written)), true);
      }
    }
  });
});

describe("stepChannelProblem", () => {
  it("says who chose which half of the message, and names both rows", () => {
    const message = stepChannelProblem(step(3, "EMAIL"), template("Week-1 intro", "LINKEDIN"));
    assert.match(message, /step 3 sends EMAIL/);
    assert.match(message, /the template "Week-1 intro" is written for LINKEDIN/);
    assert.match(message, /chosen by the template and the channel that carries it by the step/);
  });

  it("prices an email whose copy was written elsewhere in the subject it would arrive with", () => {
    // The claim: `executeStep` renders a subject only for an EMAIL step, the
    // column is nullable and off-email unused, and `sendEmail` titles whatever is
    // left "New message".
    assert.match(
      stepChannelProblem(step(1, "EMAIL"), template("LinkedIn touch", "LINKEDIN")),
      /the subject is an email column and a LINKEDIN template has none, so the mail would land titled "New message"/,
    );
    assert.match(
      stepChannelProblem(step(1, "EMAIL"), template("WhatsApp nudge", "WHATSAPP")),
      /a WHATSAPP template has none/,
    );
  });

  it("prices a chat whose copy was written for an inbox in the body it would arrive with", () => {
    assert.match(
      stepChannelProblem(step(2, "WHATSAPP"), template("Week-1 intro", "EMAIL")),
      /the HTML body an inbox was written for would go out as one WHATSAPP message/,
    );
    assert.match(
      stepChannelProblem(step(4, "LINKEDIN"), template("Week-1 intro", "EMAIL")),
      /would go out as one LINKEDIN message/,
    );
  });

  it("prices a pair with no carrier-specific harm by the two halves it leaves disagreeing", () => {
    assert.match(
      stepChannelProblem(step(1, "LINKEDIN"), template("WhatsApp nudge", "WHATSAPP")),
      /a WHATSAPP body would be carried over LINKEDIN/,
    );
    assert.match(
      stepChannelProblem(step(1, "TASK"), template("LinkedIn touch", "LINKEDIN")),
      /a LINKEDIN body would be carried over TASK/,
    );
  });
});

describe("sequenceChannelProblem", () => {
  it("exempts the sequence's own word for a mixed track, and an agreeing step", () => {
    assert.equal(sequenceChannelProblem("MULTI", step(1, "WHATSAPP")), null);
    assert.equal(sequenceChannelProblem("EMAIL", step(1, "EMAIL")), null);
    assert.equal(sequenceChannelProblem("MULTI", step(9, "LINKEDIN")), null);
  });

  it("prices a lying claim in the rollup that files it, and names the fix", () => {
    const message = sequenceChannelProblem("EMAIL", step(2, "WHATSAPP")) ?? "";
    assert.ok(
      message.includes("step 2 sends WHATSAPP, but this sequence is declared EMAIL"),
      message,
    );
    assert.ok(
      message.includes(
        "the daily rollup groups every message of this track by the sequence's own channel, so that step's sends would be counted as EMAIL",
      ),
      message,
    );
    assert.ok(message.includes(`Declare the sequence ${MULTI_CHANNEL} when its steps really do differ`), message);
  });

  it("stays about the track, not the copy — the step and its template are asked separately", () => {
    const message = sequenceChannelProblem("LINKEDIN", step(1, "EMAIL")) ?? "";
    assert.equal(message.includes("New message"), false);
    assert.equal(message.includes('"'), false);
  });
});

describe("sequenceChannelProblems", () => {
  it("waves through a track whose steps all agree, and a MULTI track whatever it holds", () => {
    const steps = [step(1, "EMAIL"), step(2, "EMAIL"), step(3, "EMAIL")];
    assert.equal(sequenceChannelProblems("EMAIL", steps), null);
    assert.equal(sequenceChannelProblems("MULTI", [step(1, "EMAIL"), step(2, "CALL")]), null);
    assert.equal(sequenceChannelProblems("EMAIL", []), null);
  });

  it("names the LOWEST step that breaks, whatever order the rows came in", () => {
    const message = sequenceChannelProblems("EMAIL", [step(7, "LINKEDIN"), step(2, "WHATSAPP"), step(4, "EMAIL")]);
    assert.match(message ?? "", /^step 2 sends WHATSAPP/);
  });

  it("says how many would follow, so a thirty-step track is one decision", () => {
    const three = sequenceChannelProblems("EMAIL", [step(1, "WHATSAPP"), step(2, "LINKEDIN"), step(3, "CALL")]);
    assert.match(three ?? "", /\(and 2 more steps of this track send differently\)$/);
    const two = sequenceChannelProblems("EMAIL", [step(1, "WHATSAPP"), step(2, "WHATSAPP")]);
    assert.match(two ?? "", /\(and 1 more step of this track send differently\)$/);
  });

  it("adds nothing when one step is the whole problem", () => {
    const one = sequenceChannelProblems("EMAIL", [step(1, "EMAIL"), step(2, "LINKEDIN")]);
    assert.equal(one, sequenceChannelProblem("EMAIL", step(2, "LINKEDIN")));
  });

  it("does not reorder the caller's rows", () => {
    const steps = [step(7, "LINKEDIN"), step(2, "WHATSAPP")];
    sequenceChannelProblems("EMAIL", steps);
    assert.deepEqual(steps, [step(7, "LINKEDIN"), step(2, "WHATSAPP")]);
  });
});

describe("armChannelProblem", () => {
  it("is null for a track the copy actually fits", () => {
    const email = template("Variant B copy", "EMAIL");
    assert.equal(armChannelProblem('arm "B"', email, []), null);
    assert.equal(armChannelProblem('arm "B"', email, [step(1, "EMAIL"), step(2, "EMAIL")]), null);
  });

  it("judges the arm's copy against EVERY step it overrides, not the one it replaces", () => {
    // #24: a variant's template rides the whole track, so one LINKEDIN template
    // under an EMAIL arm breaks all three of its steps at once.
    const message = armChannelProblem('arm "B"', template("Variant B copy", "LINKEDIN"), [
      step(3, "EMAIL"),
      step(1, "EMAIL"),
      step(2, "WHATSAPP"),
    ]);
    assert.match(message ?? "", /^arm "B": step 1 sends EMAIL/);
    assert.match(message ?? "", /\(and 2 more steps of this track would break the same way\)$/);
  });

  it("keeps the label the caller supplies, because the two doors describe the arm differently", () => {
    const single = armChannelProblem('arm "control" of test "Subject A/B"', template("Cold", "WHATSAPP"), [step(1, "EMAIL")]);
    assert.match(single ?? "", /^arm "control" of test "Subject A\/B": /);
    assert.equal(single?.includes("more step"), false);
  });

  it("counts one follower as one step, not one steps", () => {
    const two = armChannelProblem('arm "B"', template("Warm", "EMAIL"), [step(1, "WHATSAPP"), step(2, "LINKEDIN")]);
    assert.match(two ?? "", /^arm "B": step 1 sends WHATSAPP.*\(and 1 more step of this track would break the same way\)$/);
  });
});

describe("the pairing rule is written once, and every sender of it asks the module", () => {
  const doors: Array<{ label: string; path: string }> = [
    { label: "sequences POST", path: "../../src/app/api/sequences/route.ts" },
    { label: "sequences PATCH", path: "../../src/app/api/sequences/[id]/route.ts" },
    { label: "abtests POST", path: "../../src/app/api/abtests/route.ts" },
    { label: "templates PATCH", path: "../../src/app/api/templates/[id]/route.ts" },
    { label: "executeStep", path: "../../src/lib/sequence-engine.ts" },
  ];

  it("the guard catches the sentence it forbids", () => {
    assert.match('if (step.channel !== template.channel) throw', PAIRING);
    assert.match('s.channel === found.channel', PAIRING);
    assert.doesNotMatch('input.data.channel !== _owned.channel', PAIRING);
    assert.doesNotMatch('step.channel === "EMAIL" && template', PAIRING);
  });

  for (const { label, path } of doors) {
    it(`${label} imports the module and never re-derives the comparison`, () => {
      const text = source(path);
      assert.match(text, /from "@\/lib\/channel-fit"|from "\.\/channel-fit"/, `${label} imports channel-fit`);
      assert.doesNotMatch(text, PAIRING, `${label} compares the pair inline`);
    });
  }

  it("the module states the comparison exactly once, in the predicate", () => {
    const fit = source("../../src/lib/channel-fit.ts");
    assert.equal((fit.match(/step\.channel !== template\.channel/g) ?? []).length, 1);
    assert.equal((fit.match(/export function isChannelMismatch/g) ?? []).length, 1);
  });

  it("the harm the branches claim is the harm the code does", () => {
    // Guarding the message means guarding the facts it is built from: an email
    // titles itself "New message" when nothing was rendered into `subject`, and
    // the engine renders a subject only for an EMAIL step.
    const email = source("../../src/lib/channels/email.ts");
    assert.match(email, /subject: msg\.subject \|\| "New message"/);
    const engine = source("../../src/lib/sequence-engine.ts");
    assert.match(engine, /subject: step\.channel === "EMAIL" && template \? renderTemplate\(template\.subject \|\| ""/);
    // And the rollup really does group a track by the sequence's own channel.
    const analytics = source("../../src/lib/analytics.ts");
    assert.match(analytics, /a\.enrollment\.sequence\.channel/);
    assert.match(analytics, /byChannel/);
  });
});

describe("the doors refuse before Prisma ever sees the row", () => {
  const create = source("../../src/app/api/sequences/route.ts");

  it("sequence create reads the template with the columns the rule needs", () => {
    assert.match(create, /select: \{ name: true, channel: true, workspaceId: true \}/);
    // The lookup that answers "does it exist" is the one that answers "is it for
    // this channel" — a door that re-read the row per check is two races.
    assert.equal((create.match(/prisma\.template\.findUnique/g) ?? []).length, 1);
  });

  it("sequence create refuses both halves of the pairing, then creates", () => {
    assert.match(create, /if \(tpl && isChannelMismatch\(step, tpl\)\)/);
    assert.match(create, /error: `stepsConfig\[\$\{i\}\]: \$\{stepChannelProblem\(step, tpl\)\}`/);
    assert.match(create, /const mismatch = sequenceChannelProblem\(input\.data\.channel, step\)/);
    assert.ok(
      create.indexOf("isChannelMismatch(step, tpl)") < create.indexOf("prisma.sequence.create"),
      "step/template refusal < create",
    );
    assert.ok(
      create.indexOf("sequenceChannelProblem(input.data.channel, step)") < create.indexOf("prisma.sequence.create"),
      "track claim refusal < create",
    );
    // A step with no template has no copy to disagree with, so the pair is asked
    // only when there is a template: `tpl &&`, not a branch on the missing row.
    assert.equal(create.includes("if (!tpl"), false);
  });

  it("sequence patch judges the NEW claim against the steps already stored", () => {
    const patch = source("../../src/app/api/sequences/[id]/route.ts");
    assert.match(patch, /select: \{ stepNumber: true, channel: true \}/);
    assert.match(patch, /sequenceChannelProblems\(input\.data\.channel, steps\)/);
    assert.match(patch, /return fieldProblem\("channel", problem\)/);
    assert.ok(
      patch.indexOf("sequenceChannelProblems(input.data.channel, steps)") < patch.indexOf("prisma.sequence.update"),
      "re-claim < update",
    );
    // The steps are read from the database, not from the body: this route cannot
    // write a step, so only the stored rows can be contradicted.
    assert.match(patch, /where: \{ sequenceId: id \}/);
    assert.doesNotMatch(patch, /stepsConfig/);
  });

  it("A/B create reads the arm's whole track and refuses a copy that cannot ride it", () => {
    const ab = source("../../src/app/api/abtests/route.ts");
    assert.match(ab, /steps: \{ select: \{ stepNumber: true, channel: true \} \}/);
    assert.match(ab, /select: \{ id: true, name: true, channel: true \}/);
    assert.match(ab, /armChannelProblem\(`arm "\$\{variant\.name\}"`, template, sequence\.steps\)/);
    assert.ok(ab.indexOf("armChannelProblem(") < ab.indexOf("prisma.aBTest.create"), "arm refusal < create");
  });

  it("template patch asks what the edit would strand, by name", () => {
    const patch = source("../../src/app/api/templates/[id]/route.ts");
    assert.match(patch, /select: \{ workspaceId: true, name: true, channel: true, body: true, subject: true, variables: true \}/);
    assert.match(patch, /strandedByChannel\(id, _owned\.name, input\.data\.channel\)/);
    assert.match(patch, /return fieldProblem\("channel", stranded\.join\("; "\)\)/);
    assert.ok(
      patch.indexOf("strandedByChannel(id, _owned.name") < patch.indexOf("prisma.template.update"),
      "strand check < update",
    );
    // An edit that leaves the channel alone strands nothing and is not asked — a
    // row written before this rule must stay patchable on its body.
    assert.match(patch, /input\.data\.channel !== undefined && input\.data\.channel !== _owned\.channel/);
  });

  it("the strand query reads steps and arms from the SAME reference the update would change", () => {
    const fit = source("../../src/lib/channel-fit.ts");
    assert.match(fit, /where: \{ templateId, channel: \{ not: newChannel \} \}/);
    assert.match(fit, /prisma\.aBTestVariant\.findMany\(\{\s*where: \{ templateId \}/);
    // Named, not ided: the operator is deciding whether the edit is worth editing
    // those rows too.
    assert.match(fit, /sequence "\$\{step\.sequence\.name\}"/);
    assert.match(fit, /arm "\$\{arm\.name\}" of test "\$\{arm\.abTest\.name\}"/);
  });
});

describe("executeStep refuses the rows a door never saw", () => {
  const engine = source("../../src/lib/sequence-engine.ts");

  it("the send asks the same predicate, on the copy it resolved", () => {
    assert.match(engine, /if \(template && isChannelMismatch\(step, template\)\)/);
    assert.match(engine, /throw new Error\(stepChannelProblem\(step, template\)\)/);
  });

  it("the refusal comes before anything a prospect could receive", () => {
    assert.ok(engine.indexOf("isChannelMismatch(step, template)") < engine.indexOf("const messageBody"), "refusal < render");
    assert.ok(engine.indexOf("isChannelMismatch(step, template)") < engine.indexOf("prisma.sentMessage.create"), "refusal < send");
    assert.ok(
      engine.indexOf("isChannelMismatch(step, template)") < engine.indexOf("selectSendingAccount(enrollment.campaign.workspaceId"),
      "refusal < sender selection",
    );
  });

  it("asks the resolved copy, so an arm template riding an email track is caught", () => {
    // The pair compared is `template` — the row `effectiveTemplateId` chose — not
    // `step.templateId`, which an arm overrides.
    assert.ok(engine.indexOf("const template = templateId ?") < engine.indexOf("isChannelMismatch(step, template)"), "resolution < pairing");
  });

  it("the track's declared channel is NOT policed at the send", () => {
    // The rollup groups by it, so a lying claim is a wrong number — refusing here
    // would trade a wrong number for no message at all. Only the copy a prospect
    // reads can stop a send.
    const guard = /if \(template && isChannelMismatch\(step, template\)\)[\s\S]*?\}/.exec(engine)?.[0] ?? "";
    assert.equal(guard.includes("sequence.channel"), false);
    assert.doesNotMatch(engine, /sequenceChannelProblem/);
  });

  it("a dangling template still refuses by name, ahead of the pairing rule", () => {
    assert.ok(
      engine.indexOf("points at a template that no longer exists") < engine.indexOf("isChannelMismatch(step, template)"),
      "dangling refusal < pairing refusal",
    );
  });
});
