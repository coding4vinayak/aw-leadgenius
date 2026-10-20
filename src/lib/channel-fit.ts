import { prisma } from "@/lib/db";

/**
 * Whether the copy a step will send fits the channel it will be sent on.
 *
 * Two columns describe one message from opposite ends: `SequenceStep.channel`
 * chooses the carrier — who sends it, and which of `email.ts`, `whatsapp.ts`,
 * `linkedin.ts` renders it — and `Template.channel` describes the copy it was
 * written for. Each is policed at its own write door against its own vocabulary,
 * and nothing has ever compared them, so a step is free to point at a template
 * written for another channel and the two halves simply disagree at send.
 * `executeStep` takes the body from the template and the subject only when the
 * step says `EMAIL`, so an email whose template was written for LinkedIn has no
 * subject to render and `sendEmail` titles the message "New message" on the way
 * out. A prospect reads that.
 *
 * One module because five callers must not drift on the same sentence: sequence
 * create, sequence patch (whose `channel` is the claim being changed under stored
 * steps), A/B test create (a variant's template rides EVERY step of the arm it
 * overrides), template patch (whose `channel` change strands every step that
 * already references it) — and `executeStep` itself, for the rows a migration or a
 * direct edit left behind.
 */
export interface StepChannel {
  stepNumber: number;
  channel: string;
}

export interface TemplateChannel {
  name: string;
  channel: string;
}

const RULE =
  "the copy a prospect receives is chosen by the template and the channel that carries it by the step, " +
  "and they must say the same thing";

/**
 * The predicate every door and the send itself filter on, kept apart from the
 * message so a caller that only needs the test does not build a sentence about a
 * prospect nobody is about to mail. The template must outlive this comparison for
 * the message to be worth anything, which is why both take the same pair.
 */
export function isChannelMismatch(step: StepChannel, template: TemplateChannel): boolean {
  return step.channel !== template.channel;
}

/**
 * What the mismatch would cost, spoken in the operator's own terms, because
 * "channel mismatch" tells nobody what a prospect would have read. Each branch is
 * a claim about code: the first is `channels/email.ts`'s `subject || "New
 * message"` over a template whose `subject` column is nullable and off-email
 * unused; the second is an email body — HTML, paragraphs, written for an inbox —
 * leaving as one message on a channel that renders no subject at all.
 */
function consequence(stepChannel: string, templateChannel: string): string {
  if (stepChannel === "EMAIL") {
    return `; the subject is an email column and a ${templateChannel} template has none, so the mail would land titled "New message"`;
  }
  if (templateChannel === "EMAIL") {
    return `; the HTML body an inbox was written for would go out as one ${stepChannel} message`;
  }
  return `; a ${templateChannel} body would be carried over ${stepChannel}`;
}

export function stepChannelProblem(step: StepChannel, template: TemplateChannel): string {
  return (
    `step ${step.stepNumber} sends ${step.channel}, but the template "${template.name}" is written for ` +
    `${template.channel} — ${RULE}${consequence(step.channel, template.channel)}`
  );
}

/**
 * A sequence's own `channel` is the claim the daily rollup groups by:
 * `analytics.ts` folds every activity through `enrollment.sequence.channel` into
 * its `byChannel` rows, so a step sending another channel inside a track declared
 * single-channel is counted under the wrong heading — the divergent number the
 * attribution module had to stop reading `sequence.channel` in order to answer
 * "which channel got the reply" honestly.
 *
 * `MULTI` is the vocabulary's own word for a mixed track, so it is exempt: that is
 * what a sequence declares when its steps really do differ.
 */
export const MULTI_CHANNEL = "MULTI";

export function sequenceChannelProblem(sequenceChannel: string, step: StepChannel): string | null {
  if (sequenceChannel === MULTI_CHANNEL || sequenceChannel === step.channel) return null;
  return (
    `step ${step.stepNumber} sends ${step.channel}, but this sequence is declared ${sequenceChannel} — the daily ` +
    `rollup groups every message of this track by the sequence's own channel, so that step's sends would be counted ` +
    `as ${sequenceChannel}. Declare the sequence ${MULTI_CHANNEL} when its steps really do differ`
  );
}

/**
 * The same claim judged against a whole track, for the door that changes it while
 * the steps are already written. Every step that disagrees would be miscounted for
 * the same reason and is fixed by the same decision, so the refusal names the first
 * and says how many follow rather than handing out one step per request.
 */
export function sequenceChannelProblems(sequenceChannel: string, steps: StepChannel[]): string | null {
  const problems = [...steps]
    .sort((a, b) => a.stepNumber - b.stepNumber)
    .map((step) => sequenceChannelProblem(sequenceChannel, step))
    .filter((problem): problem is string => problem !== null);
  if (problems.length === 0) return null;
  const rest = problems.length - 1;
  return rest === 0
    ? problems[0]
    : `${problems[0]} (and ${rest} more ${rest === 1 ? "step" : "steps"} of this track send differently)`;
}

/**
 * One copy cannot fit two carriers, so an arm's template is judged against EVERY
 * step of the track it overrides (#24). The refusal names the first step that
 * breaks and how many would follow: an operator told about thirty steps one at a
 * time is handed a queue, not a fix.
 *
 * `label` belongs to the caller because the two places that ask are describing the
 * arm differently — the create door knows only the arm, the template door also
 * knows which test the arm lives in.
 */
export function armChannelProblem(label: string, template: TemplateChannel, steps: StepChannel[]): string | null {
  const ordered = [...steps].sort((a, b) => a.stepNumber - b.stepNumber);
  const broken = ordered.filter((step) => isChannelMismatch(step, template));
  if (broken.length === 0) return null;
  const first = stepChannelProblem(broken[0], template);
  const rest = broken.length - 1;
  return rest === 0
    ? `${label}: ${first}`
    : `${label}: ${first} (and ${rest} more ${rest === 1 ? "step" : "steps"} of this track would break the same way)`;
}

/**
 * The rows a `Template.channel` change would strand: the steps that already
 * reference this template, and every arm whose copy it is for a whole track. Judged
 * as the row the update WOULD leave, which is the rule #22 established for
 * `variables` — an edit is honest only against the state it produces.
 *
 * Every refusal names the row by its own name rather than by an id, because the
 * operator is about to decide whether the change is worth editing those rows too.
 */
export async function strandedByChannel(
  templateId: string,
  templateName: string,
  newChannel: string,
): Promise<string[]> {
  const [steps, arms] = await Promise.all([
    prisma.sequenceStep.findMany({
      where: { templateId, channel: { not: newChannel } },
      select: { stepNumber: true, channel: true, sequence: { select: { name: true } } },
      orderBy: { stepNumber: "asc" },
    }),
    prisma.aBTestVariant.findMany({
      where: { templateId },
      select: {
        name: true,
        abTest: { select: { name: true } },
        sequence: { select: { steps: { select: { stepNumber: true, channel: true } } } },
      },
    }),
  ]);

  const template: TemplateChannel = { name: templateName, channel: newChannel };
  const problems: string[] = [];
  for (const step of steps) {
    problems.push(
      `sequence "${step.sequence.name}": ` +
        stepChannelProblem({ stepNumber: step.stepNumber, channel: step.channel }, template),
    );
  }
  for (const arm of arms) {
    const problem = armChannelProblem(`arm "${arm.name}" of test "${arm.abTest.name}"`, template, arm.sequence.steps);
    if (problem) problems.push(problem);
  }
  return problems;
}
