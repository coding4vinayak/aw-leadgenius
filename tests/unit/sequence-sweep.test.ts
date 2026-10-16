// #115 — the sequence cadence, tested as the two comparisons it is.
//
// `stepIsDue` and `sequenceDueWhere` are pure, so the wait gets real dates and
// real clauses rather than a reading of the source. Everything below them needs a
// database and a Redis, so what is checked there is shape: that the engine asks
// the schedule at all, that one clock answers both halves, that the sweep survives
// one tenant's misconfiguration, and that the queue this all rides on is actually
// registered by a boot. The hole this closes was found by grep — `TIME_ELAPSED`
// appears in the trigger union and nowhere else in `src/` — so the last group is
// the same grep, kept as a test.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sequenceDueWhere, runDueSequenceSteps, SEQUENCE_SWEEP_BATCH } from "../../src/lib/scheduler";
import { stepIsDue } from "../../src/lib/sequence-engine";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const engine = source("../../src/lib/sequence-engine.ts");
const queue = source("../../src/lib/queue.ts");
const sweep = source("../../src/lib/scheduler.ts");
const helper = source("../../src/lib/queue-sweep.ts");

describe("stepIsDue", () => {
  const now = new Date("2026-10-13T12:00:00.000Z");

  it("is due when nothing is scheduled, because a new enrollment's first step is not a wait", () => {
    // The alternative would hold the first cold email of every sequence until a
    // `nextActionAt` that nobody ever wrote.
    assert.equal(stepIsDue(null, now), true);
  });

  it("is due at the exact tick, because waits are minute-aligned and must not slip", () => {
    assert.equal(stepIsDue(new Date("2026-10-13T12:00:00.000Z"), now), true);
  });

  it("is not due a millisecond early", () => {
    assert.equal(stepIsDue(new Date("2026-10-13T12:00:00.001Z"), now), false);
  });

  it("is due whenever the wait has passed, by the instant and not by the object", () => {
    assert.equal(stepIsDue(new Date("2026-10-10T09:00:00.000Z"), now), true);
    assert.equal(stepIsDue(now, now), true, "the sweep passes its own clock down");
  });

  it("is due when the row moved backwards, so a reschedule to the past takes effect at once", () => {
    // PATCH /api/enrollments/:id takes `nextActionAt` as its only writable field:
    // a buyer using it to move a follow-up earlier is the point of the column.
    assert.equal(stepIsDue(new Date("2026-01-01T00:00:00.000Z"), now), true);
  });
});

describe("sequenceDueWhere", () => {
  const now = new Date("2026-10-13T12:00:00.000Z");

  it("is one clause: active, scheduled, and the wait ended", () => {
    assert.deepEqual(sequenceDueWhere(now), {
      status: "ACTIVE",
      nextActionAt: { not: null, lte: now },
    });
  });

  it("leaves the pause alone, which is the one thing a buyer is entitled to do mid-flight", () => {
    // Strict equality is the assertion: a `{ in: [...] }` that also admits PAUSED
    // would fail it, and a sweep that spends a paused row hands it to an engine
    // that declines it while leaving `nextActionAt` in the past — re-read and
    // re-declined once a minute for as long as the pause lasts.
    assert.equal(sequenceDueWhere(now).status, "ACTIVE");
  });

  it("asks for the caller's instant, not a clock of its own", () => {
    const clause = sequenceDueWhere(now);
    assert.equal((clause.nextActionAt as { lte: Date }).lte.getTime(), now.getTime());
    assert.equal((clause.nextActionAt as { lte: Date }).lte, now, "same instant, so the engine's own check cannot disagree");
  });

  it("names an unscheduled row out of the scan, so a null wait is not a due one", () => {
    assert.equal((sequenceDueWhere(now).nextActionAt as { not: unknown }).not, null);
  });
});

describe("the engine asks the schedule before it spends a step", () => {
  it("has the wait checked for a step with no condition of its own", () => {
    // The bug is not that conditional follow-ups never fired. It is that an
    // unconditional step was spent by the `SENT` job the moment the previous send
    // landed, so `delayDays: 3` meant three seconds.
    assert.match(
      engine,
      /if \(!step\.conditions\) \{\s*return stepIsDue\(enrollment\.nextActionAt, now\);/,
    );
  });

  it("carries the due check into the signature, so one instant answers both halves", () => {
    assert.match(engine, /triggerType: SequenceTrigger,\s*now: Date = new Date\(\),/);
    assert.match(engine, /evaluateStepConditions\(enrollment, currentStep, triggerType, now\)/);
  });

  it("defines the predicate once, in the engine, and the sweep imports nothing else", () => {
    assert.match(engine, /export function stepIsDue\(nextActionAt: Date \| null, now: Date\): boolean/);
    assert.doesNotMatch(sweep, /function stepIsDue/, "two copies of a due-check is two answers to one question");
  });

  it("still lets an event trigger do what an event trigger is for", () => {
    // A reply must branch now, not on the calendar. Blocking every non-TIME_ELAPSED
    // trigger would have traded one broken half of the engine for the other.
    const conditions = /async function evaluateStepConditions[\s\S]*?\n\}/.exec(engine);
    assert.ok(conditions);
    assert.doesNotMatch(conditions[0], /if \(triggerType !== "TIME_ELAPSED"\) return/);
    assert.match(conditions[0], /case "replied":\s*return triggerType === "REPLIED"/);
  });
});

describe("the sweep", () => {
  it("is called TIME_ELAPSED, which is the value that had no producer", () => {
    assert.match(sweep, /processSequenceStep\(enrollment\.id, "TIME_ELAPSED", now\)/);
  });

  it("hands one instant to the scan and to the engine", () => {
    assert.match(sweep, /where: sequenceDueWhere\(now\)/);
    assert.match(sweep, /now: Date = new Date\(\)/);
  });

  it("survives one tenant having no sending account, per row rather than per pass", () => {
    const loop = /for \(const enrollment of due\) \{([\s\S]*?)\n  \}/.exec(sweep);
    assert.ok(loop, "the sweep is a loop over rows");
    assert.match(loop[1], /try \{/);
    assert.match(loop[1], /catch \(error\)/);
    assert.match(loop[1], /console\.error\(`\[sequence\] due enrollment \$\{enrollment\.id\}/);
    assert.doesNotMatch(loop[1], /throw/, "a rethrow here is one workspace holding every other tenant's cadence hostage");
  });

  it("reads oldest first and stops at a bound, so a backlog drains instead of blocking a tick", () => {
    assert.match(sweep, /orderBy: \{ nextActionAt: "asc" \}/);
    assert.match(sweep, /take: number = SEQUENCE_SWEEP_BATCH/);
    assert.equal(SEQUENCE_SWEEP_BATCH, 100);
  });

  it("selects ids only — a whole enrolled row per due contact is not what the step needs from here", () => {
    assert.match(sweep, /select: \{ id: true \}/);
  });

  it("is a function that can be called: the export the worker's handler uses", () => {
    assert.equal(typeof runDueSequenceSteps, "function");
  });
});

describe("the cadence has a producer, and the boot registers it", () => {
  it("names the new queue with the product in front, unlike the six bare ones it cannot rename", () => {
    assert.equal((queue.match(/"leadgenius-scheduled"/g) ?? []).length, 2, "Queue and Worker, the convention check-queues reads");
    assert.doesNotMatch(queue, /new Queue\("scheduled"/);
  });

  it("rides a fixed scheduler key, so N boots leave one schedule rather than N", () => {
    assert.match(queue, /export const SCHEDULED_SWEEP_KEY = "leadgenius-scheduled-sweep";/);
    assert.match(queue, /export const SCHEDULED_SWEEP_NAME = "run-scheduled";/);
    assert.match(queue, /export const SCHEDULED_SWEEP_PATTERN = "\* \* \* \* \*";/);
    assert.match(
      queue,
      /upsertJobScheduler\(\s*SCHEDULED_SWEEP_KEY,\s*\{ pattern: SCHEDULED_SWEEP_PATTERN \},\s*\{ name: SCHEDULED_SWEEP_NAME, data: \{\} \},/,
    );
  });

  it("dispatches the handler by job name rather than assuming it", () => {
    assert.match(queue, /if \(job\.name !== SCHEDULED_SWEEP_NAME\) throw new Error\(/);
    assert.match(queue, /const processed = await runDueSequenceSteps\(\);/);
  });

  it("runs the scan serially, so two ticks cannot spend the same due row", () => {
    const scheduledWorker = /new Worker\("leadgenius-scheduled",[\s\S]*?\{ connection, concurrency: 1 \}\)/.exec(queue);
    assert.ok(scheduledWorker, "the sweep worker exists and its concurrency is written");
  });

  it("registers last, and bounds the wait", () => {
    const register = queue.indexOf("awaitWithRegistrationTimeout(registerScheduledSweep()");
    const lastWorker = queue.lastIndexOf("workers.push(new Worker(");
    const started = queue.indexOf('console.log("LeadGenius workers started")');
    assert.ok(register > lastWorker, "a schedule this process could not add is not eight workers that failed to start");
    assert.ok(register < started, "and the boot still reaches its started line");
    assert.match(queue, /if \(sweep === "failed"\)/);
    assert.match(queue, /else if \(sweep === "timed-out"\)/);
  });

  it("vendors the helper rather than copying its shape twice", () => {
    assert.match(queue, /import \{ awaitWithRegistrationTimeout, SWEEP_REGISTER_TIMEOUT_MS \} from "\.\/queue-sweep";/);
    assert.match(helper, /export const SWEEP_REGISTER_TIMEOUT_MS = 5_000;/);
    assert.match(helper, /export async function awaitWithRegistrationTimeout/);
    assert.match(helper, /work\.then\(\(\) => "registered" as const, \(\) => "failed" as const\)/);
    assert.match(queue, /export \{[^}]*awaitWithRegistrationTimeout[^}]*\} from "\.\/queue-sweep";/);
  });
});

describe("the grep that found this, kept", () => {
  it("has a producer for TIME_ELAPSED inside src/, not only a value in a union", () => {
    const producers = [engine, sweep, queue].filter((text) => text.includes('"TIME_ELAPSED"'));
    assert.ok(producers.includes(sweep), "the sweep is the producer");
    assert.match(sweep, /"TIME_ELAPSED"/);
  });

  it("still indexes the column the scan runs on — the index is the evidence the design wanted this reader", () => {
    const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
    assert.match(schema, /@@index\(\[nextActionAt\]\)/);
  });
});

describe("the account a step sends through belongs to the enrollment's workspace", () => {
  it("passes the campaign's workspace, the only copy the row carries", () => {
    // `Enrollment` has no `workspaceId` column; the workspace lives on the
    // campaign the fetch already includes. The engine read
    // `enrollment.workspaceId` under an `any`-typed parameter — compiled, and
    // `undefined` at runtime — and Prisma reads an undefined filter as no
    // filter, so `selectSendingAccount` searched every workspace's accounts by
    // reputation. A tenant with none eligible could send through another
    // tenant's — the wrong email from the wrong domain, on someone else's
    // sender reputation.
    assert.match(engine, /selectSendingAccount\(enrollment\.campaign\.workspaceId, step\.channel\)/);
    assert.doesNotMatch(engine, /enrollment\.workspaceId/);
  });

  it("types the enrollment so the wrong field cannot compile back in", () => {
    // The `any` was the bug's enabler: it is what made a column that does not
    // exist read as a value instead of a type error.
    assert.match(engine, /async function executeStep\(enrollment: StepEnrollment,/);
    assert.match(engine, /type StepEnrollment = \{[\s\S]*?campaign: \{ workspaceId: string \};[\s\S]*?\};/);
  });
});
