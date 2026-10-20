/**
 * Whether a template's `subject` means what its `channel` says it means.
 *
 * `prisma/schema.prisma` comments the column `// For email` and nothing in the
 * product has ever read that as a rule. The engine renders a subject only when
 * the step says `EMAIL` (the `SentMessage` write in `./sequence-engine`),
 * `channels/email.ts` then sends `msg.subject || "New message"`, and the other
 * two senders never look at it: `sendLinkedIn` posts a literal provider subject
 * of its own and `sendWhatsApp` does not take the argument at all. The column
 * has exactly one reader, and both ways of ignoring that reader are real bugs:
 *
 *  - an EMAIL template with no subject mails a mail titled "New message" — the
 *    exact harm #25 named when it refused a LinkedIn template on an email step,
 *    still reachable through a path that breaks no channel rule whatsoever:
 *    `TEMPLATE_CREATE.subject` is optional, so `channel: "EMAIL"` with the
 *    subject left out is a legal 201 today;
 *  - a subject on a LINKEDIN or WHATSAPP template is written, stored, returned
 *    by every read of the row, and delivered to nobody — the accepted-and-
 *    ignored column this fleet keeps being asked to make real or refuse, and
 *    #25's own message tells an operator to go write one.
 *
 * Neither half can be a `required` flag on the field table, because whether the
 * column is mandatory or meaningless is decided by a DIFFERENT field — which is
 * exactly what a per-field table cannot state. So it is one module holding one
 * verdict, asked by the two doors that write either half and, in its
 * prospect-visible branch only, by the send that reads the result.
 */

/**
 * The channel the column is `// For email` about. Spelled here rather than
 * imported because `./channel-fit` — the module that compares a step's carrier
 * with a template's copy — has no use for the value on its own: it compares the
 * two channels to each other and never asks what either one means.
 */
export const EMAIL_CHANNEL = "EMAIL";

/** What a template's subject is worth, decided by the channel the copy was written for. */
export type SubjectExpectation = "required" | "forbidden";

export interface TemplateSubject {
  name: string;
  channel: string;
  subject: string | null | undefined;
}

export interface StepCarrier {
  stepNumber: number;
  channel: string;
}

/**
 * One reader, one channel. Everything else is `forbidden` — including `MULTI`
 * and the step-only `CALL`/`TASK`, neither of which can be a template's channel
 * (`TEMPLATE_CHANNELS` is three carriers) but which a direct database edit can
 * put in the column, and which then read the subject just as little as a chat
 * message does.
 */
export function subjectExpectation(channel: string): SubjectExpectation {
  return channel === EMAIL_CHANNEL ? "required" : "forbidden";
}

/**
 * Blank is blank: the boundary trims text, so `"   "` arrives as `""`, and a
 * subject the caller cleared is `null`. None of the three is a subject line a
 * prospect could read.
 */
export function hasSubject(subject: string | null | undefined): boolean {
  return typeof subject === "string" && subject.trim() !== "";
}

const MISSING_SUBJECT =
  'carries no subject — the subject line is the one thing a prospect reads before deciding whether to open, ' +
  'and the sender fills the blank with "New message"';

/**
 * The half that belongs after "the template \"X\" is written for LINKEDIN and".
 *
 * It used to name the channel again — "carries a subject while being written
 * for LINKEDIN" — which said the same thing twice and, worse, implied the
 * subject was written for LINKEDIN when it was written for email. The row's
 * channel is already in the sentence; this half says what is wrong with the
 * other column.
 */
const DEAD_SUBJECT = (): string =>
  "carries a subject, and only an email send ever reads that column — " +
  "the line is stored, returned by every read of the row and delivered to nobody. Move the text into the body, " +
  `or declare the template ${EMAIL_CHANNEL} if the copy really is an email's`;

/**
 * The verdict on a row: what its own `subject` column is for. This is the
 * judgment the two template doors make before anything is written, and it is
 * symmetric — the blank an EMAIL channel cannot ship with, and the copy no
 * chat channel can deliver.
 */
export function subjectProblem(template: TemplateSubject): string | null {
  const filled = hasSubject(template.subject);
  if (subjectExpectation(template.channel) === "required") {
    return filled ? null : `the template "${template.name}" is an ${template.channel} template that ${MISSING_SUBJECT}`;
  }
  return filled ? `the template "${template.name}" is written for ${template.channel} and ${DEAD_SUBJECT()}` : null;
}

/**
 * The same pair judged as it stands at the moment of a send, and deliberately
 * narrower than the door's verdict: a blank subject on an email is something a
 * prospect reads, so the send refuses it; a subject nobody on a LinkedIn step
 * could deliver is the author's dead copy, and stopping a message that would
 * arrive perfectly well to complain about an unread column would trade a real
 * send for a formatting lesson. That asymmetry is the whole function — a step
 * that does not say `EMAIL` has no problem here.
 */
export function sendSubjectProblem(step: StepCarrier, template: TemplateSubject): string | null {
  if (step.channel !== EMAIL_CHANNEL) return null;
  return hasSubject(template.subject) ? null : `step ${step.stepNumber} sends ${EMAIL_CHANNEL} from the template "${template.name}", which ${MISSING_SUBJECT}`;
}
