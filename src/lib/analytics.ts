import { prisma } from "./db";
import { queues, enqueue } from "./queue";

export interface DailyAnalytics {
  date: Date;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
  byChannel: Record<string, { sent: number; opened: number; clicked: number; replied: number }>;
}

/**
 * Local midnight of the day `date` falls in — the same normalization `aggregateAnalytics`
 * buckets on, so a job's key and the row it writes cannot name different days.
 */
function dayBucket(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** `20261006`, from local components. */
function dayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * One job per workspace per day, so a busy day coalesces instead of queueing a rollup per
 * event. Colon-free on purpose: a custom jobId may contain a colon only in a shape that
 * splits into exactly three parts (`bullmq/dist/cjs/classes/job.js:1069-1076`), and that
 * three-part shape is what `repeat.js:78` and `scripts.js:388` go on to parse as a legacy
 * repeatable key. Measured on scratch db 13: `analytics:w1` threw `Custom Id cannot
 * contain :`, `analytics:w1:2026-10-06` was accepted and stored as a job key.
 */
export function rollupJobId(workspaceId: string, bucket: Date): string {
  return `analytics-${workspaceId}-${dayKey(bucket)}`;
}

/**
 * Queue the day's rollup. The `analytics` Worker has had nothing to drain since it was
 * written: in dev db 0 the whole keyspace was `bull:analytics:meta`, bullmq's signature
 * for a queue that has never received a job (stored state), because the only thing that
 * ever called `aggregateAnalytics` was `GET /api/analytics/:workspaceId?type=daily`,
 * running it inline in a request. An Activity row is the event that changes a day's
 * numbers, so the three routes that write one are the producers.
 *
 * The payload is the day bucket and nothing else, because a colliding add is *dropped*,
 * not merged: measured on db 13, adding the same jobId while the first job still waited
 * left one waiting job and the handler ran once, with the first add's data. Had the
 * payload carried the event's own timestamp, every event after the first would have been
 * rolluping the wrong hour. A bucket says "recompute this day", which is what
 * aggregateAnalytics does — it reads the day's Activities from scratch, so the second,
 * third and tenth call all converge on the same row.
 *
 * Never throws, by decision rather than accident: the Activity row is already committed
 * when this runs, and a 500 here asks the provider to re-deliver, which writes the Activity
 * a second time. `removeOnComplete`/`removeOnFail` are what make the fixed key safe to
 * reuse — measured: with them, the add after a completion re-queued and the day rolled up
 * again; without them the completed job kept the id, every later add was dropped, and the
 * day's row froze at whatever the first event of the day said.
 */
export async function enqueueDailyRollup(enrollmentId: string, occurredAt: Date): Promise<void> {
  try {
    // The campaign's workspace, because that is the key aggregateAnalytics filters and
    // groups on (`enrollment: { campaign: { workspaceId } }`) — not the contact's, which
    // only agrees while no enrollment crosses tenants.
    const enrollment = await prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: { campaign: { select: { workspaceId: true } } },
    });
    const workspaceId = enrollment?.campaign.workspaceId;
    if (!workspaceId) return;
    await enqueueRollup(workspaceId, occurredAt);
  } catch (error) {
    console.warn(`daily rollup not queued for enrollment ${enrollmentId}:`, error instanceof Error ? error.message : error);
  }
}

/** The enqueue, split from the lookup so it can be exercised without a stored enrollment. */
export async function enqueueRollup(workspaceId: string, occurredAt: Date): Promise<void> {
  const bucket = dayBucket(occurredAt);
  await enqueue(queues.analytics, "rollup-day", { workspaceId, date: bucket.toISOString() }, {
    jobId: rollupJobId(workspaceId, bucket),
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/** The window `aggregateAnalytics` reads for a day bucket — `start` inclusive, `end` not. */
function dayWindow(bucket: Date): { start: Date; end: Date } {
  const start = dayBucket(bucket);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

const countDayActivities = (workspaceId: string, window: { start: Date; end: Date }) =>
  prisma.activity.count({
    where: { enrollment: { campaign: { workspaceId } }, createdAt: { gte: window.start, lt: window.end } },
  });

/** How many times one job will re-read a day that keeps growing before it gives up. */
const ROLLUP_MAX_PASSES = 5;

/**
 * Recompute the day until the window stops changing underneath the run.
 *
 * This exists because a fixed jobId coalesces in a state the payload cannot see. Measured
 * over HTTP on scratch db 13 with the real webhook route: twelve `open` events for one
 * workspace-day left `AnalyticsDaily.opened` at 11 while the table held 12, and the
 * `bull:analytics:events` stream said why — `added,waiting,active,duplicated,completed`.
 * The twelfth event's add was dropped because the day's job still existed, but that job
 * had already read the window, so the drop lost an event and nothing was left to recompute
 * it. A dropped add is harmless while the pending job has not read yet (its read will
 * include the new row) and silently wrong after it.
 *
 * So the check is on this side of the read: count the window, run, count again, and if it
 * grew, run again. Bounded, because a workspace under a delivery storm would otherwise
 * hold the worker forever; giving up is a warn, not a throw — the row is short, and the
 * next event of the day recomputes the whole window anyway.
 *
 * Counting rows is a proxy for "did the numbers change". Two Activity rows swapping type
 * while keeping the count equal would slip through; nothing in these routes re-types a
 * committed Activity, so the proxy is good enough for the events that arrive here.
 */
export async function rollupDay(workspaceId: string, bucket: Date): Promise<void> {
  const window = dayWindow(bucket);
  for (let pass = 1; ; pass++) {
    const before = await countDayActivities(workspaceId, window);
    await aggregateAnalytics(workspaceId, bucket);
    const after = await countDayActivities(workspaceId, window);
    if (after === before) return;
    if (pass >= ROLLUP_MAX_PASSES) {
      console.warn(`daily rollup for ${workspaceId} still growing after ${pass} passes; the day is short until the next event`);
      return;
    }
  }
}

export async function aggregateAnalytics(workspaceId: string, date: Date): Promise<DailyAnalytics> {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const activities = await prisma.activity.findMany({
    where: {
      enrollment: { campaign: { workspaceId } },
      createdAt: { gte: start, lt: end },
    },
    select: { type: true, enrollment: { select: { sequence: { select: { channel: true } } } } },
  });

  const byChannel: Record<string, { sent: number; opened: number; clicked: number; replied: number }> = {};
  let sent = 0, delivered = 0, opened = 0, clicked = 0, replied = 0, bounced = 0, unsubscribed = 0;

  for (const a of activities) {
    const channel = a.enrollment.sequence.channel;
    if (!byChannel[channel]) byChannel[channel] = { sent: 0, opened: 0, clicked: 0, replied: 0 };

    switch (a.type) {
      case "SENT": sent++; byChannel[channel].sent++; break;
      case "DELIVERED": delivered++; break;
      case "OPENED": opened++; byChannel[channel].opened++; break;
      case "CLICKED": clicked++; byChannel[channel].clicked++; break;
      case "REPLIED": replied++; byChannel[channel].replied++; break;
      case "BOUNCED": bounced++; break;
      case "UNSUBSCRIBED": unsubscribed++; break;
    }
  }

  const counters = { sent, delivered, opened, clicked, replied, bounced, unsubscribed, byChannel };
  const result: DailyAnalytics = { date: start, ...counters };

  // `date` is not in the update payload. It used to be `update: result`, whose `date` is
  // the caller's argument rather than the bucket, and `@@unique([workspaceId, date])` keys
  // the lookup on the bucket: measured against a copy of dev.db, the first rollup of a day
  // stored `00:00`, the second moved that same row to `14:00`, and a third — looking for
  // `00:00` again, no longer finding it — created a second row for the same day. So a
  // multi-event day double-counts, and a producer that fires per event makes
  // multi-event days the normal case.
  await prisma.analyticsDaily.upsert({
    where: { workspaceId_date: { workspaceId, date: start } },
    create: { workspaceId, date: start, ...counters },
    update: counters,
  });

  return result;
}

/**
 * Read one workspace-day from the materialized table, for the analytics GET.
 *
 * This is the reader `AnalyticsDaily` never had (#59). The row already exists — the
 * webhook producers enqueue a rollup and the `analytics` Worker runs `aggregateAnalytics`,
 * which upserts it — but the only thing that had ever surfaced a day's numbers was the GET
 * itself calling `aggregateAnalytics`, which recomputes from the raw Activity rows and, in
 * doing so, writes the very row it is reading (#58: a GET with a write side effect). A
 * dashboard read should not race the rollup Worker for the same `@@unique([workspaceId,
 * date])` row, and re-deriving a day on every page load is what the rollup exists to avoid.
 *
 * So the GET reads this and nothing else writes on the read path. `dayBucket` is the same
 * normalization `aggregateAnalytics` stores under (`date: start`, local midnight), so the
 * `findUnique` on the composite key hits the row the Worker wrote rather than looking for a
 * timestamp the caller happened to pass.
 *
 * A day with no row yet returns zeros rather than a 404 or a null. `aggregateAnalytics`
 * would have produced exactly these counters for a window holding no Activity, so the read
 * path returns what the write path would have written, and a caller never has to branch on
 * "has this day rolled up yet". That is a choice, not a measurement — the alternative
 * (surface "not computed yet") assumes the caller can tell a quiet day from an un-rolled-up
 * one, which nothing in the app does today.
 */
export async function getDailyAnalytics(workspaceId: string, date: Date): Promise<DailyAnalytics> {
  const bucket = dayBucket(date);
  const row = await prisma.analyticsDaily.findUnique({
    where: { workspaceId_date: { workspaceId, date: bucket } },
  });

  if (!row) {
    return { date: bucket, sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, unsubscribed: 0, byChannel: {} };
  }

  return {
    date: row.date,
    sent: row.sent,
    delivered: row.delivered,
    opened: row.opened,
    clicked: row.clicked,
    replied: row.replied,
    bounced: row.bounced,
    unsubscribed: row.unsubscribed,
    byChannel: (row.byChannel as DailyAnalytics["byChannel"]) ?? {},
  };
}

export async function getCampaignAnalytics(campaignId: string, startDate: Date, endDate: Date) {
  const enrollments = await prisma.enrollment.findMany({
    where: { campaignId, enrolledAt: { gte: startDate, lte: endDate } },
    include: { activities: true, contact: true },
  });

  const total = enrollments.length;
  const replied = enrollments.filter(e => e.status === "REPLIED").length;
  const bounced = enrollments.filter(e => e.status === "BOUNCED").length;
  const unsubscribed = enrollments.filter(e => e.status === "UNSUBSCRIBED").length;

  const activities = await prisma.activity.findMany({
    where: { enrollment: { campaignId }, createdAt: { gte: startDate, lte: endDate } },
  });

  const sent = activities.filter(a => a.type === "SENT").length;
  const opened = activities.filter(a => a.type === "OPENED").length;
  const clicked = activities.filter(a => a.type === "CLICKED").length;

  return {
    totalEnrolled: total,
    sent,
    openRate: sent > 0 ? opened / sent : 0,
    clickRate: sent > 0 ? clicked / sent : 0,
    replyRate: total > 0 ? replied / total : 0,
    bounceRate: sent > 0 ? bounced / sent : 0,
    unsubscribeRate: total > 0 ? unsubscribed / total : 0,
  };
}

export async function getSequenceAnalytics(sequenceId: string) {
  const steps = await prisma.sequenceStep.findMany({ where: { sequenceId }, orderBy: { stepNumber: "asc" } });
  const enrollments = await prisma.enrollment.findMany({ where: { sequenceId }, include: { activities: true } });

  return steps.map(step => {
    const stepEnrollments = enrollments.filter(e => e.currentStep > step.stepNumber || (e.currentStep === step.stepNumber && e.status === "COMPLETED"));
    const sent = stepEnrollments.length;
    const replies = stepEnrollments.filter(e => e.activities.some(a => a.type === "REPLIED")).length;
    return { step: step.stepNumber, channel: step.channel, sent, replies, replyRate: sent > 0 ? replies / sent : 0 };
  });
}

export async function getWorkspaceOverview(workspaceId: string, days: number = 30) {
  const start = new Date();
  start.setDate(start.getDate() - days);

  const [totalContacts, activeCampaigns, totalSent, totalReplied] = await Promise.all([
    prisma.contact.count({ where: { workspaceId, status: "ACTIVE" } }),
    prisma.campaign.count({ where: { workspaceId, status: "ACTIVE" } }),
    prisma.sentMessage.count({ where: { sendingAccount: { workspaceId }, createdAt: { gte: start } } }),
    prisma.activity.count({ where: { enrollment: { campaign: { workspaceId } }, type: "REPLIED", createdAt: { gte: start } } }),
  ]);

  return { totalContacts, activeCampaigns, totalSent, totalReplied, replyRate: totalSent > 0 ? totalReplied / totalSent : 0 };
}