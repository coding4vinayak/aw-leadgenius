import { prisma } from "./db";
import { queues, enqueue } from "./queue";
import { triggerWebhooks } from "./webhooks";

export interface SequenceStepConfig {
  stepNumber: number;
  channel: "EMAIL" | "WHATSAPP" | "LINKEDIN" | "CALL" | "TASK";
  templateId?: string;
  delayDays: number;
  delayHours: number;
  conditions?: {
    if?: "no_reply" | "no_open" | "no_click" | "replied" | "bounced" | "clicked";
    then?: "next" | "skip" | "end" | "branch";
    branchToStep?: number;
  };
}

/**
 * What can start a step. The activity webhooks and the send worker pass the
 * second eight; `TIME_ELAPSED` is what the due-scan passes
 * (`scheduler.ts:runDueSequenceSteps`) and until #115 it was a value no caller
 * in this repository produced.
 */
export type SequenceTrigger =
  | "ENROLLED"
  | "SENT"
  | "DELIVERED"
  | "OPENED"
  | "CLICKED"
  | "REPLIED"
  | "BOUNCED"
  | "TIME_ELAPSED";

/**
 * Whether a step's wait has ended.
 *
 * `null` means nothing is scheduled, which is the state of a brand-new
 * enrollment: its first step is due the moment it is created, not after some
 * delay it never asked for. A step that is due exactly at the tick is due —
 * `<=`, because the sweep runs on a minute boundary and a `nextActionAt` that
 * lands on that boundary must not wait for the next one.
 */
export function stepIsDue(nextActionAt: Date | null, now: Date): boolean {
  return nextActionAt === null || nextActionAt.getTime() <= now.getTime();
}

/**
 * Which enrollment status stops a sequence whose contact left ACTIVE, or null
 * to let it run.
 *
 * Bounced and unsubscribed map to their identical enrollment statuses — the
 * same rows the provider webhooks write when the bounce or the unsubscribe
 * arrives live, so a manually-marked contact stops the sequence the same way
 * the signal does. `DO_NOT_CONTACT` pauses rather than completes: no status in
 * the enrollment's vocabulary honestly says "this workspace told us not to
 * contact this person", and `COMPLETED` would fire the CRM's
 * `sequence.completed` signal on a refusal.
 */
export function stopStatusForContact(contactStatus: string): "BOUNCED" | "UNSUBSCRIBED" | "PAUSED" | null {
  switch (contactStatus) {
    case "ACTIVE": return null;
    case "BOUNCED": return "BOUNCED";
    case "UNSUBSCRIBED": return "UNSUBSCRIBED";
    default: return "PAUSED";
  }
}

export async function processSequenceStep(
  enrollmentId: string,
  triggerType: SequenceTrigger,
  now: Date = new Date(),
): Promise<void> {
  const enrollment = await prisma.enrollment.findUnique({
    where: { id: enrollmentId },
    include: {
      sequence: { include: { steps: { orderBy: { stepNumber: "asc" } } } },
      campaign: true,
      contact: true,
      abVariant: { select: { name: true, templateId: true } },
    },
  });

  if (!enrollment || enrollment.status !== "ACTIVE") return;

  // A contact who left ACTIVE mid-flight does not get the next email: the
  // workspace's lifecycle column is a stop signal, not metadata. The enroll
  // route refuses at the boundary; this catches the status that changed
  // between two ticks of the sweep.
  const stop = stopStatusForContact(enrollment.contact.status);
  if (stop) {
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: stop } });
    return;
  }

  const steps = enrollment.sequence.steps as unknown as SequenceStepConfig[];
  const currentStep = steps[enrollment.currentStep];

  if (!currentStep) {
    await completeEnrollment(enrollment);
    return;
  }

  const outcome = stepOutcome(currentStep, triggerType, await stepFacts(enrollment.id, enrollment.nextActionAt, currentStep, now));
  switch (outcome.kind) {
    case "wait":
      return;
    case "send":
      await executeStep(enrollment, currentStep);
      return;
    case "skip":
      await moveTo(enrollment.id, enrollment.currentStep + 1, now);
      return;
    case "end":
      await completeEnrollment(enrollment);
      return;
    case "branch":
      await branchTo(enrollment.id, steps, currentStep, outcome.stepNumber, now);
      return;
  }
}

/** The database half of the condition decision: only the facts the step asks about are read. */
async function stepFacts(
  enrollmentId: string,
  nextActionAt: Date | null,
  step: SequenceStepConfig,
  now: Date,
): Promise<StepFacts> {
  const condition = step.conditions?.if;
  return {
    due: stepIsDue(nextActionAt, now),
    replied: condition === "no_reply" ? await hasReply(enrollmentId) : false,
    opened: condition === "no_open" ? await hasOpen(enrollmentId) : false,
    clicked: condition === "no_click" ? await hasClick(enrollmentId) : false,
  };
}

/**
 * Advance past a step without sending it — the `skip` action, and the move
 * `branch` shares.
 *
 * The wait is set to `now`, not null: the sweep's clause deliberately excludes
 * a null `nextActionAt` ("an unscheduled row is not a due one"), so clearing it
 * would park the enrollment until a human noticed. `now` makes the step that
 * follows this one the next tick's work.
 */
async function moveTo(enrollmentId: string, index: number, now: Date): Promise<void> {
  await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: { currentStep: index, nextActionAt: now },
  });
}

async function branchTo(
  enrollmentId: string,
  steps: SequenceStepConfig[],
  from: SequenceStepConfig,
  stepNumber: number,
  now: Date,
): Promise<void> {
  const index = steps.findIndex((s) => s.stepNumber === stepNumber);
  // Rows outlive the request that validated them: a target can be validated at
  // create and missing after an edit. Refusing by name beats walking off the
  // end of the array, which is a silent `completeEnrollment`.
  if (index === -1) {
    throw new Error(`step ${from.stepNumber} branches to step ${stepNumber}, which the sequence does not have`);
  }
  await moveTo(enrollmentId, index, now);
}

/** What the engine decided the current step should do. */
export type StepOutcome =
  | { kind: "send" }
  | { kind: "wait" }
  | { kind: "skip" }
  | { kind: "end" }
  | { kind: "branch"; stepNumber: number };

/** The condition names a step may ask about — `no_*` reads wait, the rest are events. */
export const STEP_CONDITIONS = ["no_reply", "no_open", "no_click", "replied", "bounced", "clicked"] as const;
/** What a satisfied condition does. `next` is the default and the historical behavior. */
export const STEP_ACTIONS = ["next", "skip", "end", "branch"] as const;

export type StepFacts = {
  /** Whether the step's recorded wait has ended (`stepIsDue`). */
  due: boolean;
  replied: boolean;
  opened: boolean;
  clicked: boolean;
};

/**
 * The whole condition decision, pure and testable.
 *
 * A step with no condition of its own has nothing to check but the calendar —
 * `facts.due` is that calendar, and it is the whole delay product: `delayDays:
 * 3` between two emails means three days apart, not the `SENT` job the send
 * worker queues the moment the previous message leaves spending the next step
 * in the same second.
 *
 * Before this, `then` was destructured into a variable nothing read: a step
 * configured `{if: "no_reply", then: "end"}` sent the follow-up anyway, a
 * `branch` never branched, and an unknown `if` fell into a `default: return
 * true` that spent the step on the next trigger of any kind. The README sells
 * "branch conditions"; these four actions are that sentence made true.
 */
export function stepOutcome(step: SequenceStepConfig, triggerType: SequenceTrigger, facts: StepFacts): StepOutcome {
  if (!step.conditions) {
    return facts.due ? { kind: "send" } : { kind: "wait" };
  }
  const conditions = step.conditions;

  const satisfied = (() => {
    switch (conditions.if) {
      case "no_reply": return triggerType === "TIME_ELAPSED" && !facts.replied;
      case "no_open": return triggerType === "TIME_ELAPSED" && !facts.opened;
      case "no_click": return triggerType === "TIME_ELAPSED" && !facts.clicked;
      case "replied": return triggerType === "REPLIED";
      case "bounced": return triggerType === "BOUNCED";
      case "clicked": return triggerType === "CLICKED";
      default:
        throw new Error(`step ${step.stepNumber} has unknown condition "${String(conditions.if)}" (allowed: ${STEP_CONDITIONS.join(", ")})`);
    }
  })();
  if (!satisfied) return { kind: "wait" };

  switch (conditions.then ?? "next") {
    case "next": return { kind: "send" };
    case "skip": return { kind: "skip" };
    case "end": return { kind: "end" };
    case "branch": {
      const target = conditions.branchToStep;
      if (!Number.isInteger(target) || (target as number) <= step.stepNumber) {
        throw new Error(`step ${step.stepNumber} branches to ${JSON.stringify(target)} — branchToStep must name a later step number`);
      }
      return { kind: "branch", stepNumber: target as number };
    }
    default:
      throw new Error(`step ${step.stepNumber} has unknown action "${String(conditions.then)}" (allowed: ${STEP_ACTIONS.join(", ")})`);
  }
}

/**
 * The write-time twin of `stepOutcome`'s refusals: returns the problem with one
 * step's `conditions`, or null when the engine can honour them. The route names
 * the step index; the engine refuses the same configurations again at run time,
 * because rows outlive the request that made them.
 */
export function conditionProblem(
  step: { stepNumber: number; conditions?: unknown },
  stepNumbers: number[],
): string | null {
  const conditions = step.conditions;
  if (conditions === undefined || conditions === null) return null;
  if (typeof conditions !== "object" || Array.isArray(conditions)) return "conditions must be an object";

  const { if: condition, then: action, branchToStep } = conditions as Record<string, unknown>;
  if (typeof condition !== "string" || !(STEP_CONDITIONS as readonly string[]).includes(condition)) {
    return `conditions.if must be one of ${STEP_CONDITIONS.join(", ")}`;
  }
  if (action !== undefined && (typeof action !== "string" || !(STEP_ACTIONS as readonly string[]).includes(action))) {
    return `conditions.then must be one of ${STEP_ACTIONS.join(", ")}`;
  }
  if (branchToStep !== undefined || action === "branch") {
    if (action !== "branch") return 'conditions.branchToStep only applies when conditions.then is "branch"';
    if (!Number.isInteger(branchToStep) || (branchToStep as number) <= step.stepNumber) {
      return "conditions.branchToStep must name a later step number of this sequence";
    }
    if (!stepNumbers.includes(branchToStep as number)) {
      return `conditions.branchToStep names step ${String(branchToStep)}, which this sequence does not have`;
    }
  }
  return null;
}

/**
 * What a step needs from its enrollment — and deliberately not `any`.
 *
 * The workspace lives on the campaign: `Enrollment` has no column for it, and
 * `enrollment.workspaceId` compiled under `any` while being `undefined` at
 * runtime. Prisma reads an undefined filter as no filter, so the account
 * lookup below searched every workspace's accounts and a tenant with none of
 * its own could send through another tenant's. Typed here, that read cannot
 * come back: the field the lookup needs is the one the include provides.
 */
type StepEnrollment = {
  id: string;
  contactId: string;
  metadata: unknown;
  contact: unknown;
  campaign: { workspaceId: string };
  abVariant: { name: string; templateId: string | null } | null;
};

async function executeStep(enrollment: StepEnrollment, step: SequenceStepConfig): Promise<void> {
  // A variant's template overrides the step's for every step of the arm —
  // that is the division of labour the two fields state: `sequenceId` sends a
  // different track, `templateId` sends different copy down the same one.
  // An arm template that no longer resolves refuses the send instead of
  // falling back: handing the arm the control's copy would silently convert
  // its cohort, and the test would then compare a message nobody was sent.
  const templateId = enrollment.abVariant?.templateId ?? step.templateId;
  const template = templateId ? await prisma.template.findUnique({ where: { id: templateId } }) : null;
  if (enrollment.abVariant?.templateId && !template) {
    throw new Error(`arm "${enrollment.abVariant.name}" points at a template that no longer exists — fix the arm or pause the test before this step can send`);
  }
  // The delete route refuses to remove a template a step still references
  // (both FKs are `SetNull`), so this guard is what remains for the states a
  // direct database edit can produce: a dangling id must refuse by name, not
  // send the placeholder `Step N` body with the channel's "New message"
  // subject to a real prospect.
  if (templateId && !template) {
    throw new Error(`step ${step.stepNumber} points at a template that no longer exists — attach a new template before it can send`);
  }

  const messageBody = template ? renderTemplate(template.body, enrollment.contact, enrollment.metadata) : `Step ${step.stepNumber}`;

  const sendingAccount = await selectSendingAccount(enrollment.campaign.workspaceId, step.channel);
  if (!sendingAccount) throw new Error(`No active sending account for channel ${step.channel}`);

  const sentMessage = await prisma.sentMessage.create({
    data: {
      sendingAccountId: sendingAccount.id,
      enrollmentId: enrollment.id,
      contactId: enrollment.contactId,
      templateId,
      channel: step.channel,
      subject: step.channel === "EMAIL" && template ? renderTemplate(template.subject || "", enrollment.contact, enrollment.metadata) : undefined,
      body: messageBody,
      status: "QUEUED",
    },
  });

  await enqueue(queues.send, "send-message", { messageId: sentMessage.id });

  await prisma.enrollment.update({
    where: { id: enrollment.id },
    data: { currentStep: { increment: 1 }, nextActionAt: calculateNextAction(step) },
  });
}

async function selectSendingAccount(workspaceId: string, channel: string) {
  const accounts = await prisma.sendingAccount.findMany({
    where: { workspaceId, channel, isActive: true },
    orderBy: { reputationScore: "desc" },
  });

  for (const account of accounts) {
    const health = await getEmailAccountHealth(account.id);
    if (health.dailySent < account.dailyLimit && health.reputation > 50) {
      return account;
    }
  }
  return null;
}

async function hasReply(enrollmentId: string): Promise<boolean> {
  return prisma.activity.findFirst({ where: { enrollmentId, type: "REPLIED" } }).then(Boolean);
}

async function hasOpen(enrollmentId: string): Promise<boolean> {
  return prisma.activity.findFirst({ where: { enrollmentId, type: "OPENED" } }).then(Boolean);
}

async function hasClick(enrollmentId: string): Promise<boolean> {
  return prisma.activity.findFirst({ where: { enrollmentId, type: "CLICKED" } }).then(Boolean);
}

function renderTemplate(template: string, contact: any, metadata?: any): string {
  return template
    .replace(/\{\{firstName\}\}/g, contact.firstName || "")
    .replace(/\{\{lastName\}\}/g, contact.lastName || "")
    .replace(/\{\{company\}\}/g, contact.company || "")
    .replace(/\{\{title\}\}/g, contact.title || "")
    .replace(/\{\{email\}\}/g, contact.email || "")
    .replace(/\{\{(\w+)\}\}/g, (_, key) => metadata?.[key] || "");
}

function calculateNextAction(step: SequenceStepConfig): Date {
  const next = new Date();
  next.setDate(next.getDate() + step.delayDays);
  next.setHours(next.getHours() + step.delayHours);
  return next;
}

/**
 * The enrollment finished its sequence, and that is the CRM-signal moment:
 * `sequence.completed` is emitted after the write that makes the event true,
 * with the tuple a receiver needs to join back (enrollment, contact, sequence).
 * Best-effort — `triggerWebhooks` never throws, so a subscriber cannot fail a
 * queue job whose real work already committed.
 *
 * The workspace is read through the campaign: `Enrollment` has no column of its
 * own for it, and the row arrives here with that relation included.
 */
async function completeEnrollment(enrollment: {
  id: string;
  contactId: string;
  sequenceId: string;
  campaign: { workspaceId: string };
}): Promise<void> {
  const completedAt = new Date();
  await prisma.enrollment.update({
    where: { id: enrollment.id },
    data: { status: "COMPLETED", completedAt },
  });
  void triggerWebhooks(enrollment.campaign.workspaceId, "sequence.completed", {
    enrollmentId: enrollment.id,
    contactId: enrollment.contactId,
    sequenceId: enrollment.sequenceId,
    completedAt: completedAt.toISOString(),
  });
}

// Warmup logic
async function getEmailAccountHealth(accountId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const [sent, bounced] = await Promise.all([
    prisma.sentMessage.count({ where: { sendingAccountId: accountId, createdAt: { gte: today, lt: tomorrow }, status: "SENT" } }),
    prisma.sentMessage.count({ where: { sendingAccountId: accountId, createdAt: { gte: today, lt: tomorrow }, status: "BOUNCED" } }),
  ]);

  const account = await prisma.sendingAccount.findUnique({ where: { id: accountId }, select: { reputationScore: true } });

  return { reputation: account?.reputationScore || 100, dailySent: sent, bounces: bounced, complaints: 0 };
}