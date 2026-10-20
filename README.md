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
cp .env.example .env        # DATABASE_URL points at the compose Postgres
docker compose up -d        # local Postgres 16
npx prisma migrate deploy   # applies the committed migrations
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
PATCH  /api/contacts/{id}                  # edit fields, set lifecycle status
POST   /api/contacts/{id}?action=enrich    # enrich on demand
GET    /api/contact-lists?workspaceId=     # lists
GET    /api/templates?workspaceId=         # message templates
GET    /api/sending-accounts?workspaceId=  # channel accounts + health
POST   /api/sending-accounts/{id}?action=warmup        # advance the warmup ramp one step
POST   /api/sending-accounts/{id}?action=schedule-warmup  # nightly warmup
GET    /api/enrollments/{id}               # one enrollment with its trail
POST   /api/enrollments                    # enroll a contact — only an ACTIVE
                                           # one; a dead status is a 409 that
                                           # names it (see *Contact lifecycle*)
GET    /api/analytics/{workspaceId}?type=overview|campaign|sequence|daily|attribution
POST   /api/abtests                        # create a running A/B test (2..10
                                           # variants, one control, weights sum
                                           # 100); the next enroll assigns arms
PATCH  /api/abtests/{id}                   # pause, resume, or complete (naming
                                           # a winner stamps its confidence —
                                           # two-proportion z; COMPLETED terminal)
POST   /api/webhooks                       # subscribe; deliverable events are
                                           # the three the product emits
                                           # (see *Webhooks (outbound)*)
POST   /api/webhooks/email|whatsapp|linkedin  # provider event receivers —
                                             # require x-inbound-timestamp and
                                             # x-inbound-signature (HMAC, see
                                             # src/lib/inbound-webhooks.ts)
POST   /api/ai/draft-reply                 # draft a reply; human sends
```

Sending accounts carry daily limits and reputation scores; the engine skips
spent or low-reputation accounts rather than burning a domain. Warmup is a
real send cap, not a countdown: a warming account sends at most 5/day, and
each nightly pass raises the cap by 5 until the account reaches its own
daily limit. The cap counts what the day committed, not what the worker has
finished reporting: a row is spent the moment it is created — while it sits
`QUEUED` with its send job in flight, and after a provider receipt relabels
it `BOUNCED` or `COMPLAINED` — because a bounce that freed capacity for the
next email would reward exactly the traffic the ramp exists to throttle. Only
a dispatch `FAILED`, where nothing left the account, gives the day back.
Bounces and complaints pause the enrollment
automatically — deliverability is enforced in code, not in a runbook. The
spacing those guards exist for is enforced too: the waits between steps are
read back every minute by the `leadgenius-scheduled` sweep (see *Putting it
somewhere*), so a four-step sequence arrives as four emails on four days.

LinkedIn has no feedback loop — no webhook will ever tell us a prospect
closed their account — so the send-time rejection is the only words this
channel will ever give, and it is now read as such. A rejection that names
the recipient (`Contact has no LinkedIn URL`, an unresolvable member URN, an
API 400/404 that says *recipient*) writes exactly the lifecycle the email
bounce webhook writes: a `BOUNCED` activity, a `BOUNCED` enrollment, a
`BOUNCED` contact the enroll guard then refuses. A rejection that names our
token (401), the rate limiter (429) or the day (5xx) accuses nobody: the row
keeps its failure and nothing else moves. The API host is the operator's
`LINKEDIN_API_BASE`, never a caller-supplied address — the fleet's egress
guard refuses a `fetch` whose URL the request can move. Reputation is now
a derived number too: `reputationScore` used to be written by no code path
at all — every account sat at the schema default of 100, and the gate's
floor could never refuse anything the copy said it would. The score is the
account's own deliverability rate over a rolling 14-day window (a spam
complaint counts triple a bounce), recomputed on every event that changes
the ledger — the send worker's flip, the provider webhooks' relabels — and
by a throttled pass the minute-sweep carries, so an account the floor has
gated out can age back in on the calendar with no new sends at all. The
health panel counts through the same window: its `reputation` and its
sent/bounced/complained readings come from one ledger, not two. Selection
order says who is *tried* first, not who is exempt: the account the operator
flagged `isDefault` (the routes keep exactly one per channel, and the column
has long had its index) rides before its siblings — until the same cap and
floor judge it, at which point the best remaining account carries and the
default waits for its day back.

## Attribution (read-only)

`GET /api/analytics/{workspaceId}?type=attribution&days=14` answers the question a
campaign review actually asks — *which channel and which A/B arm earned the replies* —
from the same `Activity` rows the daily engine rolls up (`src/lib/attribution.ts`).
Channel comes from the event's own `channel` column, not the sequence's: a MULTI
sequence sends email *and* WhatsApp, and grouping by the sequence would ask "which
channel" of a row that used both. Both ends of the window snap to local midnight —
the same bucketing `AnalyticsDaily` stores under — because a partial day cannot be
compared honestly.

The response carries a `drift` array: every counter where the raw fold and the
materialized rollup disagree. They match by construction, so a nonzero drift means a
rollup job is missing or short (the #65 queue-outage path) — the disagreement is
surfaced rather than hidden. The dashboard shows all of this to a signed-in session
under **“What is working”** (7/14/30-day windows), through a server action whose
workspace comes from the session, never the form — the `createFirstKey` rule. The
grouping arithmetic is pure (`foldAttribution`, `diffCounters`) and pinned without a
database in `tests/unit/attribution.test.ts`.

The `sent` counter has two possible sources, and both are wired: the send worker
records its own `SENT` activity the moment a provider accepts the message — keyed on
the message id alone, since no provider event time exists yet — and the email webhook
reads for that row before inserting on a provider `sent`/`accepted`/`processed`
event, so the provider event **corroborates the send instead of double-counting it**.
Either way a real send yields exactly one `SENT` row, so attribution and the daily
rollup agree with each other and with the traffic.

## A/B tests (assignment)

`POST /api/abtests` creates a test and starts it — `status: "RUNNING"` from the
first breath, because a DRAFT row no enroll ever read is the state this table
was already in. The body is `{ campaignId, name, hypothesis, variants }` with
2..10 variants; each variant names a `sequenceId` (and optionally a
`templateId`) that must exist in the workspace, and the cross-entry rules —
unique names, exactly one `isControl`, weights summing to exactly 100 — are
checked in `validateAbTestSemantics` (`src/lib/abtest.ts`), which is where
they belong: a field validator that sees one entry at a time cannot see them.

The assignment happens at enrollment, and it is deterministic:
`assignVariant` hashes `sha256(abTestId : contactId)` and walks the variants'
cumulative weights. Not a draw — a draw would let a retried enroll hop arms and
contaminate the cohort, and the hash is salted with the test id so the same
contact lands independently in different tests. The distribution is pinned to
measured values in `tests/unit/abtest.test.ts` (exact per-arm counts over 2000
synthetic contact ids), not to "roughly 50/50".

When a RUNNING test covers the campaign, the enrollment takes the **arm's**
sequence instead of the one the request named, and records `abVariantId` on the
row — which is what makes attribution's `byVariant` table real rather than
honestly empty. An arm whose sequence was deleted or emptied since the test was
created answers `409` with the arm's name: pausing the test is the fix, silently
enrolling everyone into the fallback arm is not.

The two variant fields divide the labour: `sequenceId` sends a different
*track*, `templateId` sends different *copy down the same one*. When a variant
carries a template, every step of that arm renders from it — subject included —
and the `SentMessage` records the template it was actually rendered from, not
the step's. A template that a sequence step or a test's arm still references
**cannot be deleted** — `DELETE /api/templates/{id}` answers 409 naming the
sequence and step (or the test and arm). The refusal lives at the delete on
purpose: both references are optional foreign keys whose database action is
`SetNull`, so deleting the row would erase the reference before any send could
see it — the arm would fall back to the step's copy and silently convert its
cohort, and a step would send placeholder copy no one chose.

`PATCH /api/abtests/{id}` is the lifecycle the other error messages promise.
RUNNING ↔ PAUSED stops and restarts arm assignment — the enroll route reads
only RUNNING tests, and enrollments made while paused join no cohort (that is
the point of pausing). COMPLETED is terminal and names the winner: it must be
one of the test's own variant names, `completedAt` is stamped, and re-opening
is refused with 409 — the cohorts are what the verdict was decided on.
Completing *with* a winner also stamps `confidence`: a two-proportion z on the
winner's and the control's reply rate, counted live from their Activity rows
scoped by **variant id** — not the name-keyed `byVariant` rollup, which merges
cohorts across tests that share arm names. A winner or control that recorded no
sends is refused with 409: a verdict with no email in either arm is not
evidence. A negative z is stamped rather than hidden — it means the "winner"
replied *less* than control on its own numbers.
`DRAFT` is the column's default but not a transition target: nothing reads it,
nothing wrote it, and "return to before the test existed" is not a lifecycle.

## Contact lifecycle stops outreach

`Contact.status` is `ACTIVE | BOUNCED | UNSUBSCRIBED | DO_NOT_CONTACT`, set
with `PATCH /api/contacts/{id}` — and it is not decoration.
`POST /api/enrollments` refuses a contact the workspace marked dead with a 409
naming the status; that refusal is the "not spam complaints" half of this
product's sentence. A status can also change *between* two ticks of the
minute-sweep, so `processSequenceStep` checks it before any trigger gets a step
scheduled and stops the enrollment through `stopStatusForContact`: bounced
contact → `BOUNCED` enrollment, unsubscribed contact → `UNSUBSCRIBED` — the
same rows the provider webhook writes when the real bounce or unsubscribe
arrives — and `DO_NOT_CONTACT` → `PAUSED`, because completing fires the CRM's
`sequence.completed` signal and a refusal must not announce itself as a
finished send. ACTIVE contacts run as before.

The other direction is true too: the provider signals *write* that column, so
the sentence above is a fact rather than an analogy. A webhook `bounce`,
`spamreport` or `unsubscribe` stamps the contact through
`statusAfterProviderSignal` — bounce → `BOUNCED`, complaint or unsubscribe →
`UNSUBSCRIBED` — and marks only an `ACTIVE` contact, so an operator's
`DO_NOT_CONTACT` is never erased by a provider event and a second signal on an
already-marked address changes nothing. Before this, a webhook bounce flipped
the enrollment but left the contact `ACTIVE`, and the guard above happily
opened the door to a brand-new enrollment for the same dead address;
`unsubscribe` flipped nothing at all. The stamp reverts with the
enrollment flip if the queue is unavailable, so a redelivered event replays
the whole side effect rather than half of it.

WhatsApp gets the same treatment from Twilio's *delivery-status* callbacks,
which share the inbound-message route and its `MessageSid`: `undelivered` is
always this channel's bounce, `failed` counts only when the error code names
the recipient (an invalid number, no WhatsApp account, a blocked message —
`providerSignalFromDeliveryStatus` keeps the codes that name our sender or the
carrier's bad day off the contact, and an unseen code defaults to marking
nobody). Those callbacks used to be matched as messages: their `From` is our
own sending number, so the contact lookup missed and every delivery failure
became a silent `200`. A failure now writes the same three rows the email
bounce writes — `BOUNCED` message and enrollment, stamped contact — under the
same idempotency and revert rules. The same callbacks also carry the funnel
half: `delivered` writes a `DELIVERED` Activity and `read` (or `reading`) an
`OPENED`, through the same dispatch, the same `#60` key and the same reverts —
just without the status flips, because the message got through. Until then a
WhatsApp step could only ever be *sent*: `hasOpen` and the attribution counters
key on the Activity row, not the channel, so a follow-up guarded `no_open`
would nag someone reading their phone two feet away, and no dashboard could
show a WhatsApp open. `queued` and `sent` still write nothing — they
corroborate the `SENT` we record ourselves, and the lifecycle table owns
failures.

## Webhooks (outbound)

`POST /api/webhooks` takes `{ workspaceId, url, events }` and answers `201`
with the created subscription and its `secret`. A subscription can name only
the events this product emits — an unknown name is refused with the list
rather than stored, because a subscription filtered on a name nothing sends
is the same silence as no subscription at all:

| Event | Fires when |
|---|---|
| `contact.created` | a contact is created through `POST /api/contacts` |
| `reply.received` | a LinkedIn or WhatsApp reply is recorded |
| `sequence.completed` | an enrollment reaches the end of its sequence |

Each delivery is a JSON body `{ id, event, timestamp, data }`, signed
HMAC-SHA256 over the raw body with the subscription's secret, under two
headers carrying the same digest: `X-LeadGenius-Signature: <hex>` (this
product's spelling) and `X-Webhook-Signature: sha256=<hex>`. The second is the
generic spelling a nuCRM plugin webhook verifies out of the box — point one at
`/api/tenant/plugins/webhook/{id}` with the same secret and nuCRM accepts the
call with no adapter in between. `id` names the logical event; a receiver that
deduplicates on it is already correct on the day delivery grows retries.

Delivery is one attempt, best-effort and never throwing: a receiver that is
down is logged and skipped, and never fails the contact create or the reply
ingest that emitted the event. `tests/unit/webhook-events.test.ts` pins the
wiring — an event declared without an emitter, or an emitter that loses its
call site, fails the suite.

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

`checkout` takes `{ priceId: "USER_MONTHLY" | "USER_ANNUAL", returnUrl }` — the quantity is `seatUsage`, the same count the invite gate enforces: everyone in the workspace *plus* the links still outstanding, so the invoice opens at the size of the team rather than at the number of people who have accepted so far. A 409 answers a workspace the row says is already trialing, active or past due: another checkout would be another subscription, and nothing cancels the one Stripe is already charging, so seats and billing period change in the portal instead. The `/pricing` page reads the same row before it sells anything: a billed workspace sees its plan named with the renewal date the row carries, its own card marked *Your plan* and the other turned into a portal link, and the intro says what checkout will actually bill — the team, counted as members plus outstanding invites, so the number on the page and the number on the invoice are the same number. The webhook verifies the Stripe signature and syncs `checkout.session.completed`, `customer.subscription.*`, and `invoice.payment_failed` into the `Subscription` row. Setup: create the two prices in Stripe, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_USER_MONTHLY`, `STRIPE_PRICE_USER_ANNUAL`, forward webhooks with `stripe listen --forward-to localhost:3200/api/billing/webhook`. Signature checks are unit-tested offline in `tests/unit/billing.test.ts`.

The seat count is metered, not just billed. Every sync writes Stripe's line-item
quantity into `Subscription.stripeSeats` (migration
`20261013000000_add_subscription_seats`), and `src/lib/seats.ts` compares it with
the people who would occupy a seat — members plus live, unaccepted invitations,
because a pending link is a seat already promised. `createInvite` refuses the
moment a *new* address would pass the cap; rotating an existing link is free,
since it replaces a seat already counted. `/members` shows the same number before
anyone hits it, in amber at the cap, next to the portal button where another seat
is one click. A workspace whose `stripeSeats` is null — a row written before the
column existed — is never metered at zero: the check fails open, and the next
sync closes it.

Every paid plan opens with a 14-day card-up trial (`trial_period_days` on the subscription), so the first invoice is dated two weeks out and the dashboard banner counts the days down to it. Two warnings are armed off the webhook that confirms the trial — delayed BullMQ jobs on `leadgenius-billing`, at three days left and one day left — and each one re-reads the `Subscription` row before it mails: a workspace that already converted, cancelled, or had its trial moved gets silence rather than a wrong date. Arming is best-effort in the same shape as every other mail here, so with Redis down the webhook still answers 200 and no nudge is sent; `REDIS_URL` has to point somewhere real for these to arrive. The job id names the trial period, so a Stripe webhook retry cannot double-send. A cancellation is answered the same way: `customer.subscription.deleted` arms a confirmation (no further charge, nothing deleted) and one win-back mail seven days later, both on the same `-billing` queue. Those two are keyed on the Stripe subscription id rather than the workspace, because a subscription is deleted exactly once — a re-delivered event cannot double-send, while a buyer who comes back and leaves again is a new subscription and gets a new pair. Each mails only if the row still says `canceled` *for that subscription id*: a workspace that returned is not a churn risk, and telling a paying customer they are gone is worse than saying nothing. Every billing mail that has to go looking for a person — dunning, conversion, nudge, cancellation, win-back — is addressed by the same `ownerOf` query: the oldest `OWNER` membership, which is the account that ran checkout. Not the Stripe customer, which `ensureCustomer` creates with an empty email. The receipt is the exception, and a good one: its address is the one the buyer typed into the checkout page, so it needs no lookup. The conversion mail is the one that fails quietly, inside a `try`/`catch` that logs: by the time it would be sent the sync has already overwritten the status that made the transition visible, so the retry a non-200 buys has nothing left to announce — a loud failure there deletes the mail rather than delaying it. A declined-payment notice keeps the opposite shape, because nothing is consumed by sending it: if the lookup fails the webhook fails, and Stripe's retry delivers the mail.

## Putting it somewhere

```bash
npm ci
npm run db:deploy
npm run build
npm start
```

Point the load balancer at `GET /api/health` (200 = serving, 503 = DB down).
Queue workers (`src/lib/queue.ts`, BullMQ + Redis) drain send, sequence,
enrichment, webhook, analytics, warmup and leadgenius-billing queues. For Postgres, follow the
same three steps as abetConnect: provider switch, fresh migration history,
regenerate. Each of the seven Queues is built on first touch rather than at import:
constructing one connects to Redis even on a `lazyConnect` client, so importing the
module wrote six `bull:<name>:meta` keys — measured on the pre-fix module against a
scratch db, rc=124 (never exited) with all six left behind, and dev `REDIS_URL` defaults
to db 0, which is live state written by something that only wanted to read a name.
`src/lib/shutdown.ts` drains the seven workers on SIGTERM/SIGINT, installed from
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

Sequences never sent a follow-up. Two halves, both measured before either was
fixed: a step whose condition is a *wait* (`no_reply`, `no_open`, `no_click` — each
written to require `triggerType === "TIME_ELAPSED"`) could never be satisfied, because
no caller anywhere in `src/` produced that value; and a step with *no* condition was spent
by the `SENT` job the send worker queues the moment the previous message leaves, so
`delayDays: 3` meant three seconds. `Enrollment.nextActionAt` was the column the engine
already wrote at the end of every step and `prisma/schema.prisma` already indexed
(`@@index([nextActionAt])`) — it just had no reader. So `scheduler.ts:runDueSequenceSteps`
is that reader: one indexed range scan (`status: "ACTIVE"`, `nextActionAt` recorded and in
the past), oldest-first, bounded at 100 rows per tick, each row evaluated in its own
`try`/`catch` and all of them handed the *same* `now` the scan decided with. The engine's
half is `stepIsDue(nextActionAt, now)`, consulted only when a step has no condition of its
own — event triggers (`REPLIED`, `BOUNCED`, `CLICKED`) still act on events, so fixing the
cadence does not cost reply automation. A `null` wait means nothing is scheduled, which is
how a brand-new enrollment still gets its first email immediately rather than after a delay
it never asked for. Paused rows are excluded by the *clause*, not left for the engine to
decline: a sweep that selected them would re-read, re-decline and re-log every paused
enrollment in the database once a minute for as long as the buyer left it paused, and
pausing mid-flight is the one thing they are entitled to do. It rides `leadgenius-scheduled`
— product-prefixed, because the six bare names above are bare only because renaming them
would orphan keyspaces that already hold jobs — under the fixed scheduler key
`leadgenius-scheduled-sweep` on `* * * * *`, so N boots leave one schedule rather than N. A
scheduler rather than `setInterval` for the same reason: `register()` runs on every boot, and
a timer would fire this scan once per process per minute and send the same follow-up that many
times. The worker is concurrency 1 — two overlapping ticks would each read a due row the other
has not yet moved — and registration happens last and bounded by the vendored
`awaitWithRegistrationTimeout` (§8.55), because against a Redis that answers nothing
`upsertJobScheduler` does not reject, it never settles, and an unbounded await there hangs the
boot rather than merely losing the schedule. Why a scan instead of one delayed job per step:
`PATCH /api/enrollments/:id` has exactly one writable field, `nextActionAt`, and a delayed job
sits in Redis where that edit cannot reach it — a scan reads the column the engine writes, so
the pause/reschedule control means something again, rows written before this change are covered,
and a retry cannot mint a fresh due date from a second clock. Guards in
`tests/unit/sequence-sweep.test.ts` (27). After-probe on a **copy** of `dev.db` and Redis db 13:
the due row was spent (2 messages created by the pass, the enrollment left at
`currentStep` 2 with a `nextActionAt` three days out),
a tenant with no sending account evaluated first and did not stop the pass (2 of 2 due rows),
the PAUSED enrollment was untouched, a `SENT` trigger produced 0 messages against an
unconditional step still inside its wait, an `ENROLLED` trigger produced 1 (the first email is
not made to wait), registering twice left exactly one scheduler, and a plain boot with no caller
spent a due enrollment on its own after 3s. On that same copy the shipped data reads 0 ACTIVE
enrollments sitting on an ended wait, 0 steps with conditions and 0 `SendingAccount` rows — which
is why this went unnoticed: nothing configured in the dev workspace could show it, while every
real campaign's second email was silently never sent.

## A condition decides both ways

`conditions` on a sequence step is the product's "branch conditions" sentence,
and round #23 made the satisfied half true. This round is the other half,
found by *using* the first one: `{if: "no_open", then: "end"}` finally ended
the unread — and parked the opened. `stepOutcome` answered an unsatisfied
condition with `wait`, and for a wait-condition that tick never comes again:
the sweep re-reads the same overdue row every minute and declines it forever,
silently, ACTIVE, with no next action and nothing to tell anyone. "Nudge the
readers, end the unread" — the plainest sentence in sales engagement — was
inexpressible.

`conditions.elseThen` is that sentence. The satisfied branch runs `then` as
before; the unsatisfied one runs `elseThen` where defined, and two disciplines
keep it honest. Only the sweep's `TIME_ELAPSED` tick consults the else: an
event trigger firing it would spend the step ahead of its calendar — a read
receipt at 8pm must not send tomorrow's nudge tonight, which is the same
`delayDays` promise the sweep was built to keep. And `elseThen` is accepted
only on the wait conditions (`no_reply`, `no_open`, `no_click`): the else of
`replied` is "this event did not just happen", true of every other trigger, so
an event-condition else would fire the step on the first unrelated callback.
The else menu is `next`/`skip`/`end` with no `branch` — a second
`branchToStep` vocabulary is a bigger surface than the direction it would
serve. `conditionProblem` (the write-time twin, 400 at create) refuses
off-menu actions and event-condition elses by naming the sets; `stepOutcome`
throws again at run time, because rows outlive the request that validated
them. No `elseThen` is exactly the old behavior, so every stored sequence keeps
what its author configured — the guard is in the known answers: `{if:
"no_open", then: "end"}` with `opened` still waits.

Live, the two halves become a control pair: two contacts, one
`{if: "no_open", then: "end", elseThen: "next"}` step, one rewound clock, and
the only difference is a signed WhatsApp `read` from the previous round's
callback — the reader gets the nudge, the unread's run ends, and both
decisions were made by the same line of the same pure function on the same
tick.
