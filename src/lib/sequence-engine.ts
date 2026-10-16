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
    },
  });

  if (!enrollment || enrollment.status !== "ACTIVE") return;

  const steps = enrollment.sequence.steps as unknown as SequenceStepConfig[];
  const currentStep = steps[enrollment.currentStep];

  if (!currentStep) {
    await completeEnrollment(enrollment);
    return;
  }

  const shouldProceed = await evaluateStepConditions(enrollment, currentStep, triggerType, now);
  if (!shouldProceed) return;

  await executeStep(enrollment, currentStep);
}

async function evaluateStepConditions(
  enrollment: any,
  step: SequenceStepConfig,
  triggerType: string,
  now: Date,
): Promise<boolean> {
  if (!step.conditions) {
    // A step with no condition has nothing to check but the calendar, and the
    // calendar is the whole product: `delayDays: 3` between two emails means the
    // prospect gets them three days apart. Without this line the `SENT` job the
    // send worker queues the moment a message leaves spends the next step in the
    // same second — which is the failure `POST /api/sequences` already describes
    // about a lost delay ("scheduled a two-week sequence to run in a day"),
    // arrived at from the other side. It is also the reason a follow-up lands on
    // a domain that has not warmed up yet: the throttle and reputation floors in
    // `selectSendingAccount` exist for spacing this app is not doing.
    return stepIsDue(enrollment.nextActionAt, now);
  }

  const { if: condition, then: action } = step.conditions;

  switch (condition) {
    case "no_reply":
      return triggerType === "TIME_ELAPSED" && !await hasReply(enrollment.id);
    case "no_open":
      return triggerType === "TIME_ELAPSED" && !await hasOpen(enrollment.id);
    case "no_click":
      return triggerType === "TIME_ELAPSED" && !await hasClick(enrollment.id);
    case "replied":
      return triggerType === "REPLIED";
    case "bounced":
      return triggerType === "BOUNCED";
    case "clicked":
      return triggerType === "CLICKED";
    default:
      return true;
  }
}

async function executeStep(enrollment: any, step: SequenceStepConfig): Promise<void> {
  const template = step.templateId ? await prisma.template.findUnique({ where: { id: step.templateId } }) : null;

  const messageBody = template ? renderTemplate(template.body, enrollment.contact, enrollment.metadata) : `Step ${step.stepNumber}`;

  const sendingAccount = await selectSendingAccount(enrollment.workspaceId, step.channel);
  if (!sendingAccount) throw new Error(`No active sending account for channel ${step.channel}`);

  const sentMessage = await prisma.sentMessage.create({
    data: {
      sendingAccountId: sendingAccount.id,
      enrollmentId: enrollment.id,
      contactId: enrollment.contactId,
      templateId: step.templateId,
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