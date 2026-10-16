import { prisma } from "@/lib/db";
import { Prisma, Activity } from "@/generated/prisma/client";

/**
 * The stable, provider-derived key that makes a re-delivered webhook a no-op
 * rather than a second row. A retry replays the provider's own event fields, so
 * it reproduces this string exactly; a genuine second event differs — a different
 * message, a different activity type, or the provider's own (now different) event
 * timestamp. `timestamp` is the *provider's* event time, not our clock: using
 * `new Date()` here would mint a fresh key on every retry and deduplicate nothing.
 */
export function activityIdempotencyKey(parts: {
  channel: string;
  messageId: string;
  activityType: string;
  timestamp?: Date;
}): string {
  return `${parts.channel}:${parts.messageId}:${parts.activityType}:${parts.timestamp ? parts.timestamp.getTime() : "no-ts"}`;
}

/**
 * Idempotent write of one inbound provider event. Returns the created Activity, or
 * `null` when this delivery was already recorded.
 *
 * The gate is the `Activity.idempotencyKey` unique index, not a read-then-write
 * check: `findFirst`-then-`create` has the same race a provider retry is (both
 * requests see "not there yet" and both insert). This is the construction the
 * schema already trusts for signup — "the unique index is what makes signup
 * idempotent at the database level rather than only in application code"
 * (`User.email @unique`). A colliding insert raises Prisma P2002, which is exactly
 * the "already recorded" case #60 is about; anything else is a real error and
 * propagates.
 *
 * A `null` return is the caller's signal to skip the rest of processing for that
 * event — the rollup and the sequence step already ran on the delivery that won
 * the insert. Driving those side effects durably across a *failed-first-then-
 * retried* delivery (the row committed, the inline enqueue did not) is #65's
 * subject, closed here by `undoInboundSideEffect`: the route catches a
 * `QueueUnavailableError` on the enqueue and calls the undo, so the redelivery
 * sees no committed row and replays the whole shape.
 */
export async function recordInboundActivity(
  idempotencyKey: string,
  data: Omit<Prisma.ActivityUncheckedCreateInput, "idempotencyKey">,
): Promise<Activity | null> {
  try {
    return await prisma.activity.create({ data: { ...data, idempotencyKey } });
  } catch (error) {
    if ((error as { code?: unknown }).code === "P2002") return null;
    throw error;
  }
}

/**
 * Undo the committed side of an inbound delivery whose inline enqueue failed
 * (#65). Deletes the Activity row so a redelivery can win the unique insert
 * again, and runs every revert the caller accumulated between the row commit
 * and the enqueue — enrollment status, sentMessage status, and anything else a
 * route wrote after `recordInboundActivity` returned.
 *
 * The reverts are thunks, not promises: constructed promises would start
 * running the moment they were placed in the array, i.e. *before* the route
 * knew it needed them. Passing `() => prisma.x.update(…)` keeps them inert
 * until the caller has decided, on the failure path, that they should run.
 *
 * Every arm is best-effort — a `Promise.allSettled` that logs each rejection.
 * Two considerations drove that. First, Redis being unavailable does not
 * imply SQLite is: the compensating writes will usually succeed, but the
 * route answering 503 is the contract with the provider regardless of
 * whether the rollback finished. Second, a `throw` from inside a catch of the
 * enqueue's catch would replace the queue's error with the DB's, and the
 * provider would see a 500 that hides a 503.
 *
 * If the rollback *itself* partially fails, the row may be deleted while the
 * enrollment stays flipped, or vice versa. That is a worse-than-#65 state in
 * audit terms but not in behaviour terms: the sequence step is what actually
 * runs a workflow, and the row being gone means the redelivery drives it.
 * The status alone being wrong does not silently skip anything; it changes
 * what a UI shows. Logging is enough — the family has no alerting on top of
 * console output.
 */
export async function undoInboundSideEffect(
  activityId: string,
  reverts: Array<() => Promise<unknown>>,
): Promise<void> {
  const tasks: Array<Promise<unknown>> = [
    prisma.activity.delete({ where: { id: activityId } }),
    ...reverts.map((fn) => fn()),
  ];
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") console.error("[#65] rollback arm failed", r.reason);
  }
}
