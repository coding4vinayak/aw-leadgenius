import { prisma } from "./db";
import { queues, enqueue } from "./queue";

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

export async function processSequenceStep(enrollmentId: string, triggerType: "ENROLLED" | "SENT" | "DELIVERED" | "OPENED" | "CLICKED" | "REPLIED" | "BOUNCED" | "TIME_ELAPSED"): Promise<void> {
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
    await completeEnrollment(enrollmentId);
    return;
  }

  const shouldProceed = await evaluateStepConditions(enrollment, currentStep, triggerType);
  if (!shouldProceed) return;

  await executeStep(enrollment, currentStep);
}

async function evaluateStepConditions(enrollment: any, step: SequenceStepConfig, triggerType: string): Promise<boolean> {
  if (!step.conditions) return true;

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

async function completeEnrollment(enrollmentId: string): Promise<void> {
  await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: { status: "COMPLETED", completedAt: new Date() },
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