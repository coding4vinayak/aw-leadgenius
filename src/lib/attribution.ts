import { prisma } from "./db";
import { dayBucket } from "./analytics";

export interface AttributionRow {
  key: string;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
}

export interface AttributionDrift {
  counter: "sent" | "delivered" | "opened" | "clicked" | "replied" | "bounced";
  activities: number;
  rollup: number;
}

export interface Attribution {
  start: string;
  end: string;
  totals: AttributionRow;
  byChannel: AttributionRow[];
  byVariant: AttributionRow[];
  /**
   * The same window measured by the materialized `AnalyticsDaily` rollup. The
   * attribution reads raw Activity rows; the rollup is what the daily charts
   * show. They agree by construction — until a rollup job is missing or short
   * (the queue outage path in #65) — so the difference is reported rather than
   * hidden: a nonzero drift row means "the engine's day and the engine's source
   * disagree; go look".
   */
  drift: AttributionDrift[];
}

const COUNTERS = ["sent", "delivered", "opened", "clicked", "replied", "bounced"] as const;

function emptyRow(key: string): AttributionRow {
  return { key, sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0 };
}

type Counters = Pick<AttributionRow, "sent" | "delivered" | "opened" | "clicked" | "replied" | "bounced">;

/** Pure: every counter where the raw-activity fold and the rollup disagree. */
export function diffCounters(activities: Counters, rollup: Counters): AttributionDrift[] {
  const drift: AttributionDrift[] = [];
  for (const counter of COUNTERS) {
    if (activities[counter] !== rollup[counter]) drift.push({ counter, activities: activities[counter], rollup: rollup[counter] });
  }
  return drift;
}

/**
 * Pure reducer: fold Activity rows into per-key totals. Exported for the unit
 * tests and because the grouping must be identical no matter who feeds it.
 * The counter set mirrors `aggregateAnalytics`'s switch — the counters a day
 * rollups on are the counters the attribution reports, or the two views of one
 * workspace would not be the same workspace.
 */
export function foldAttribution<T extends { type: string; channel?: string; variant?: string | null }>(
  rows: T[],
  keyOf: (row: T) => string,
): AttributionRow[] {
  const acc = new Map<string, AttributionRow>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!acc.has(key)) acc.set(key, emptyRow(key));
    const bucket = acc.get(key)!;
    // Activity.type is the provider's uppercase event name ("SENT", "REPLIED") —
    // the same strings `aggregateAnalytics`'s switch matches on. The counter set
    // is its lowercase mirror, so the fold keys on the lowered name and ignores
    // everything the funnel does not count (FAILED, UNSUBSCRIBED, …).
    const counter = row.type.toLowerCase() as (typeof COUNTERS)[number];
    if ((COUNTERS as readonly string[]).includes(counter)) bucket[counter]++;
  }
  return [...acc.values()].sort((a, b) => b.replied - a.replied || b.sent - a.sent || a.key.localeCompare(b.key));
}

/**
 * Attribution for one workspace over `start` (inclusive) to `end` (exclusive).
 *
 * Both ends snap to local midnight — the same bucketing the rollup stores
 * under. A partial day cannot be compared honestly: the Activity side would
 * count until the requested hour while the rollup side holds the whole day's
 * row, and the drift block would report a difference that is a window
 * artifact, not a missing rollup.
 *
 * Channel comes from the Activity row's own `channel` — the provider event
 * names it — not from `sequence.channel` the way the daily rollup groups
 * `byChannel`: a MULTI sequence sends email and WhatsApp, and "which channel
 * got the reply" is exactly the question a MULTI sequence makes useless if you
 * group by the sequence. Totals are unaffected either way, which is what makes
 * the drift comparison meaningful across the two groupings.
 */
export async function getAttribution(workspaceId: string, start: Date, end: Date): Promise<Attribution> {
  const from = dayBucket(start);
  const to = dayBucket(end);
  const [activities, rollupRows] = await Promise.all([
    prisma.activity.findMany({
      where: { enrollment: { campaign: { workspaceId } }, createdAt: { gte: from, lt: to } },
      select: {
        type: true,
        channel: true,
        enrollment: { select: { abVariant: { select: { name: true } } } },
      },
    }),
    prisma.analyticsDaily.findMany({
      where: { workspaceId, date: { gte: from, lt: to } },
      select: { sent: true, delivered: true, opened: true, clicked: true, replied: true, bounced: true },
    }),
  ]);

  const typed = activities.map((a) => ({
    type: a.type,
    channel: a.channel,
    variant: a.enrollment.abVariant?.name ?? null,
  }));

  const totals = foldAttribution(typed, () => "total")[0] ?? emptyRow("total");
  const byChannel = foldAttribution(typed, (r) => r.channel ?? "UNKNOWN");
  const byVariant = foldAttribution(
    typed.filter((r) => r.variant !== null),
    (r) => r.variant!,
  );

  const rollup = { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0 };
  for (const row of rollupRows) for (const k of COUNTERS) rollup[k] += row[k];

  return { start: from.toISOString(), end: to.toISOString(), totals, byChannel, byVariant, drift: diffCounters(totals, rollup) };
}

/** Reply rate for one row — sent is the denominator because a channel that never sent cannot reply. */
export function replyRate(row: AttributionRow): number {
  return row.sent > 0 ? row.replied / row.sent : 0;
}
