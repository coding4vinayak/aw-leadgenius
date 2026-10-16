// #52, held in place: importing `src/lib/queue.ts` used to connect to Redis.
//
// `new Queue(name, {connection})` is not inert even when the client is
// `lazyConnect: true`. Measured in *this* app on the module as it was before the change
// (checked out of HEAD into a scratch file inside src/lib, imported with REDIS_URL on
// db 13): the process never exited — rc=124 at the 30s timeout — and db 13 held six
// keys, `bull:send:meta` … `bull:warmup:meta`, one per queue, written by nothing but the
// import. Dev `REDIS_URL` defaults to db 0, so importing this module from a unit test
// wrote live dev state, which is why this file could not exist until the Queues moved
// behind getters (§8.26.7 for the four rc=124 import variants; §8.27 for abetflow and
// abetagent, where the three teardown crashes were measured).
//
// Two kinds of assertion, labelled as such:
//   source  — scanned from the module text, offline, always runs
//   probe   — runs only when QUEUE_PROBE_URL names a Redis db explicitly, refuses to
//             run against db 0, and checks where the connection actually landed. The
//             destination is asserted, not assumed: abetflow's copy of this file assigned
//             `process.env.REDIS_URL` inside the probe test, which runs after the
//             runtime-touch test has already imported the module, so the shared client
//             had long been built from the unset default — MONITOR caught that "scratch"
//             probe writing `bull:abetflow-runs:meta` into db 0 while db 13 stayed empty.
//             A guard that inspects the URL string instead of the connection is §8.20's
//             defect again, so the assignment is hoisted above every import and the db
//             the client reports is asserted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const queueModule = source("../../src/lib/queue.ts");
const retentionModule = source("../../src/lib/queue-retention.ts");
const instrumentation = source("../../instrumentation.ts");
const analyticsModule = source("../../src/lib/analytics.ts");
const enrichmentModule = source("../../src/lib/enrichment.ts");
const warmupModule = source("../../src/lib/warmup.ts");
const contactsRoute = source("../../src/app/api/contacts/route.ts");
const analyticsRoute = source("../../src/app/api/analytics/[workspaceId]/route.ts");
const activityRoutes: Record<string, string> = {
  "webhooks/email": source("../../src/app/api/webhooks/email/route.ts"),
  "webhooks/whatsapp": source("../../src/app/api/webhooks/whatsapp/route.ts"),
  "webhooks/linkedin": source("../../src/app/api/webhooks/linkedin/route.ts"),
};

/**
 * Read as key/name pairs rather than one list, because the two are not the same
 * string any more: `billing` is the object key and `leadgenius-billing` is the
 * Redis keyspace. A queue name is the only boundary between the products sharing
 * this Redis, so the newest queue is prefixed; the bare names stay bare because
 * renaming them would orphan keyspaces that already hold jobs — a #51 decision,
 * not an oversight. A queue built without the retention default drops out of this
 * parse, and the union comparison below is what catches that.
 */
const declared = [...queueModule.matchAll(/built\.(\w+) \?\?= new Queue\("([^"]+)", \{ connection, defaultJobOptions: JOB_RETENTION \}\)/g)]
  .map((m) => ({ key: m[1], name: m[2] }));
const KEYS = declared.map((entry) => entry.key);
const NAMES = declared.map((entry) => entry.name);

const probeUrl = process.env.QUEUE_PROBE_URL;
const probeNamesLiveDb = /\/0$/.test(probeUrl ?? "");
// Must happen before anything imports the queue module: `connection` is built from
// REDIS_URL at import time, so assigning it later changes nothing.
if (probeUrl && !probeNamesLiveDb) process.env.REDIS_URL = probeUrl;

// --- name shape ------------------------------------------------------------
// The names are bare (`send`, `warmup`, …). Rule 6 of shared/check-queues.sh asks for a
// product prefix and is deliberately scoped to the two apps that were renamed after a
// collision, because renaming these would orphan keyspaces that already hold jobs —
// stored state, and a #51 decision rather than a side effect of a shutdown fix. What is
// pinned here is constructibility and the 6↔6 pairing.
describe("every queue name is constructible and has exactly one worker", () => {
  const queueNames = [...queueModule.matchAll(/new Queue\("([^"]+)"/g)].map((m) => m[1]);
  const workerNames = [...queueModule.matchAll(/new Worker\("([^"]+)"/g)].map((m) => m[1]);

  it("declares every queue its own QueueKey type names", () => {
    // The construction list and the type have to agree. A key in the union with no
    // `built.<key>` behind it is a queue nothing can touch; one built outside the
    // union is a keyspace no type check reaches.
    const raw = /type QueueKey = ([^;]+);/.exec(queueModule);
    assert.ok(raw, "the module declares a QueueKey union this test can read");
    const union = raw[1].split("|").map((part) => part.trim().replace(/^"|"$/g, "")).sort();
    assert.deepEqual(KEYS.slice().sort(), union);
    assert.deepEqual(queueNames.slice().sort(), [...NAMES].sort());
  });

  it("contains no colon, because bullmq throws on one at construction", () => {
    for (const name of [...queueNames, ...workerNames]) {
      assert.ok(!name.includes(":"), `bullmq rejects "${name}" outright (queue-base.js:35)`);
    }
  });

  it("pairs each queue with exactly one worker of the same name", () => {
    assert.deepEqual([...workerNames].sort(), [...queueNames].sort(),
      "a queue with no worker accumulates jobs nobody drains; a worker with no queue is a poll on an empty keyspace");
  });
});

// --- import must stay inert --------------------------------------------------
describe("importing the queue module does not connect to Redis", () => {
  it("builds each Queue inside a getter, not in the object literal", () => {
    const literal = /export const queues = \{([\s\S]*?)\n\};/.exec(queueModule);
    assert.ok(literal, "queues is declared as an object literal");
    for (const key of KEYS) {
      assert.match(literal[1], new RegExp(`get ${key}\\(\\): Queue \\{`));
      assert.doesNotMatch(literal[1], new RegExp(`^\\s*${key}: new Queue\\(`, "m"));
    }
  });

  it("memoises each one, so /api/health polling does not leak a Queue per request", () => {
    // The accessor list is parsed on its own, so this is a bijection rather than a
    // restatement of the parse above: a getter that builds nothing, and a built
    // queue nobody can reach, both fail here.
    const getters = [...queueModule.matchAll(/get (\w+)\(\): Queue \{/g)].map((m) => m[1]);
    assert.deepEqual(getters.slice().sort(), KEYS.slice().sort());
    for (const { key, name } of declared) {
      assert.match(queueModule, new RegExp(`built\\.${key} \\?\\?= new Queue\\("${name}"`),
        `${key} must be built once and cached, not on every touch`);
    }
  });

  it("is a lazy accessor on the imported object, at runtime", async () => {
    const { queues } = await import("../../src/lib/queue");
    for (const key of KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(queues, key);
      assert.equal(typeof descriptor?.get, "function", `queues.${key} is an accessor`);
      assert.equal(descriptor?.value, undefined, `and nothing was built to import it (${key})`);
    }
  });
});

// --- every queue bounds what it keeps ------------------------------------------
// #61: five of the six queues (all but analytics, bounded since #54) added jobs with no
// retention, so a bare `add` — and each warmup scheduler tick — left its hash in
// `bull:<name>:completed` forever. Measured on scratch db 13 (§8.33): three adds kept
// three, `removeOnComplete: true` kept zero, `removeOnComplete: 2` of five kept two.
// Nothing in `src/` reads `:completed` back — the only consumer of queue state is
// /api/health, which counts waiting/active/failed — so a kept completed job has no
// reader, and the durable record of the work is SQLite, not the queue. The default is
// set at construction, not in `enqueue`, so it also bounds the paths that bypass
// `enqueue()`: warmup's `upsertJobScheduler` and any direct `queues.X.add`. bullmq merges
// `{ ...defaultJobOptions, ...opts }` per add (queue.js:199,236,266), so an add naming
// its own retention — analytics' `removeOnFail: true`, which its fixed day id needs —
// still wins. That merge is what the probe below checks against a real Redis.
describe("every queue declares retention at construction", () => {
  it("names one shared default that drops completed and keeps failures", () => {
    assert.match(queueModule, /import \{ JOB_RETENTION \} from "\.\/queue-retention";/);
    assert.match(retentionModule, /export const JOB_RETENTION[^=]*= \{ removeOnComplete: true, removeOnFail: \d+ \};/);
  });

  it("hands that default to every Queue", () => {
    const bounded = [...queueModule.matchAll(/new Queue\("([^"]+)", \{ connection, defaultJobOptions: JOB_RETENTION \}\)/g)].map((m) => m[1]);
    assert.deepEqual([...bounded].sort(), [...NAMES].sort(), "a queue built without the default leaks its completed jobs");
  });

  it("constructs no queue with the bare `{ connection }` that this finding removes", () => {
    assert.doesNotMatch(queueModule, /new Queue\("[^"]+", \{ connection \}\)/);
  });

  it("keeps recent failures rather than dropping them — the failed hash is the only record", () => {
    // A sequence/enrichment/webhook failure writes no error row anywhere else; the job
    // hash is the only place its payload and stack survive. So completed → 0, failed → N.
    const cap = Number(/removeOnFail: (\d+)/.exec(retentionModule)?.[1] ?? "0");
    assert.ok(cap > 0, `failed jobs are kept, capped at ${cap} — not dropped the way completed are`);
  });

  it("does not touch the analytics override that its fixed day id depends on", () => {
    // If the default's `removeOnFail: <number>` were merged the wrong way, a completed
    // rollup would keep the day's key and freeze it. The existing rollup guard pins the
    // literals; this pins that the per-add opts are still there to override at all.
    assert.match(analyticsModule, /removeOnComplete: true,\s*removeOnFail: true,/);
  });
});

// --- the drain ---------------------------------------------------------------
describe("shutdownWorkers closes what startWorkers started", () => {
  it("keeps every Worker, so the drain has a reference to close", () => {
    assert.match(queueModule, /const workers: Worker\[\] = \[\];/);
    const pushed = [...queueModule.matchAll(/workers\.push\(new Worker\("([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...pushed].sort(), [...NAMES].sort(),
      "startWorkers() kept none of them before this, so there was nothing to close");
  });

  it("lets in-flight Redis setup land before closing anything", () => {
    const drain = /export async function shutdownWorkers\(\) \{([\s\S]*?)\n\}/.exec(queueModule);
    assert.ok(drain, "shutdownWorkers is defined in this module");
    const body = drain[1];
    assert.ok(body.indexOf("waitUntilReady") < body.indexOf(".close()"),
      "waitUntilReady must come first: closing a Queue mid-connect is the crash at redis-connection.js:87");
    assert.ok(body.includes("catch(() => undefined)"),
      "and a waitUntilReady that never lands must be caught at creation, or abandoning it is its own unhandled rejection");
  });

  it("disconnects rather than quitting, so a never-connected client does not throw", () => {
    assert.match(queueModule, /connection\.disconnect\(\);/);
    assert.doesNotMatch(queueModule, /connection\.quit\(\)/);
  });
});

// --- who calls it ------------------------------------------------------------
describe("the drain is wired to something", () => {
  it("installs the signal handlers from instrumentation, in production only", () => {
    assert.match(
      instrumentation,
      /if \(process\.env\.NODE_ENV === "production"\) \{[\s\S]*installShutdownHandlers\(\)/,
    );
  });

  it("binds both SIGTERM and SIGINT", () => {
    const shutdown = source("../../src/lib/shutdown.ts");
    assert.match(shutdown, /\["SIGTERM", "SIGINT"\] as const/);
  });
});

// --- producers: no Worker may poll a keyspace nothing writes to ----------------
// #53 put this rule into shared/check-queues.sh and leadgenius was the app it skipped,
// because two of its six queues failed it: dev db 0 held `bull:enrichment:meta` and
// `bull:analytics:meta` and nothing else — one key, bullmq's signature for a queue that
// has never received a job (stored state, not inferred) — while both had a Worker since
// #50 polling them. The assertions below are the add sites, read from source, offline.
describe("every queue this app runs a Worker on has an add site", () => {
  it("enrichment is produced by the contact create", () => {
    assert.match(contactsRoute, /enqueue\(queues\.enrichment, "enrich-contact", \{ contactId: contact\.id \}\)/);
  });

  it("and the create imports the gate rather than restating it", () => {
    assert.match(contactsRoute, /import \{ hasEnrichableGap \} from "@\/lib\/enrichment"/);
    assert.match(enrichmentModule, /export function hasEnrichableGap\(/);
    assert.match(enrichmentModule, /if \(!contact \|\| !hasEnrichableGap\(contact\)\) return null;/);
    // The route must not carry its own copy of the condition — two predicates are how a
    // producer and a worker start disagreeing.
    assert.doesNotMatch(contactsRoute, /!contact\.email &&|!contact\.company &&/);
  });

  it("analytics is produced by every route that writes the row the rollup counts", () => {
    for (const [name, body] of Object.entries(activityRoutes)) {
      // #60 moved the write behind the idempotency gate: the route no longer calls
      // prisma.activity.create itself, it calls recordInboundActivity, which is the only
      // place that bare create now survives. The guard follows the row to that call site
      // rather than loosening — a route that wrote an Activity outside the gate would drop
      // this match, exactly as dropping the rollup below does.
      assert.match(body, /const activity = await recordInboundActivity\(/, `${name} must write the row through the gate`);
      assert.match(body, /await enqueueDailyRollup\([^\n]+activity\.createdAt\)/, `${name} must queue the day that row landed in`);
    }
    assert.match(analyticsModule, /export async function enqueueDailyRollup\(/);
    assert.match(queueModule, /const \{ workspaceId, date \} = job\.data;\n\s*await rollupDay\(workspaceId, new Date\(date\)\);/);
    assert.doesNotMatch(queueModule, /await aggregateAnalytics\(/, "the Worker runs the re-checking wrapper, not the bare write");
  });

  it("the rollup cannot fail a webhook that already committed its row", () => {
    // enqueueDailyRollup must never throw: it runs after the Activity row is durable and
    // before the sequence enqueue, so a throw here would answer 503 to a webhook whose row
    // is already committed. #60 added an idempotency key so such a redelivery no longer
    // double-counts, but a non-throwing producer is still the right posture — the day gets
    // re-derived by the scheduled rollup regardless, and the request should not fail for it.
    const body = /export async function enqueueDailyRollup\([\s\S]*?\n\}/.exec(analyticsModule)?.[0] ?? "";
    assert.match(body, /try \{/);
    assert.match(body, /catch \(error\) \{\n\s*console\.warn/, "and it warns rather than throwing");
    assert.doesNotMatch(body, /throw /);
  });
});

// --- the GET reads the row the rollup writes, and writes nothing ----------------
describe("the analytics GET is a reader, not a second writer", () => {
  it("reads the persisted day through a function that only reads", () => {
    // #59: `AnalyticsDaily` had exactly one touch in src/ — the upsert inside
    // `aggregateAnalytics` (grep over src/ found no findUnique/findFirst/findMany on the
    // table) — so the rollup wrote a table nothing read. #58: the same
    // `aggregateAnalytics` was the GET's daily branch, so a dashboard poll upserted the row
    // it was displaying, racing the rollup Worker for the same `@@unique([workspaceId,
    // date])` key and doing the full Activity re-scan on every load. The GET now reaches a
    // dedicated reader; the write lives only in the Worker path.
    assert.match(analyticsRoute, /case "daily":[\s\S]*?await getDailyAnalytics\(workspaceId, date\)/);
    assert.doesNotMatch(analyticsRoute, /aggregateAnalytics/, "the GET must not call the compute-and-write path");
    const reader = /export async function getDailyAnalytics\([\s\S]*?\n\}/.exec(analyticsModule)?.[0] ?? "";
    assert.match(reader, /prisma\.analyticsDaily\.findUnique\(\{/);
    assert.doesNotMatch(reader, /prisma\.analyticsDaily\.(upsert|create|update|delete)/, "the reader must not write");
    // The lookup key is the day bucket, so the GET's arbitrary `?date=` cannot miss the row
    // the Worker stored at local midnight.
    assert.match(reader, /const bucket = dayBucket\(date\);/);
    assert.match(reader, /where: \{ workspaceId_date: \{ workspaceId, date: bucket \} \}/);
  });
});

// --- the rollup's job key is the day, not the event ------------------------------
describe("one analytics job per workspace-day, and the day can be re-queued", () => {
  const rollup = /export async function enqueueRollup\([\s\S]*?\n\}/.exec(analyticsModule)?.[0] ?? "";
  const jobIdFn = /export function rollupJobId\([\s\S]*?\n\}/.exec(analyticsModule)?.[0] ?? "";

  it("names the key after the workspace and the local day", () => {
    assert.match(jobIdFn, /`analytics-\$\{workspaceId\}-\$\{dayKey\(bucket\)\}`/);
    // A key minted per request is the leadworks `scheduled` bug (#53): every call made a
    // new scheduler and the fixed one never appeared.
    assert.doesNotMatch(jobIdFn + rollup, /Date\.now|randomUUID|Math\.random/);
  });

  it("keeps colons out of the custom id, which bullmq validates", () => {
    // Measured on db 13: `analytics:w1` threw `Custom Id cannot contain :` while
    // `analytics:w1:2026-10-06` was accepted — job.js:1069-1076 allows a colon only in a
    // three-part id, and three-part ids are what repeat.js:78 and scripts.js:388 then
    // parse as legacy repeatable keys. Neither is a key this rollup wants to be.
    assert.doesNotMatch(rollup, /jobId: "[^"]*:/);
    assert.match(rollup, /jobId: rollupJobId\(workspaceId, bucket\)/);
  });

  it("drops the job when it finishes, or the day freezes at its first event", () => {
    // Both halves were measured on db 13. With removeOnComplete the id was free again
    // after the run and the second rollup happened; without it, `add` returned a Job for
    // the completed id, dropped the payload, and the handler never ran a second time.
    assert.match(rollup, /removeOnComplete: true/);
    assert.match(rollup, /removeOnFail: true/);
  });

  it("puts the day in the payload, because a colliding add is dropped, not merged", () => {
    // Measured: adding the same jobId while the first still waited left one waiting job
    // and the handler ran with the *first* add's data. An event timestamp there would have
    // made every event after the first roll up the wrong instant.
    assert.match(rollup, /\{ workspaceId, date: bucket\.toISOString\(\) \}/);
    assert.doesNotMatch(rollup, /occurredAt\.toISOString\(\)/);
  });

  it("buckets on the same local midnight the rollup windows on", () => {
    const bucket = /function dayBucket\(date: Date\): Date \{([\s\S]*?)\n\}/.exec(analyticsModule)?.[1] ?? "";
    assert.match(bucket, /start\.setHours\(0, 0, 0, 0\);/);
    assert.match(analyticsModule, /createdAt: \{ gte: start, lt: end \}/);
  });

  it("does not let the update move the row off the key that found it", () => {
    // `update: result` carried `date`, and result.date used to be the caller's argument.
    // Against a copy of dev.db, three rollups of one day left two rows: 00:00 and 14:00.
    const upsert = /await prisma\.analyticsDaily\.upsert\(\{([\s\S]*?)\n  \}\);/.exec(analyticsModule)?.[1] ?? "";
    assert.match(upsert, /update: counters,/);
    assert.doesNotMatch(upsert, /update: \{[^}]*date/);
    assert.match(upsert, /create: \{ workspaceId, date: start, \.\.\.counters \}/);
  });

  it("re-checks the window, because a drop during a run loses an event", () => {
    // The after-probe caught this: twelve `open` events over HTTP left the row at 11 with
    // twelve Activities stored, and `bull:analytics:events` showed
    // `added,waiting,active,duplicated,completed` — the twelfth add was coalesced into a
    // job that had already read the window. The fixed key cannot tell those two states
    // apart, so the run has to.
    const rollupDay = /export async function rollupDay\([\s\S]*?\n\}/.exec(analyticsModule)?.[0] ?? "";
    assert.match(rollupDay, /const before = await countDayActivities\(workspaceId, window\);/);
    assert.match(rollupDay, /const after = await countDayActivities\(workspaceId, window\);/);
    assert.match(rollupDay, /if \(after === before\) return;/);
    // Bounded, and it warns rather than throwing: the job would otherwise be marked failed
    // and the day would go short exactly as it did before.
    assert.match(rollupDay, /if \(pass >= ROLLUP_MAX_PASSES\) \{\n\s*console\.warn/);
    assert.match(analyticsModule, /const ROLLUP_MAX_PASSES = \d+;/);
    assert.doesNotMatch(rollupDay, /throw /);
    // The window it counts has to be the window the rollup reads.
    assert.match(analyticsModule, /function dayWindow\(bucket: Date\)[\s\S]*?end\.setDate\(end\.getDate\(\) \+ 1\);/);
    assert.match(analyticsModule, /createdAt: \{ gte: window\.start, lt: window\.end \}/);
  });
});

// --- the guess stays out of the column campaigns send to ------------------------
describe("enrichment writes only what it can stand behind", () => {
  it("has no verifier that answers for a provider that is not there", () => {
    // The placeholder returned true, so guessEmail's *first* pattern was written into
    // Contact.email unexamined — and channels/email.ts:28 hands that column to
    // nodemailer's `to`. #56 decides whether to wire a real verifier or drop the guess.
    assert.match(enrichmentModule, /const emailVerifier: \(\(email: string\) => Promise<boolean>\) \| null = null;/);
    assert.doesNotMatch(enrichmentModule, /verifyEmailExists|return true; \/\/ Placeholder/);
  });

  it("gates the email branch on the verifier, in the worker and in the predicate", () => {
    assert.match(enrichmentModule, /if \(!contact\.email && contact\.firstName && contact\.lastName && contact\.company && emailVerifier\)/);
    assert.match(enrichmentModule, /\(\!\!emailVerifier && !contact\.email/);
  });

  it("will not name a company after a mailbox provider", () => {
    // sequence-engine.ts:126 renders {{company}} into the body a prospect reads.
    assert.match(enrichmentModule, /const PUBLIC_EMAIL_DOMAINS = new Set\(\[/);
    assert.match(enrichmentModule, /"gmail\.com"/);
    assert.match(enrichmentModule, /PUBLIC_EMAIL_DOMAINS\.has\(domain\.toLowerCase\(\)\)/);
  });

  it("has no placeholder helper or bulk loop that nothing calls", () => {
    // lookupPhone and bulkEnrichContacts had zero callers outside their own definitions
    // (grep over src/, tests/, prisma/), and the phone branch was `const phone = ""`
    // followed by `if (phone)` — a write that could never happen. #56 closed the
    // linkedinUrl case the same way: `findLinkedIn` returned "", the branch was
    // `results.linkedinUrl = ""` behind `if (results.linkedinUrl)` — never taken.
    // Contact.linkedinUrl is a real column; enrichment is not what fills it.
    assert.doesNotMatch(
      enrichmentModule,
      /lookupPhone|bulkEnrichContacts|results\.phone|findLinkedIn|results\.linkedinUrl|linkedinUrl:\s*results/,
    );
  });
});

// --- warmup is scheduled per account, not per app ---------------------------
// #57: `scheduleWarmup` used `add(name, { accountId }, { repeat })`, and bullmq derives
// the legacy repeat key from getRepeatConcatOptions =
// `${name}:${jobId}:${endDate}:${tz}:${pattern}` (repeat.js:170-177, read from source) —
// the job *data* is not an input, so accountId never reached the key. Measured on db 13
// both orders (§8.32.1): two accounts collapse onto ONE scheduler whose stored template —
// the only source of data for every future tick — names whichever asked first. The guard
// below asserts the fix's shape offline: a per-account `upsertJobScheduler` key.
describe("warmup schedules each account on its own key", () => {
  const schedule = /export async function scheduleWarmup\([\s\S]*?\n\}/.exec(warmupModule)?.[0] ?? "";

  it("produces to the warmup queue, so the Worker that polls it has a producer", () => {
    assert.match(schedule, /queues\.warmup\.upsertJobScheduler\(/);
  });

  it("keys the scheduler on the accountId, so two accounts get two schedulers", () => {
    assert.match(schedule, /upsertJobScheduler\(\s*`warmup-\$\{accountId\}`/);
    // A constant key would be the leadworks `scheduled` bug run the other way: every
    // account upserting one scheduler, so only the last to boot its own survives (#53).
    assert.doesNotMatch(schedule, /upsertJobScheduler\(\s*"[^"]*"/);
  });

  it("carries the accountId in the job template, not only in the key", () => {
    // The Worker runs `runWarmup(job.data.accountId)`; a scheduler whose template is
    // `{}` would tick forever running nothing.
    assert.match(schedule, /data: \{ accountId \}/);
  });

  it("keeps the pattern the app wants, and mints a colon-free scheduler key", () => {
    assert.match(schedule, /\{ pattern: "0 9 \* \* \*" \}/);
    // bullmq rejects a colon in a two-part job id (job.js:1069-1076). The key is
    // `warmup-${accountId}`, so the only colon risk is a literal one in the template text.
    const key = /upsertJobScheduler\(\s*(`[^`]*`|"[^"]*")/.exec(schedule)?.[1] ?? "";
    assert.ok(key.startsWith("`warmup-"), `the key is the accountId template, got ${key}`);
    assert.ok(!key.includes(":"), "and it contains no colon");
  });

  it("no longer uses the legacy add(..., { repeat }) form this finding is about", () => {
    assert.doesNotMatch(warmupModule, /add\([^)]*repeat/, "the whole point: repeat-by-add ignores the data");
    assert.doesNotMatch(warmupModule, /repeat: \{ pattern/);
  });
});

// --- probe: only against an explicitly named, non-zero db --------------------
if (probeUrl) {
  const expectedDb = Number(/\/(\d+)$/.exec(probeUrl)?.[1] ?? 0);

  // Runs the app's own producer against a scratch db, and deliberately before the drain
  // probe below: it leaves `queues.analytics` built on the module's shared client instead
  // of shutting anything down, because `shutdownWorkers()` disconnects that client and a
  // `lazyConnect` instance does not come back on its own. The drain probe closes it.
  describe("probe: the daily rollup is one job per workspace-day, and the day can be run again", () => {
    it("coalesces, then re-queues once the day has completed", { skip: probeNamesLiveDb ? `QUEUE_PROBE_URL=${probeUrl} names the live db` : false }, async () => {
      const mod = await import("../../src/lib/queue");
      const { enqueueRollup, rollupJobId } = await import("../../src/lib/analytics");
      const { Worker } = await import("bullmq");
      const IORedis = (await import("ioredis")).default;

      const queue = mod.queues.analytics;
      // bullmq 6: waitUntilReady() resolves void; the raw Redis client lives on
      // the backend now, which is what the db assertion below is asking about.
      await queue.waitUntilReady();
      const shared = await queue.getBackend().client;
      assert.equal((shared as unknown as { options?: { db?: number } }).options?.db, expectedDb,
        "the producer must write where this process was told to, not where the import-time default points");
      assert.equal(await queue.getWaitingCount(), 0, "a scratch db starts this queue empty");

      const workspaceId = `probe-${process.pid}-${Date.now()}`;
      const morning = new Date(2026, 9, 6, 8, 0);
      const evening = new Date(2026, 9, 6, 20, 30);
      const nextDay = new Date(2026, 9, 7, 1, 0);
      const dayOneKey = rollupJobId(workspaceId, new Date(2026, 9, 6));
      assert.equal(dayOneKey.includes(":"), false, "bullmq validates a custom id for colons; this one has none");
      assert.equal(dayOneKey, `analytics-${workspaceId}-20261006`, "the key is workspace + local day, in that order");

      const own = new IORedis(probeUrl, { maxRetriesPerRequest: null });
      assert.equal(own.options.db, expectedDb, "the probe's own client lands on the same scratch db");

      await enqueueRollup(workspaceId, morning);
      assert.equal(await queue.getWaitingCount(), 1, "first event of the day queues the day");

      await enqueueRollup(workspaceId, evening);
      assert.equal(await queue.getWaitingCount(), 1, "a second event the same day is dropped, not queued twice");

      const stored = await own.hgetall(queue.toKey(dayOneKey));
      assert.ok(Object.keys(stored).length > 0, `the job ${dayOneKey} is stored`);
      assert.equal(JSON.parse(stored.data).date, new Date(2026, 9, 6, 0, 0, 0, 0).toISOString(),
        "the payload is local midnight, so the two adds that collided could not have disagreed about anything");

      await enqueueRollup(workspaceId, nextDay);
      assert.equal(await queue.getWaitingCount(), 2, "the next day is its own job");

      // Complete them with a stand-in handler — this is about the keys, and the real
      // handler is a Prisma call that has no business running against a probe db.
      const ran: string[] = [];
      const worker = new Worker("analytics", async (job) => { ran.push(job.id ?? ""); }, { connection: own, concurrency: 1 });
      await worker.waitUntilReady();
      const deadline = Date.now() + 10_000;
      while (ran.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.equal(ran.length, 2, `both days drained (${ran.length})`);

      assert.equal(await queue.getCompletedCount(), 0, "removeOnComplete took the jobs out of completed");
      assert.deepEqual(await own.hgetall(queue.toKey(dayOneKey)), {}, "and the job key itself is gone");

      await worker.close();

      // The contrast that made removeOnComplete a requirement rather than a tidiness
      // preference: with the completed job still holding the id, this add is dropped and
      // the day never gets recomputed. Measured both ways on db 13 in #54's probe. The
      // worker is closed first, or it drains this and the count below is a race.
      await enqueueRollup(workspaceId, evening);
      assert.equal(await queue.getWaitingCount(), 1, "a later event can queue the day again once it has run");

      await queue.drain();
      await own.quit();
    });
  });

  // The #57 after-probe, through the app's own scheduleWarmup. It must run before the
  // drain block below, which disconnects the module's shared client.
  describe("probe: two accounts get two schedulers, and re-scheduling is idempotent", () => {
    it("one scheduler per accountId, each carrying its own data", { skip: probeNamesLiveDb ? `QUEUE_PROBE_URL=${probeUrl} names the live db` : false }, async () => {
      const mod = await import("../../src/lib/queue");
      const { scheduleWarmup } = await import("../../src/lib/warmup");
      const IORedis = (await import("ioredis")).default;

      const queue = mod.queues.warmup;
      await queue.waitUntilReady();
      const shared = await queue.getBackend().client;
      assert.equal((shared as unknown as { options?: { db?: number } }).options?.db, expectedDb,
        "the producer must write where this process was told, not the import-time default");

      // Process-pid-unique so a rerun cannot collide with a leftover scheduler.
      const acctA = `n57-probe-${process.pid}-a`;
      const acctB = `n57-probe-${process.pid}-b`;

      assert.equal(await queue.getJobSchedulersCount(), 0, "the scratch warmup queue starts with no scheduler");

      await scheduleWarmup(acctA);
      await scheduleWarmup(acctB);
      assert.equal(await queue.getJobSchedulersCount(), 2,
        "two accounts are two schedulers — this is the whole finding; before the fix this read 1");

      // Re-scheduling the same account overrides, it does not add a third.
      await scheduleWarmup(acctA);
      assert.equal(await queue.getJobSchedulersCount(), 2, "re-scheduling acctA is idempotent (override:true)");

      const schedulers = await queue.getJobSchedulers(0, -1);
      const byKey = new Map(schedulers.map((s) => [s.key, s]));
      assert.ok(byKey.has(`warmup-${acctA}`) && byKey.has(`warmup-${acctB}`),
        `keys name the account, got ${JSON.stringify(schedulers.map((s) => s.key))}`);

      const own = new IORedis(probeUrl, { maxRetriesPerRequest: null });
      for (const [acct, id] of [[acctA, "a"], [acctB, "b"]] as const) {
        const data = await own.hget(`bull:warmup:repeat:warmup-${acct}`, "data");
        assert.equal(JSON.parse(String(data)).accountId, acct,
          `acct${id}'s template carries acct${id}, not whichever registered first`);
      }

      // Clean up both schedulers, so a rerun starts from the empty count asserted above and
      // no scheduler survives to tick against whatever db this process later points at.
      await queue.removeJobScheduler(`warmup-${acctA}`);
      await queue.removeJobScheduler(`warmup-${acctB}`);
      assert.equal(await queue.getJobSchedulersCount(), 0, "both schedulers removed after the probe");
      await own.quit();
    });
  });

  describe("probe: the construction default bounds a job that names no retention", () => {
    // The finding is precisely about the sites that pass `enqueue()` no opts — the five
    // non-analytics add calls. Setting the default at construction is only worth
    // something if it lands on those adds; this drives the app's own `enqueue` with no
    // opts through the app's own `queues.sequence` and asks Redis what survived. It runs
    // before the drain block, which disconnects the shared client.
    it("drops completed but keeps a failure, both from the default alone", { skip: probeNamesLiveDb ? `QUEUE_PROBE_URL=${probeUrl} names the live db` : false }, async () => {
      const mod = await import("../../src/lib/queue");
      const { Worker } = await import("bullmq");
      const IORedis = (await import("ioredis")).default;

      const queue = mod.queues.sequence;
      await queue.waitUntilReady();
      const shared = await queue.getBackend().client;
      assert.equal((shared as unknown as { options?: { db?: number } }).options?.db, expectedDb,
        "the producer must write where this process was told, not the import-time default");
      assert.equal(await queue.getCompletedCount(), 0, "the scratch sequence queue starts with no completed job");

      const own = new IORedis(probeUrl, { maxRetriesPerRequest: null });
      assert.equal(own.options.db, expectedDb, "the probe's own client lands on the same scratch db");

      const done: string[] = [];
      const worker = new Worker("sequence", async (job) => {
        if (job.data.fail) throw new Error("probe-induced failure");
        done.push(job.id ?? "");
      }, { connection: own, concurrency: 1 });
      await worker.waitUntilReady();

      // Three that succeed, one that fails — all added with NO opts, so every retention
      // number here comes from the default at construction, not from a per-add override.
      const failedId = "probe-fail-" + process.pid;
      for (let i = 0; i < 3; i++) await mod.enqueue(queue, "retention-probe", { n: i });
      await mod.enqueue(queue, "retention-probe", { fail: true }, { jobId: failedId });

      const deadline = Date.now() + 15_000;
      while ((done.length < 3 || (await queue.getFailedCount()) < 1) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(done.length, 3, `all three good jobs drained (${done.length})`);

      // Half one: completed is dropped. The only reason this is 0 and not 3 is the default.
      assert.equal(await queue.getCompletedCount(), 0, "removeOnComplete from the construction default took the three");
      for (const id of done) assert.deepEqual(await own.hgetall(queue.toKey(id)), {}, `job ${id} hash is gone, not just uncounted`);

      // Half two: the failure is kept — the contrast that makes this a policy, not a flush.
      assert.ok((await queue.getFailedCount()) >= 1, "removeOnFail: <number> keeps the failed job for debugging");
      assert.ok(Object.keys(await own.hgetall(queue.toKey(failedId))).length > 0, "and its hash, with the payload and stack, survives");

      // Clean up so a rerun starts from the empty counts asserted above and nothing is
      // left in the scratch db under the app's real queue names.
      await worker.close();
      await queue.remove(failedId);
      assert.equal(await queue.getFailedCount(), 0, "the probe removed its own failure");
      await own.quit();
    });
  });

  describe("probe: building and draining the six queues on a scratch db", () => {
    // A skipped assertion is invisible, so a probe pointed at the live keyspace is a
    // failure first and a skip second — otherwise the run just looks one test shorter.
    it("refuses db 0, which is where dev state lives", () => {
      assert.ok(!probeNamesLiveDb, `QUEUE_PROBE_URL=${probeUrl} names the live db; name a scratch one`);
    });

    it("returns the same Queue on repeated touch, and shuts down without throwing", { skip: probeNamesLiveDb ? "refusing db 0" : false }, async () => {
      const mod = await import("../../src/lib/queue");
      const first = mod.queues.send;
      assert.equal(mod.queues.send, first, "the getter memoises");

      // Touch all six the way /api/health does, then ask the connection where it is.
      for (const key of Object.keys(mod.queues)) void mod.queues[key as keyof typeof mod.queues];
      await first.waitUntilReady();
      const client = await first.getBackend().client;
      assert.equal((client as unknown as { options?: { db?: number } }).options?.db, expectedDb,
        "the probe must land on the db it was given, not on the import-time default");

      await mod.shutdownWorkers();
      assert.notEqual(mod.queues.send, first, "a second build after shutdown is a fresh Queue");
    });
  });
}
