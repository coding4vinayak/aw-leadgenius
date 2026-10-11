# LeadGenius

![CI](https://github.com/coding4vinayak/aw-leadgenius/actions/workflows/ci.yml/badge.svg)


AI sales engagement and multichannel outreach. Outreach that earns replies,
not spam complaints — $29/user/month.

Campaigns enroll contacts into sequences across email, WhatsApp and
LinkedIn, with per-step delays, branch conditions, A/B variants, warmup
ramping for new domains, and a full activity trail (sent → delivered →
opened → clicked → replied → bounced).

## Quick start

```bash
npm install
npx prisma migrate dev      # creates the SQLite database
npm run db:seed             # demo workspace, campaign, sequence, 3 contacts
npm run dev                 # http://localhost:3200
```

## Accounts (browser)

Machine callers authenticate with an API key above. Humans sign in:

```
GET  /login                # sign in
POST /signup               # create a workspace and an account
GET  /dashboard            # your own workspace (needs the session cookie)
GET  /members              # seats, invites, roles (owner/admin)
GET  /invite/{token}       # accept a one-time invitation link
```

A signup mints a `User` and a `Workspace` in one transaction and drops the
browser straight into it. Passwords are scrypt with the work factor recorded
beside the digest, so the cost can be raised later without invalidating anyone.
The session cookie holds a random 32-byte token and the database keeps only its
sha256; it is httpOnly, sameSite=lax, and `secure` outside development.

`?workspace=demo` stays public on purpose — it is what the landing pages link to
and what a prospect evaluates. Every other workspace requires the session that
owns it: naming someone else's slug is refused rather than served, and an
anonymous visitor is pointed at the login form instead of the data.

Sign-in is rate-limited per address (10 failures, 15-minute lock) and signup to
5 workspaces, so one client cannot grind through a list of accounts. Failed
logins take the same time whether or not the address exists.

A brand-new account has no API key, so the dashboard offers to mint one and
shows it exactly once — only a hash is stored. The prompt is scoped to
signed-in workspaces: a stranger on the public demo is never nagged to sign up.
It is a server action rather than a `POST /api/keys` call so the plaintext goes
straight into the page and never into a URL, a referrer, or an access log.

### Password reset and email verification

```
GET  /forgot-password             # request a reset link
GET  /reset-password?token=       # choose a new password
GET  /verify-email?token=         # confirm the address
```

Both links are **POST-only**: the page reads the token, the button redeems it. A
GET that changes state is triggered by link previewers, chat clients and
corporate scanners, so a single Slack unfurl would spend the token before the
person read it.

Tokens are stored hashed (sha256), single-use, and expired — reset in 1 hour,
verification in 24. Issuing a new one deletes the previous, so a link forwarded
last year stops working the moment a fresh one is requested. Reset requests are
rate limited to 3 per address per hour.

Redeeming a reset also **destroys every session on that account**. A password
change that leaves old cookies working evicts nobody, which defeats the entire
point of resetting. The same gap existed in abetConnect and is fixed there too.

The request endpoint answers identically whether or not the address has an
account — a "no such user" there is a customer enumeration oracle.

### Email delivery is honest about itself

`send()` returns which transport actually ran, and the UI says so:

| State | Behaviour |
|---|---|
| `RESEND_API_KEY` or `EMAIL_WEBHOOK_URL` set | Message is delivered; verification is enforced at sign-in |
| Neither set | Link is written to the server log, and the page says plainly that nothing was sent |

An account created with no provider configured starts **pre-verified**, because
enforcing a click on a message that can never arrive would lock the account out
of its own product. With a provider set, sign-up starts unverified, sends the
link, and `signIn` refuses until it is confirmed. A provider outage at
verification is swallowed deliberately — the account exists, and the link can be
re-sent from the dashboard — because failing signup after the row is written
would leave an account nobody can reach.

No new dependency: the HTTP sender is `fetch` only, and `setEmailSender()`
accepts SMTP, SES or anything else without touching a route.

### Teams

Anyone with an account belongs to one or more workspaces, each with a role:
`OWNER` (created at signup, never issuable by invite), `ADMIN`, or `MEMBER`.
Owners and admins invite by email from `/members`; the link is single-use,
expires in 7 days, names one address, and is shown once because only its hash
is stored. Re-inviting rotates the old link dead. Accepting moves the browser
into the new workspace. Removing a seat destroys that person's sessions in it
immediately — revoking access and leaving the cookie working would be the same
mistake twice. The dashboard bar lists every workspace the account can open.

An admin can invite members but cannot mint another admin; only an owner can.
A member cannot invite, see keys, or change seats. Ownership never transfers
through the invite path — that is a decision, not a missing feature.

Set `SESSION_COOKIE` if several of these products ever share one hostname, so
their cookies stay apart. It defaults to `abetworks_session`, which is safe as
long as each product has its own database — a token from one is simply not found
in another's session table.

This file's provenance: the auth surface shipped as one source, byte-copied across six
apps during the Abetworks campaign. The vendoring scripts and drift gate that enforced
identity are retired. This app's copy is its own and can evolve independently.
Full context: `abetworks-history` §8.20 and §8.44.

## Authentication

Every management route is workspace-scoped and requires an API key. A browser session is the other half — see [Accounts](#accounts-browser). `workspaceId`
in the query or body is **checked against the key** — a mismatch is a `403`,
not a silent cross-tenant read.

```bash
# Mint a key for the demo workspace (side-effect free, mints a fresh key)
npm run seed:key            # prints the plaintext once

# Call anything
curl http://127.0.0.1:3200/api/campaigns?workspaceId=cmu82m3af0000niejg46dqd6n \
  -H "Authorization: Bearer <paste-key>"
```

Keys are prefixed `lg_live_` so a leaked one is self-identifying. Only a sha256
hash is stored; the plaintext is shown once and cannot be recovered.

| Response | Meaning |
|---|---|
| `401` | No key, unknown key, or a revoked key |
| `403` | Valid key, but that `workspaceId` is not its workspace |

Keyless endpoints are `GET /api/health`, `POST /api/billing/webhook` (Stripe
signature) and the inbound provider event receivers. The
event receivers are authenticated by a deployment-wide HMAC
(`INBOUND_WEBHOOK_SIGNING_SECRET`, see `src/lib/inbound-webhooks.ts`) because
they write tenant data — a forged `bounce` unsubscribes a real contact — and
they fail closed while that secret is unset. Provider-native verification
(SendGrid's ECDSA token, Twilio's `X-Twilio-Signature`, Postmark's HMAC) is the
next step once real provider accounts exist to check it against; it is not
implemented, and a half-guessed implementation would read as verified while
being guesswork.

## API

All routes below need the key from [Authentication](#authentication) —
the snippets omit the header for width.

```
GET    /api/health                         # liveness + DB ping, no key
GET    /api/campaigns?workspaceId=         # list
POST   /api/campaigns                      # create (draft)
GET    /api/campaigns/{id}                 # detail + sequences + enrollments
PATCH  /api/campaigns/{id}                 # rename, start, pause, complete
GET    /api/sequences?workspaceId=         # list
POST   /api/sequences                      # create with steps
GET    /api/contacts?workspaceId=          # list
POST   /api/contacts                       # create, optionally into lists
GET    /api/contacts/{id}                  # detail
POST   /api/contacts/{id}?action=enrich    # enrich on demand
GET    /api/contact-lists?workspaceId=     # lists
GET    /api/templates?workspaceId=         # message templates
GET    /api/sending-accounts?workspaceId=  # channel accounts + health
POST   /api/sending-accounts/{id}?action=warmup        # run a warmup pass
POST   /api/sending-accounts/{id}?action=schedule-warmup  # nightly warmup
GET    /api/enrollments/{id}               # one enrollment with its trail
GET    /api/analytics/{workspaceId}?type=overview|campaign|sequence|daily
POST   /api/webhooks                       # subscribe (HMAC-signed deliveries)
POST   /api/webhooks/email|whatsapp|linkedin  # provider event receivers —
                                             # require x-inbound-timestamp and
                                             # x-inbound-signature (HMAC, see
                                             # src/lib/inbound-webhooks.ts)
POST   /api/ai/draft-reply                 # draft a reply; human sends
```

Sending accounts carry daily limits and reputation scores; the engine skips
spent or low-reputation accounts rather than burning a domain. Warmup ramps
new senders gradually. Bounces and complaints pause the enrollment
automatically — deliverability is enforced in code, not in a runbook.

## AI (optional)

`POST /api/ai/draft-reply` takes `{ workspaceId, enrollmentId, reply, productContext?, knownFacts?, model? }`.
The model drafts; a human reviews and sends — nothing here writes or sends
anything. Opt-outs are honoured by the deterministic classifier without ever
calling a model. Without `LLM_API_KEY` the route still classifies the reply
and says so (`configured: false`).

**In the UI:** the signed-in dashboard has a *Draft a reply* panel above the
fold — pick an enrollment, paste the reply, read the draft. It is a draft: a
human reviews and sends. The panel calls this route with the session cookie, so
no API key is needed to try it; the route still accepts a bearer key for scripts.

Setup: any OpenAI-compatible key. `LLM_API_KEY`, optional `LLM_BASE_URL`
(defaults to OpenAI), `LLM_MODEL`, `LLM_TIMEOUT_MS` (default 12000). No key,
provider outage, timeout, or unusable answer all degrade to `null` — the
product behaves identically, it just has no draft to show. Guard rails are
unit-tested offline in `tests/unit/ai-reply.test.ts`.

## Billing

$29/user/month via Stripe. Three endpoints under `/api/billing` (workspaceId as query param, no session in this app):

POST /api/billing/checkout
POST /api/billing/portal
POST /api/billing/webhook

`checkout` takes `{ priceId: "USER_MONTHLY" | "USER_ANNUAL", returnUrl }` and returns `{ url }` for the Stripe-hosted page. The webhook verifies the Stripe signature and syncs `checkout.session.completed`, `customer.subscription.*`, and `invoice.payment_failed` into the `Subscription` row. Setup: create the two prices in Stripe, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_USER_MONTHLY`, `STRIPE_PRICE_USER_ANNUAL`, forward webhooks with `stripe listen --forward-to localhost:3200/api/billing/webhook`. Signature checks are unit-tested offline in `tests/unit/billing.test.ts`.

## Putting it somewhere

```bash
npm ci
npm run db:deploy
npm run build
npm start
```

Point the load balancer at `GET /api/health` (200 = serving, 503 = DB down).
Queue workers (`src/lib/queue.ts`, BullMQ + Redis) drain send, sequence,
enrichment, webhook, analytics and warmup queues. For Postgres, follow the
same three steps as abetConnect: provider switch, fresh migration history,
regenerate. Each of the six Queues is built on first touch rather than at import:
constructing one connects to Redis even on a `lazyConnect` client, so importing the
module wrote six `bull:<name>:meta` keys — measured on the pre-fix module against a
scratch db, rc=124 (never exited) with all six left behind, and dev `REDIS_URL` defaults
to db 0, which is live state written by something that only wanted to read a name.
`src/lib/shutdown.ts` drains the six workers on SIGTERM/SIGINT, installed from
`instrumentation.ts` in production only, because Next 16.2.12 exposes no shutdown hook
(`InstrumentationModule` is `register` and `onRequestError`, read from its own `.d.ts`);
the drain waits for in-flight Redis setup before closing, and disconnects rather than
quitting. Against a Redis that is not there at all the whole import-plus-drain sequence
exits 0 in 2001ms — the settle bound, not a hang. The names stay bare for the same
reason abetanalytics' does: `bull:send:*` etc. already hold jobs.

Two of those queues had nothing feeding them. Before this round dev db 0 held
exactly `bull:enrichment:meta`, `bull:analytics:meta` and `bull:warmup:meta`, which is
BullMQ's stored signature for a queue that has never received a job, while a Worker
polled each. `enrichment` is now produced by `POST /api/contacts`: a contact created
with an email and no company queues one job, and the worker writes the domain-derived
company (probed over HTTP on db 13: `...@northwind.example` came back `northwind`). A
public consumer address queues a job that writes nothing, because there is no
verification provider here (#56) and an unverified guess belongs in the column
campaigns send to even less than it belongs in the `{{company}}` a prospect reads.
`analytics` is produced by the three webhook routes that write an Activity, one job per
workspace-day under the key `analytics-<workspaceId>-<YYYYMMDD>`. That key is
deliberately colon-free and its job is coalescing, which is only half a guarantee: an
add that lands while the day's job is already running is dropped after that job has
read the window, so the rollup re-counts the window after writing and runs again if it
grew. Measured over HTTP with the fixed key alone, twelve `open` events left the row at
eleven; with the re-check, eighteen events left it at eighteen, one row, at local
midnight. `warmup` has an add site too, but until #57 it scheduled every sending
account onto *one* job. `scheduleWarmup` used
`add("run-warmup", { accountId }, { repeat: { pattern } })`, and bullmq derives the
legacy repeat key from `${name}:${jobId}:${endDate}:${tz}:${pattern}` (`repeat.js:170-177`,
read from source) — the job data is not an input, so `accountId` never reached the key and
two accounts collapsed onto one scheduler whose stored template named whichever asked first
(measured both orders on scratch db 13). It now upserts a per-account scheduler under the
colon-free key `warmup-<accountId>`, idempotent per account. Probed over HTTP on db 13
against the real route with two accounts minted on a copy of the dev db (the live one has 0
`SendingAccount` rows, which is why this never surfaced): `schedule-warmup` for each left
`bull:warmup:repeat` at `zcard 2`, each template carrying its own `accountId`, and
re-posting one account stayed at 2.

Five of those six queues then kept every job they finished, forever. Only `analytics`
bounded itself — since #54, `removeOnComplete`/`removeOnFail: true`, because its fixed
day id has to free up after a run or the day freezes. The other five added with no
retention, so each completed job, and each nightly warmup tick, left a hash in
`bull:<name>:completed` that nothing reads: no code in `src/` asks for `:completed`, and
the only consumer of queue state is `GET /api/health`, which counts waiting/active/failed
(read from source). The durable record of the work is SQLite, not the queue. The queues
now declare one retention default at construction: `removeOnComplete: true` and
`removeOnFail: 100`. Completed jobs go because they have no reader; failures stay, capped
at the hundred most recent per queue, because a sequence/enrichment/webhook failure
writes no error row anywhere else and the job hash is its only surviving record — 100 is
a chosen bound that survives a failure storm, not a tuned number. It is set on
`new Queue(...)` rather than in `enqueue` so it also covers the paths that bypass
`enqueue` — warmup's `upsertJobScheduler` and any direct `queues.X.add` — because bullmq
merges `{ ...defaultJobOptions, ...opts }` per add (`queue.js:199,236,266`) and a per-add
opt still wins, which is how `analytics` keeps its `removeOnFail: true`. Measured on
scratch db 13: three no-opt `enqueue` adds drained to zero `:completed` hashes while a
fourth job that threw was kept in `:failed` — the two halves of the policy, both from the
construction default alone (`queue.test.ts`, 41/41 with the probe).

Those three webhook routes also used to double-count. Each committed its `Activity`
row *before* the inline `enqueue(queues.sequence, …)`, which can throw
`QueueUnavailableError` and answer 503 — after the row is already durable. The
provider retries a 503, the retry re-inserted the row, and the rollup counted the same
open twice. Measured over HTTP: two byte-identical signed SendGrid `open` deliveries
took the day's `OPENED` count 0 → 1 → 2, both answering 200; a dead-Redis run showed the
`INSERT` committing and the request then stalling (`UND_ERR_SOCKET`, zero bytes read),
so the second delivery really does arrive against an already-written row. The fix is the
database-level idempotency gate the schema already trusts elsewhere (`User.email @unique`
for signup, `analyticsDaily.upsert`): `Activity.idempotencyKey String? @unique`, nullable
so pre-existing and internal NULL rows never collide (NULLs are distinct in both SQLite
and Postgres), written through `recordInboundActivity` in `src/lib/activities.ts`, which
returns null only on a P2002 unique clash and rethrows anything else. The key is
`channel:messageId:activityType:<provider event ms>` — the *provider's* timestamp, never
our clock, because a fresh `new Date()` would mint a new key on every retry and dedupe
nothing. EMAIL keys on the event time; the reply channels key on the message id alone
(one `REPLIED` per inbound message), and each route skips the rollup and sequence step
when the gate returns null — those ran on the delivery that won the insert. Guards live in
`tests/unit/activity-idempotency.test.ts` (18: the key's behaviour tested directly, the
route wiring read from comment-stripped source so a prose mention of the old call can't
satisfy them, three mutants — bare create, dropped timestamp, un-caught P2002 — each
biting). After-probe over HTTP on a migrated copy of the dev db, scratch db 13: redelivery
delta 0, a genuine second open (different provider timestamp) delta 1, both rows carrying
distinct keys. Migration `20261007000000_activity_idempotency_key` (a nullable column; the
dup-value warning Prisma prints is inert here because every existing row is NULL). Filed
separately as #65: driving the durable side effects across a *failed-then-retried* delivery
— the row committed but the inline enqueue did not, so a redelivery now correctly skips and
the sequence step never runs; re-deriving that step is a different problem from not
duplicating the row, and this round chose not to half-solve it.

`GET /api/analytics/:workspaceId?type=daily` wrote the very row it displayed, and nothing read
that row back. The `daily` branch called `aggregateAnalytics`, which reads a day's `Activity`
rows, recomputes the counters, **and** `analyticsDaily.upsert` — a GET with a write side effect
(#58), racing the `analytics` Worker for the same `@@unique([workspaceId, date])` key and
re-scanning the Activity table on every page load. That upsert at `analytics.ts:187` was also
the table's *only* touch anywhere in `src/` (read from source: a grep over `src/**` found no
`findUnique`/`findFirst`/`findMany` on `analyticsDaily`) — the rollup wrote `AnalyticsDaily` and
nothing read it (#59). So the GET now calls `getDailyAnalytics`, a reader that only
`analyticsDaily.findUnique`s the day bucket (`dayBucket(date)`, the same local-midnight
normalization `aggregateAnalytics` stores under), and the write lives solely in the Worker path
(`rollupDay` → `aggregateAnalytics`, produced by the three webhooks' `enqueueDailyRollup`). A
day with no row yet reads as zeros rather than a 404, because that is exactly what
`aggregateAnalytics` would have written for an empty window. Measured offline against a **copy**
of `dev.db`: a sentinel row (`opened 999`, values no Activity recompute produces) read back
byte-identical through a mid-day `?date=` argument, with `updatedAt` and row count unchanged by
the read (the reader writes nothing), then clobbered `999 → 0` by `aggregateAnalytics` run on the
same day — the write the GET no longer performs. Guarded in `tests/unit/queue.test.ts` ("the
analytics GET is a reader, not a second writer": the route calls `getDailyAnalytics` and never
`aggregateAnalytics`, the reader `findUnique`s and names no `upsert`/`create`/`update`, and
buckets on `dayBucket`; two mutants — the GET back on the compute path, the reader switched to
`upsert` — each biting to 36/1).
