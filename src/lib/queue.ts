import { Queue, Worker, Job } from "bullmq";
import IORedis from "ioredis";
// Type-only, so it does not close a cycle at runtime: `billing-jobs` imports this
// module's queue, and the worker below needs the job shape it carries.
import type { TrialNudgeData } from "./billing-jobs";
import { prisma } from "./db";

const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  // Fail fast when Redis is down: without this, commands buffer forever and
  // every request that enqueues hangs instead of answering 503.
  enableOfflineQueue: false,
});

/** Thrown when a job cannot be enqueued because Redis is unreachable. */
export class QueueUnavailableError extends Error {
  readonly status = 503;
  constructor() {
    super("job queue unavailable — Redis is unreachable; the work is saved, retry shortly");
  }
}

const CONNECTION_FAILURE = /connection is closed|connection is not open|connect econnrefused|connect etimedout|stream disconnected|loading/i;

/**
 * queues.X.add that throws QueueUnavailableError (instead of hanging or
 * leaking driver errors) when Redis is down. Genuine job errors propagate
 * untouched. API routes translate QueueUnavailableError to 503.
 */
export async function enqueue<T extends object>(
  queue: Queue,
  name: string,
  data: T,
  opts?: Parameters<Queue["add"]>[2],
): Promise<Job> {
  try {
    return await queue.add(name, data, opts);
  } catch (error) {
    if (error instanceof Error && CONNECTION_FAILURE.test(error.message)) throw new QueueUnavailableError();
    throw error;
  }
}

/**
 * Built on first touch, not at import, because `new Queue()` is not inert. Handed a
 * lazy-connect client it opens that connection on the next tick and writes
 * `bull:<name>:meta` before anything calls `add()`. Measured against this app before the
 * change (HEAD's module copied to a scratch file and imported with `REDIS_URL` on db 13):
 * the process never exited — rc=124 at 30s — and six keys were waiting in the scratch
 * db, one `:meta` per queue. Dev `REDIS_URL` defaults to db 0, so importing this module
 * from a unit test wrote live dev state, which is why no queue test could be written
 * here at all (§8.26.7, and §8.27 for the two apps that made this change first).
 *
 * The names are unchanged: `bull:send:*` etc. already hold jobs, and renaming would
 * orphan them — that is a stored-state decision (#51), not a side effect of a shutdown
 * fix. Rule 6 of `shared/check-queues.sh` asks for a product prefix and is scoped to the
 * two apps that were renamed for a collision, for the same reason.
 *
 * Three of the six keyspaces held nothing but `:meta` in dev db 0 before this round —
 * `bull:enrichment:meta`, `bull:analytics:meta`, `bull:warmup:meta` — which is the stored
 * signature of a queue that has never received a job. `enrichment` and `analytics` had a
 * Worker and no add site anywhere in `src/`; both have one now (`POST /api/contacts`, and
 * the three webhook routes that write an Activity). `warmup` has had an add site since
 * #50 — `scheduleWarmup`, reached from `POST /api/sending-accounts/:id?action=schedule-warmup`
 * — and stayed empty because the dev db has zero SendingAccount rows, so there is no
 * account to name. That one is a data limit, not a missing producer; the repeat idiom it
 * uses has its own finding in #57.
 *
 * Each name is written twice, in the Queue and in its Worker. `shared/check-queues.sh`
 * rules 4 and 5 assert both directions per app — a Worker on a name no Queue enqueues
 * to, and a Queue with no Worker draining it — so the agreement is guarded where the
 * literal appears rather than by a constant indirection the guard would have to resolve.
 */
type QueueKey = "send" | "sequence" | "enrichment" | "webhook" | "analytics" | "warmup" | "billing";

const built: Partial<Record<QueueKey, Queue>> = {};

/** Every Worker this process started, so shutdownWorkers() can actually close them. */
const workers: Worker[] = [];

/**
 * Retention applied to every job a queue creates: plain adds, the warmup scheduler's
 * daily ticks, and anything added directly to a `queues.X`. bullmq merges
 * `{ ...defaultJobOptions, ...opts }` per add (queue.js:199,236,266), so an add that
 * names its own retention still wins — this only bounds the five of six queues that
 * named none before this change (analytics overrides it, deliberately, on rollupDay).
 *
 * The leak: a bare `add` — and each scheduler tick — writes a job hash that stays in
 * `bull:<name>:completed` forever. Measured on scratch db 13 (§8.33): three adds kept
 * three; `removeOnComplete: true` kept zero; `removeOnComplete: 2` of five kept two.
 * Nothing in `src/` reads `:completed` back — the only consumer of queue state is
 * `/api/health`, and it asks for `waiting`/`active`/`failed` counts, never completed —
 * so a kept completed job is pure growth with no reader. The work's real record is
 * SQLite, not the queue.
 *
 * Failed jobs are kept on purpose, bounded: a sequence/enrichment/webhook failure
 * writes no error row anywhere else, and the job hash is the only place its payload and
 * stack survive. `removeOnFail: 100` keeps the most recent hundred per queue — chosen
 * as a bound that survives a failure storm without growing without end, not a tuned
 * optimum. It makes the `failed` number `/api/health` reports "recent failures" rather
 * than cumulative, which is the more useful signal anyway.
 */
import { JOB_RETENTION } from "./queue-retention";

export const queues = {
  get send(): Queue {
    return (built.send ??= new Queue("send", { connection, defaultJobOptions: JOB_RETENTION }));
  },
  get sequence(): Queue {
    return (built.sequence ??= new Queue("sequence", { connection, defaultJobOptions: JOB_RETENTION }));
  },
  get enrichment(): Queue {
    return (built.enrichment ??= new Queue("enrichment", { connection, defaultJobOptions: JOB_RETENTION }));
  },
  get webhook(): Queue {
    return (built.webhook ??= new Queue("webhook", { connection, defaultJobOptions: JOB_RETENTION }));
  },
  get analytics(): Queue {
    return (built.analytics ??= new Queue("analytics", { connection, defaultJobOptions: JOB_RETENTION }));
  },
  get warmup(): Queue {
    return (built.warmup ??= new Queue("warmup", { connection, defaultJobOptions: JOB_RETENTION }));
  },
  /**
   * Trial-expiry warnings. Prefixed with the product where the six names above are
   * bare, and deliberately so: those are bare because renaming them would orphan
   * keyspaces that already hold jobs — a #51 decision. A queue created today has no
   * such history, so it starts on the safe side of rule 6: one Redis serves this
   * whole portfolio, and a queue name is its only boundary.
   */
  get billing(): Queue {
    return (built.billing ??= new Queue("leadgenius-billing", { connection, defaultJobOptions: JOB_RETENTION }));
  },
};

export async function startWorkers() {
  const { sendEmail } = await import("./channels/email");
  const { sendWhatsApp } = await import("./channels/whatsapp");
  const { sendLinkedIn } = await import("./channels/linkedin");
  const { processSequenceStep } = await import("./sequence-engine");
  const { enrichContact } = await import("./enrichment");
  const { deliverWebhook } = await import("./webhooks");
  const { rollupDay } = await import("./analytics");
  const { runWarmup } = await import("./warmup");
  const { runTrialNudge } = await import("./billing-jobs");

  workers.push(new Worker("send", async (job: Job) => {
    const { messageId } = job.data;
    const msg = await prisma.sentMessage.findUnique({ where: { id: messageId } });
    if (!msg) throw new Error(`Message ${messageId} not found`);

    // Convert Prisma message to send function input
    const sendMsg = {
      id: msg.id,
      subject: msg.subject ?? undefined,
      body: msg.body,
      sendingAccountId: msg.sendingAccountId,
      contactId: msg.contactId,
    };

    let result;
    switch (msg.channel) {
      case "EMAIL":
        result = await sendEmail(sendMsg);
        break;
      case "WHATSAPP":
        result = await sendWhatsApp(sendMsg);
        break;
      case "LINKEDIN":
        result = await sendLinkedIn(sendMsg);
        break;
      default:
        throw new Error(`Unknown channel: ${msg.channel}`);
    }

    await prisma.sentMessage.update({
      where: { id: messageId },
      data: {
        status: result.success ? "SENT" : "FAILED",
        providerMessageId: result.providerId,
        error: result.error,
        sentAt: result.success ? new Date() : null,
      },
    });

    if (result.success && msg.enrollmentId) {
      await enqueue(queues.sequence, "process-step", { enrollmentId: msg.enrollmentId, activityType: "SENT" });
    }
  }, { connection, concurrency: 10 }));

  workers.push(new Worker("sequence", async (job: Job) => {
    const { enrollmentId, activityType } = job.data;
    await processSequenceStep(enrollmentId, activityType);
  }, { connection, concurrency: 5 }));

  workers.push(new Worker("enrichment", async (job: Job) => {
    const { contactId } = job.data;
    await enrichContact(contactId);
  }, { connection, concurrency: 3 }));

  workers.push(new Worker("webhook", async (job: Job) => {
    const { webhookId, payload } = job.data;
    await deliverWebhook(webhookId, payload);
  }, { connection, concurrency: 10 }));

  workers.push(new Worker("analytics", async (job: Job) => {
    // `new Date` is what the JSON round trip through Redis requires: `date` comes back as
    // the ISO string the producer wrote. This is not the row's correctness — the
    // function's own `new Date(date)` already re-accepted a string — it is the declared
    // type: `DailyAnalytics.date` says Date, and until this line this Worker was the only
    // caller feeding it anything else (the other is the GET, which passes a Date).
    //
    // `rollupDay`, not `aggregateAnalytics`: the day's job has to re-check its own window,
    // because a same-day add that arrives while this job is running is dropped by the fixed
    // jobId after the read has happened. Why, and what it measured, is on rollupDay.
    const { workspaceId, date } = job.data;
    await rollupDay(workspaceId, new Date(date));
  }, { connection, concurrency: 2 }));

  workers.push(new Worker("warmup", async (job: Job) => {
    const { accountId } = job.data;
    await runWarmup(accountId);
  }, { connection, concurrency: 1 }));

  // One email to one owner per job, so the transport is the slow part and there
  // is nothing to gain from running two at once.
  workers.push(new Worker("leadgenius-billing", async (job: Job) => {
    await runTrialNudge(job as Job<TrialNudgeData>);
  }, { connection, concurrency: 1 }));

  console.log("LeadGenius workers started");
}

/**
 * Ceiling on how long shutdown waits for in-flight Redis setup to land before tearing
 * the queue down anyway. Two seconds because the only case that waits the full two is a
 * Redis that answers nothing, and that one is already measured clean without a wait.
 */
const SHUTDOWN_SETTLE_MS = 2_000;

/**
 * Graceful shutdown: settle, then Workers, then Queues, then the shared client.
 *
 * The previous body closed the queues and called `connection.quit()`, and each part of
 * that is a crash. All three were measured on the two apps that made this change first
 * (§8.27); the mechanism is the same bullmq 5.81.5 with the same shared-client shape, so
 * they are recorded here as the port's reason rather than re-derived per app.
 *
 * (1) `quit()` on a client that never connected throws `Stream isn't writeable and
 *     enableOfflineQueue options is false` — the app sets `enableOfflineQueue: false`
 *     deliberately, so a down Redis fails fast instead of buffering. `disconnect()`
 *     closes what exists and is a no-op otherwise.
 * (2) Closing the client while a Queue's connect is in flight is an *exit*, not a throw.
 *     bullmq attaches `initializing.catch(err => this.emit('error', err))` to that
 *     connect (`redis-connection.js:87`) and suppresses the rejection only inside
 *     `close()`'s `if (!this.extraOptions.shared)` branch (`redis-connection.js:429`),
 *     which is never taken when the app hands bullmq a *shared* client — as this file
 *     does, six times over. Measured rc=1 for a queue touched and closed in the same
 *     tick, rc=0 once the connection had reached `ready`.
 * (3) A Worker is not ready when the client is: its own setup issues commands after the
 *     shared connect lands, so settling only the client still died with a Worker
 *     `select` on a disconnected client (`event_handler.js:41`, measured rc=1). Hence
 *     readiness is awaited on every started object.
 * (4) `waitUntilReady()` must be caught as it is created. Abandoning one that never
 *     lands — the dead-Redis case — is itself an unhandled rejection at ioredis
 *     `Redis.js:220`, which exits 1 like the crash this function exists to avoid.
 *
 * Workers were unreachable before: `startWorkers()` kept none of them, so there was no
 * reference to close — and a live Worker polls (`bzpopmin bull:<name>:marker` is what
 * `redis-cli MONITOR` shows it doing), which is the opposite of a drain.
 *
 * Idempotent — `built` and `workers` are emptied as they close, so a second call has
 * nothing left to close and cannot double-disconnect.
 */
export async function shutdownWorkers() {
  const closingWorkers = workers.splice(0);
  const closingQueues = Object.values(built);
  for (const key of Object.keys(built) as QueueKey[]) delete built[key];

  await Promise.race([
    Promise.all([...closingQueues, ...closingWorkers].map((item) => item.waitUntilReady().catch(() => undefined))),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_SETTLE_MS)),
  ]);

  await Promise.all(closingWorkers.map((worker) => worker.close()));
  await Promise.all(closingQueues.map((queue) => queue.close()));
  connection.disconnect();
}
