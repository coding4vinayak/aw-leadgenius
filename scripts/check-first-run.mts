/**
 * The first run — run with:  npm run check:first-run
 *
 * WHY THIS EXISTS
 *
 * A new workspace used to start on an empty dashboard whose only advice was
 * "No campaigns yet. Create one via `POST /api/campaigns`" — advice for a
 * buyer who already writes code. So a new workspace now gets one worked
 * example, and one click that takes it away again.
 *
 * The unit tests cover the example itself (its templates declare only the
 * names their text uses, its subject fits its channel, its merge values are
 * the ones the send needs, its contacts are on a reserved domain). They
 * cannot cover the two things that are easiest to get wrong and most
 * expensive to get wrong:
 *
 *   1. **Idempotency.** A double-click must not stack two copies of the same
 *      campaign, and a retried request must not either.
 *   2. **Removal scope.** "One click" must never mean "and your data too".
 *
 * So this script builds a throwaway database on the configured Postgres from
 * the committed migrations, loads the example, loads it again, adds a campaign
 * of the customer's own, removes the example, and checks what is left.
 *
 * Needs a reachable Postgres: docker compose locally, the service container in
 * CI.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let passed = 0;
const failures: string[] = [];

function ok(label: string, condition: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    ok(label, true);
  } else {
    ok(`${label} — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`, false);
  }
}

// A per-run database on the configured server, so parallel or crashed runs never
// collide and the drop at the end is the whole cleanup. CREATE DATABASE cannot run
// inside a transaction, which is why this is a plain pool and not the app client.
const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://leadgenius:leadgenius@localhost:5432/leadgenius";
const scratchName = `check_first_run_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const server = new Pool({ connectionString: baseUrl });
await server.query(`CREATE DATABASE "${scratchName}"`);

const scratchUrl = (() => {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${scratchName}`;
  parsed.searchParams.delete("schema");
  return parsed.toString();
})();
process.env.DATABASE_URL = scratchUrl;

// The schema a deploy would create, from the committed migration history.
execFileSync(path.join(ROOT, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
  cwd: ROOT,
  env: process.env,
  stdio: "ignore",
});

const { prisma } = await import("../src/lib/db");
const {
  EXAMPLE_CAMPAIGN_NAME,
  EXAMPLE_CONTACT_EMAILS,
  EXAMPLE_SEQUENCE_NAME,
  loadExampleCampaign,
  removeExampleCampaign,
} = await import("../src/lib/example-campaign");

try {
  const workspace = await prisma.workspace.create({
    data: { name: "First-run check", slug: `first-run-${Date.now()}` },
  });

  // ── the first load ─────────────────────────────────────────────────────
  const first = await loadExampleCampaign(workspace.id);
  eq("the first load creates the example", first.created, true);
  eq("…with one campaign", await prisma.campaign.count({ where: { workspaceId: workspace.id } }), 1);
  eq("…one sequence", await prisma.sequence.count({ where: { workspaceId: workspace.id } }), 1);
  eq("…two templates", await prisma.template.count({ where: { workspaceId: workspace.id } }), 2);
  eq("…five contacts", await prisma.contact.count({ where: { workspaceId: workspace.id } }), 5);
  eq("…and three enrollments", await prisma.enrollment.count({ where: { campaign: { workspaceId: workspace.id } } }), 3);

  const campaign = await prisma.campaign.findFirst({
    where: { workspaceId: workspace.id },
    include: { sequences: { include: { sequence: { include: { steps: true } } } } },
  });
  eq("the campaign is the example's", campaign?.name, EXAMPLE_CAMPAIGN_NAME);
  eq("…and it is a draft, so nothing sends", campaign?.status, "DRAFT");
  eq("…with the sequence beside it", campaign?.sequences[0].sequence.name, EXAMPLE_SEQUENCE_NAME);
  eq("…and three steps to walk", campaign?.sequences[0].sequence.steps.length, 3);

  const contacts = await prisma.contact.findMany({ where: { workspaceId: workspace.id } });
  eq(
    "every contact is on a reserved domain",
    contacts.every((c) => c.email?.endsWith("@example.com")),
    true,
  );
  eq(
    "and one of them is marked bounced, because the lifecycle column is part of the product",
    contacts.filter((c) => c.status === "BOUNCED").length,
    1,
  );

  // ── the second load must not stack a copy ──────────────────────────────
  const second = await loadExampleCampaign(workspace.id);
  eq("a second load changes nothing", second.created, false);
  eq("…there is still one campaign", await prisma.campaign.count({ where: { workspaceId: workspace.id } }), 1);
  eq("…still three enrollments", await prisma.enrollment.count({ where: { campaign: { workspaceId: workspace.id } } }), 3);

  // ── the removal must not touch anything else ───────────────────────────
  const own = await prisma.campaign.create({
    data: { workspaceId: workspace.id, name: "My real campaign", goal: "ship it", status: "ACTIVE" },
  });
  const ownSequence = await prisma.sequence.create({
    data: { workspaceId: workspace.id, name: "My real sequence", channel: "EMAIL", stepsConfig: [] },
  });

  const removed = await removeExampleCampaign(workspace.id);
  eq("the removal removes the example", removed.removed, 1);
  eq("…and counts the enrollments it took with it", removed.enrollments, 3);

  const left = await prisma.campaign.findMany({ where: { workspaceId: workspace.id } });
  eq("the customer's own campaign is still there", left.length, 1);
  eq("…and it is theirs", left[0].id, own.id);
  eq("the example is gone", left.some((c) => c.name === EXAMPLE_CAMPAIGN_NAME), false);
  eq("its enrollments are gone", await prisma.enrollment.count({ where: { campaign: { workspaceId: workspace.id } } }), 0);
  eq("its contacts are gone", await prisma.contact.count({ where: { workspaceId: workspace.id } }), 0);
  eq("its templates are gone", await prisma.template.count({ where: { workspaceId: workspace.id } }), 0);
  eq("its sequence is gone", await prisma.sequence.count({ where: { workspaceId: workspace.id, name: EXAMPLE_SEQUENCE_NAME } }), 0);
  eq("the customer's own sequence is still there", await prisma.sequence.count({ where: { id: ownSequence.id } }), 1);

  // ── and removing what is not there is a no-op ──────────────────────────
  const again = await removeExampleCampaign(workspace.id);
  eq("removing it twice removes nothing the second time", again.removed, 0);
  eq("…and the customer's campaign is still there", await prisma.campaign.count({ where: { workspaceId: workspace.id } }), 1);
} finally {
  await server.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await server.end();
}

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`\n  Failed: ${failures.join("; ")}`);
  process.exit(1);
}
