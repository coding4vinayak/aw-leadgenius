import { prisma } from "./db";
import { queues, enqueue, QueueUnavailableError } from "./queue";

/**
 * The addresses a warmup run talks to. Real deliverability tooling measures an
 * inbox by mailing *other inboxes that mail back* — never the prospect list.
 * These rows are not people; they exist so the send pipeline has a recipient
 * (schema requires a contact) and are marked `DO_NOT_CONTACT` so the campaign
 * doors round 13 built refuse to enroll them. The constant predates this file
 * knowing that: it sat here, unreferenced, one of the repo's standing lint
 * warnings, while `runWarmup` mailed real ACTIVE workspace contacts instead.
 */
export const WARMUP_POOL = [
  "partner@warmup.leadgenius.io",
  "hello@warmup.leadgenius.io",
  "team@warmup.leadgenius.io",
];

/**
 * How many messages this run may create: the ramp (`warmupStage` * 5) capped
 * by the budget the account has left today. Pure, so both caps get known
 * answers; `getSentToday` counts rows the send worker already flipped to
 * `SENT`, which is what makes the cap real rather than decorative.
 */
export function warmupPlan(account: { warmupStage: number; dailyLimit: number }, sentToday: number): number {
  const remaining = Math.max(0, account.dailyLimit - sentToday);
  return Math.min(account.warmupStage * 5, remaining);
}

/**
 * Warmup models an SMTP inbox's reputation ramp — a feedback loop this
 * deployment has only for email. The other channels used to be *attempted*:
 * the contact lookup keyed on `[channel.toLowerCase()]`, and `whatsapp` and
 * `linkedin` are not Contact fields (`phone`, `linkedinUrl`), so enabling
 * warmup on those accounts threw a Prisma validation error into the job every
 * 9am. Refusing is the honest answer, and it is this function's whole job.
 */
export function warmupChannelSupported(channel: string): boolean {
  return channel === "EMAIL";
}

/**
 * Find-or-create the pool's Contact rows for this workspace. Upserted on the
 * `(workspaceId, email)` unique — re-running warmup never mints a second row —
 * and `update: {}` leaves an operator's later edit of these rows alone.
 */
async function ensureWarmupPoolContacts(workspaceId: string) {
  const contacts = [];
  for (const email of WARMUP_POOL) {
    contacts.push(await prisma.contact.upsert({
      where: { workspaceId_email: { workspaceId, email } },
      update: {},
      create: {
        workspaceId,
        email,
        firstName: "Warmup",
        lastName: email.split("@")[0],
        company: "Abetworks warmup pool",
        status: "DO_NOT_CONTACT",
        source: "warmup",
      },
    }));
  }
  return contacts;
}

export async function runWarmup(accountId: string): Promise<void> {
  const account = await prisma.sendingAccount.findUnique({ where: { id: accountId } });
  if (!account || !account.warmupEnabled || !account.isActive) return;
  if (!warmupChannelSupported(account.channel)) return;

  const health = await getAccountHealth(accountId);
  if (health.reputation < 30) {
    console.warn(`Account ${accountId} reputation too low for warmup`);
    return;
  }

  const pool = await ensureWarmupPoolContacts(account.workspaceId);
  const plan = warmupPlan(account, await getSentToday(accountId));

  for (let i = 0; i < plan; i++) {
    await sendWarmupMessage(account, pool[i % pool.length]);
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

async function getSentToday(accountId: string) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return prisma.sentMessage.count({ where: { sendingAccountId: accountId, createdAt: { gte: today }, status: "SENT" } });
}

/**
 * Write the row and hand it to the queue in the same breath, which is the
 * `executeStep` shape: `QUEUED` may only be claimed while a job exists that
 * will make it true. A queue outage flips the row to `FAILED` with the
 * outage's own words and stops the run — the alternative, leaving the row
 * `QUEUED`, is the lie this round exists to remove.
 */
async function sendWarmupMessage(account: { id: string; channel: string; name: string }, contact: { id: string; firstName: string | null }) {
  const body = `Hi ${contact.firstName || "there"}, just checking in. - ${account.name}`;

  const message = await prisma.sentMessage.create({
    data: {
      sendingAccountId: account.id,
      contactId: contact.id,
      channel: account.channel,
      subject: "Quick question",
      body,
      status: "QUEUED",
    },
  });

  try {
    await enqueue(queues.send, "send-message", { messageId: message.id });
  } catch (error) {
    if (error instanceof QueueUnavailableError) {
      await prisma.sentMessage.update({
        where: { id: message.id },
        data: { status: "FAILED", error: `warmup queue unavailable: ${error.message}` },
      });
    }
    throw error;
  }
}

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
