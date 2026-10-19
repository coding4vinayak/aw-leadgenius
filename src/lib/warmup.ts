import { prisma } from "./db";
import { queues } from "./queue";

/**
 * The ramp, as arithmetic: a warming account may send 5 messages on its first
 * day, 5 more for every nightly pass it has taken, and its own `dailyLimit`
 * once the ramp is over. `min` because the ramp only ever caps — a workspace
 * that chose a 30/day limit must not have warmup *raise* it to 100.
 *
 * This is the cap the sender gate enforces (`sequence-engine.ts`,
 * `selectSendingAccount`); nothing sends on a pass's behalf. See `runWarmup`.
 */
export const WARMUP_STEP_DAILY_SENDS = 5;
export const WARMUP_MAX_STAGE = 20;

export function warmupDailyLimit(dailyLimit: number, warmupEnabled: boolean, warmupStage: number): number {
  if (!warmupEnabled) return dailyLimit;
  const stage = Math.max(0, Math.floor(warmupStage));
  if (stage >= WARMUP_MAX_STAGE) return dailyLimit;
  return Math.min(dailyLimit, (stage + 1) * WARMUP_STEP_DAILY_SENDS);
}

/**
 * The cap's ledger: every message the day committed, until midnight rolls it
 * out. A row is spent the moment it is created — `QUEUED` means a send job is
 * already holding it, and counting only what the worker has finished letting
 * one due-sweep tick mint six "5/day" emails while their rows sat in flight.
 * A relabeled row is spent too: `BOUNCED`, `COMPLAINED`, `UNSUBSCRIBED`,
 * `DELIVERED` all say an SMTP conversation completed, and a bounce that freed
 * capacity for the next email would reward precisely the traffic the ramp
 * exists to throttle. `FAILED` alone gives the day back — the message never
 * left the account.
 */
export function capSpendTodayWhere(accountId: string, now: Date): { sendingAccountId: string; createdAt: { gte: Date; lt: Date }; NOT: { status: string } } {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);
  return { sendingAccountId: accountId, createdAt: { gte: startOfDay, lt: endOfDay }, NOT: { status: "FAILED" } };
}

/**
 * One warmup pass — what the nightly per-account scheduler and the route's
 * `?action=warmup` tick. The pass advances the stage and nothing else; the
 * raised cap for the next day (`warmupDailyLimit`) is its whole product.
 * Reputation still gates real sends at selection (`reputation > 50`); a pass
 * is a calendar, not a sender.
 *
 * Passes used to *write messages*: "just checking in" `SentMessage` rows
 * addressed to the workspace's own contacts, `QUEUED` in a state nothing ever
 * sent — and aimed at the customer's real prospects if anything ever had. A
 * ramp protects a domain by limiting the customer's real volume; fake traffic
 * protects nothing, and a row a customer's contact can see protects less.
 */
export async function runWarmup(accountId: string): Promise<void> {
  const account = await prisma.sendingAccount.findUnique({ where: { id: accountId } });
  if (!account || !account.warmupEnabled || !account.isActive) return;
  if (account.warmupStage >= WARMUP_MAX_STAGE) return;

  await prisma.sendingAccount.update({ where: { id: accountId }, data: { warmupStage: { increment: 1 } } });
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
