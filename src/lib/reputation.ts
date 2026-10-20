// The reputation floor was a lie: `SendingAccount.reputationScore` is read
// by the sender gate (`sequence-engine.ts`) and displayed by the health
// panel, but no code path in the live app WRITES it — no route, no worker,
// no job. Every account sits at its schema default of 100 forever, so the
// gate's `> 50` comparison is arithmetic that can never refuse anything,
// while the README and the onboarding email both sell "reputation floors".
// This file makes the number mean what the copy says: a rate over the
// account's own deliverable sends, derived from the ledger the #31 round
// already keeps honest, written back on the events that change it and by a
// throttled pass that lets a bad day age out on the calendar.
import { prisma } from "./db";

export const REPUTATION_WINDOW_DAYS = 14;

/**
 * The gate line. Selection refuses an account at or below this score —
 * named, not a bare `50`, so the README's "reputation floors" and the code
 * agree on where the floor is.
 */
export const REPUTATION_FLOOR = 50;

/**
 * The deliverability rate, on the scale the column and the UI already use.
 *
 * A spam complaint counts three times a bounce: a bounce is a dead address
 * — the list's problem — while a complaint tells the inbox provider that
 * living people did not want this mail, which is the event that actually
 * threatens the domain. Weighting is per event, not per day: 50 clean sends
 * with 1 complaint sits above the floor with room, and the floor is crossed
 * at 17 weighted hurts per hundred — a rate an operator can name.
 *
 * The denominator is the ledger's own deliverable set (see `windowWhere`:
 * everything the day committed except a dispatch `FAILED`), so this function
 * and the warmup cap never disagree about what a send was. Zero deliverable
 * sends is a perfect 100: an account that has sent nothing has done nothing
 * wrong, and the floor exists to keep a KNOWN-bad domain out of rotation,
 * not an unknown one.
 */
export function reputationFrom(deliverable: number, bounces: number, complaints: number): number {
  if (deliverable <= 0) return 100;
  const weighted = bounces + 3 * complaints;
  const score = 100 * (1 - weighted / deliverable);
  return Math.round(Math.min(100, Math.max(0, score)));
}

export function reputationWindowWhere(accountId: string, now: Date): { sendingAccountId: string; createdAt: { gte: Date } } {
  const since = new Date(now);
  since.setDate(since.getDate() - REPUTATION_WINDOW_DAYS);
  return { sendingAccountId: accountId, createdAt: { gte: since } };
}

/**
 * The same window with the #31 ledger vocabulary attached — every row the
 * account committed except a dispatch `FAILED`. The health panel counts
 * through this so its numbers and the score are readings of one ledger; a
 * second `SENT`-only definition of "what this account sent" is what #31
 * deleted from the engine for exactly that reason.
 */
export function reputationLedgerWhere(accountId: string, now: Date): { sendingAccountId: string; createdAt: { gte: Date }; NOT: { status: string } } {
  return { ...reputationWindowWhere(accountId, now), NOT: { status: "FAILED" } };
}

/**
 * The window, stated for ONE aggregate over many accounts: the same 14-day
 * edge, unscoped, for the throttled sweep pass. Kept as data, not inlined,
 * so the per-account recompute and the batch refresh cannot drift into two
 * definitions of "recent" — this fleet's signature disease.
 */
export function reputationWindowStart(now: Date): Date {
  const since = new Date(now);
  since.setDate(since.getDate() - REPUTATION_WINDOW_DAYS);
  return since;
}

async function writeReputation(accountId: string, deliverable: number, bounces: number, complaints: number): Promise<void> {
  await prisma.sendingAccount.update({
    where: { id: accountId },
    data: { reputationScore: reputationFrom(deliverable, bounces, complaints) },
  });
}

/**
 * Recompute one account from its own ledger rows. Full re-count, not an
 * increment: the same event arriving twice (a webhook redelivery that the
 * idempotency gate let write, followed by its undo) lands on the same
 * numbers, and a score derived from the ledger is the ledger's reading —
 * never a running total that can drift.
 */
export async function recomputeAccountReputation(accountId: string, now: Date = new Date()): Promise<void> {
  const window = reputationWindowWhere(accountId, now);
  const [deliverable, bounces, complaints] = await Promise.all([
    prisma.sentMessage.count({ where: { ...window, NOT: { status: "FAILED" } } }),
    prisma.sentMessage.count({ where: { ...window, status: "BOUNCED" } }),
    prisma.sentMessage.count({ where: { ...window, status: "COMPLAINED" } }),
  ]);
  await writeReputation(accountId, deliverable, bounces, complaints);
}

/**
 * Every active account, one aggregate — the throttled pass that lets a bad
 * day age out on the calendar even if the account sends nothing further.
 * Accounts with no rows in the window simply re-read as 100, which is what
 * recovery IS under a rolling window.
 */
export async function refreshAllReputations(now: Date = new Date()): Promise<number> {
  const grouped = await prisma.sentMessage.groupBy({
    by: ["sendingAccountId", "status"],
    where: { createdAt: { gte: reputationWindowStart(now) } },
    _count: { _all: true },
  });
  const tally = new Map<string, { deliverable: number; bounces: number; complaints: number }>();
  for (const row of grouped) {
    const t = tally.get(row.sendingAccountId) ?? { deliverable: 0, bounces: 0, complaints: 0 };
    if (row.status !== "FAILED") t.deliverable += row._count._all;
    if (row.status === "BOUNCED") t.bounces += row._count._all;
    if (row.status === "COMPLAINED") t.complaints += row._count._all;
    tally.set(row.sendingAccountId, t);
  }
  const accounts = await prisma.sendingAccount.findMany({ where: { isActive: true }, select: { id: true } });
  for (const account of accounts) {
    const t = tally.get(account.id) ?? { deliverable: 0, bounces: 0, complaints: 0 };
    await writeReputation(account.id, t.deliverable, t.bounces, t.complaints);
  }
  return accounts.length;
}

/**
 * The sweep tick's throttle: one calendar pass per REPUTATION_REFRESH_MINUTES
 * window, decided on absolute epoch minutes so two app processes and two
 * partial-minute ticks agree on the boundary. The sweep itself stays the
 * minute; the ledger events keep the score fresh between passes.
 */
export const REPUTATION_REFRESH_MINUTES = 15;

export function reputationRefreshDue(now: Date, last: Date | null): boolean {
  if (!last) return true;
  const nowMinute = Math.floor(now.getTime() / 60_000);
  const lastMinute = Math.floor(last.getTime() / 60_000);
  return nowMinute - lastMinute >= REPUTATION_REFRESH_MINUTES;
}
