import { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { processSequenceStep } from "./sequence-engine";

/**
 * How many enrollments one tick of the sweep spends. A bound, not a tuning
 * number: the cadence is a minute and the work inside a step is a template
 * render, a sender lookup and an enqueue, so a hundred is far past what a
 * healthy tenant has waiting and is only ever reached by a backlog. With a
 * backlog the oldest waits first (`orderBy`) and the rest drain a hundred at a
 * time rather than one tick blocking on every row the database has.
 */
export const SEQUENCE_SWEEP_BATCH = 100;

/**
 * The clause the scan runs. Separate from the query so the whole rule — an
 * *active* enrollment with a *recorded* wait that has *passed* — is testable
 * with two dates instead of a database.
 *
 * `status: "ACTIVE"` is not a redundancy with the engine's own check: pausing a
 * sequence is the one thing a buyer is entitled to do mid-flight, and a sweep
 * that selected paused rows would hand them to an engine that declines them
 * while leaving `nextActionAt` in the past — so every paused enrollment in the
 * database would be re-read, re-declined and re-logged once a minute for as long
 * as it stayed paused.
 */
export function sequenceDueWhere(now: Date): Prisma.EnrollmentWhereInput {
  return { status: "ACTIVE", nextActionAt: { not: null, lte: now } };
}

/**
 * One tick of the cadence: every active enrollment whose recorded wait has
 * ended gets its next step evaluated.
 *
 * This function is the reader `Enrollment.nextActionAt` never had. The engine
 * wrote the column at the end of every step (`sequence-engine.ts:executeStep`)
 * and `prisma/schema.prisma` indexes it (`@@index([nextActionAt])`), while the
 * only triggers anything produced were `ENROLLED` and the activity webhooks —
 * including `SENT`, which the send worker fires the moment a message leaves. So
 * a step whose condition is a *wait* (`no_reply`, `no_open`, `no_click`, all of
 * which require `TIME_ELAPSED` to be true) could never be satisfied by anything,
 * and a four-step sequence delivered one email. That is the product a seat is
 * billed for, not delivered.
 *
 * The `now` is passed down rather than re-taken: the scan decides who is due at
 * one instant and the engine decides whether the step may be spent at the same
 * one. Two clocks would mean a row read as due can be read as not-due by its own
 * check microseconds later, and the follow-up is silently skipped — the failure
 * mode this function exists to end.
 *
 * Per-enrollment failure isolation, which a sweep over shared state requires:
 * `executeStep` throws for a workspace with no configured sending account
 * ("No active sending account for channel EMAIL"). Left uncaught, the first such
 * tenant would abort the pass, every tenant queued behind it would go unsent
 * until that row's wait moved, and the same row would reproduce the outage on the
 * next minute — a configuration mistake in one workspace holding the whole
 * product's cadence hostage. The row stays due and is retried on the next tick,
 * which is the correct behaviour for a sender that has hit its daily limit and is
 * the retry that a sender which is simply missing needs a human to fix.
 */
export async function runDueSequenceSteps(now: Date = new Date(), take: number = SEQUENCE_SWEEP_BATCH): Promise<number> {
  const due = await prisma.enrollment.findMany({
    where: sequenceDueWhere(now),
    select: { id: true },
    orderBy: { nextActionAt: "asc" },
    take,
  });

  let processed = 0;
  for (const enrollment of due) {
    try {
      await processSequenceStep(enrollment.id, "TIME_ELAPSED", now);
      processed++;
    } catch (error) {
      console.error(`[sequence] due enrollment ${enrollment.id} could not be evaluated:`, error);
    }
  }
  return processed;
}
