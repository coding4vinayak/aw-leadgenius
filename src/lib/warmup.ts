import { prisma } from "./db";
import { queues } from "./queue";

export async function runWarmup(accountId: string): Promise<void> {
  const account = await prisma.sendingAccount.findUnique({ where: { id: accountId } });
  if (!account || !account.warmupEnabled || !account.isActive) return;

  const health = await getAccountHealth(accountId);
  if (health.reputation < 30) {
    console.warn(`Account ${accountId} reputation too low for warmup`);
    return;
  }

  const warmupContacts = await getWarmupContacts(account.workspaceId, account.channel);
  if (warmupContacts.length === 0) return;

  const sentToday = await getSentToday(accountId);
  const remaining = Math.max(0, account.dailyLimit - sentToday);
  const warmupLimit = Math.min(account.warmupStage * 5, remaining);

  for (let i = 0; i < warmupLimit; i++) {
    const contact = warmupContacts[i % warmupContacts.length];
    await sendWarmupMessage(account, contact);
  }

  if (account.warmupStage < 20) {
    await prisma.sendingAccount.update({ where: { id: accountId }, data: { warmupStage: { increment: 1 } } });
  }
}

async function getAccountHealth(accountId: string) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

  const [sent, bounced] = await Promise.all([
    prisma.sentMessage.count({ where: { sendingAccountId: accountId, createdAt: { gte: today, lt: tomorrow }, status: "SENT" } }),
    prisma.sentMessage.count({ where: { sendingAccountId: accountId, createdAt: { gte: today, lt: tomorrow }, status: "BOUNCED" } }),
  ]);

  const account = await prisma.sendingAccount.findUnique({ where: { id: accountId }, select: { reputationScore: true } });
  return { reputation: account?.reputationScore || 100, dailySent: sent, bounces: bounced };
}

async function getWarmupContacts(workspaceId: string, channel: string) {
  return prisma.contact.findMany({
    where: { workspaceId, status: "ACTIVE", [channel.toLowerCase()]: { not: null } },
    take: 50,
    orderBy: { lastContactAt: "asc" },
  });
}

async function getSentToday(accountId: string) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return prisma.sentMessage.count({ where: { sendingAccountId: accountId, createdAt: { gte: today }, status: "SENT" } });
}

async function sendWarmupMessage(account: any, contact: any) {
  const templates = {
    EMAIL: { subject: "Quick question", body: `Hi {{firstName}}, just checking in. - {{senderName}}` },
    WHATSAPP: { subject: undefined, body: "Hi {{firstName}}, quick question for you." },
    LINKEDIN: { subject: undefined, body: "Hi {{firstName}}, connecting regarding..." },
  } as const;

  const template = templates[account.channel as keyof typeof templates] ?? templates.EMAIL;
  const body = template.body.replace("{{firstName}}", contact.firstName || "there").replace("{{senderName}}", account.name);

  await prisma.sentMessage.create({
    data: {
      sendingAccountId: account.id,
      contactId: contact.id,
      channel: account.channel,
      subject: account.channel === "EMAIL" ? template.subject : undefined,
      body,
      status: "QUEUED",
    },
  });
}

const WARMUP_POOL = [
  "partner@warmup.leadgenius.io",
  "hello@warmup.leadgenius.io",
  "team@warmup.leadgenius.io",
];

export async function scheduleWarmup(accountId: string): Promise<string> {
  // A per-account scheduler, keyed by the id, not `add(..., { repeat })`.
  //
  // The old form derived its repeat key from `getRepeatConcatOptions` =
  // `${name}:${jobId}:${endDate}:${tz}:${pattern}` (bullmq repeat.js:170-177, read from
  // source) — the job data is not an input, so `accountId` never reached the key. Two
  // sending accounts therefore collapsed onto a single scheduler whose stored template
  // (the only source of job data for every future tick) named whichever registered first;
  // scheduling the second..Nth account was a silent no-op while the route still answered
  // {ok:true}. Measured on scratch db 13 both directions (§8.32.1): two adds → one
  // scheduler id, count 1, and the template names the first to ask, not the second.
  //
  // `upsertJobScheduler` with a fixed key is idempotent per account (the same leadworks
  // shape since #53): re-scheduling one account overrides its own scheduler rather than
  // minting a second, and distinct accounts get distinct keys. The key carries no colon,
  // which bullmq's job-id validation rejects for a two-part id (job.js:1069-1076).
  const job = await queues.warmup.upsertJobScheduler(
    `warmup-${accountId}`,
    { pattern: "0 9 * * *" },
    { name: "run-warmup", data: { accountId } },
  );
  if (!job?.id) throw new Error("Failed to create warmup job");
  return job.id;
}