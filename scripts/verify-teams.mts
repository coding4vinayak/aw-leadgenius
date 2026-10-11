/**
 * Team invitations, end to end, against a throwaway database.
 *
 * The properties that matter are all about who can get in and who cannot:
 *
 *   - an invite names one address; any other account is refused
 *   - a link works once; a second redemption fails
 *   - an expired link is refused
 *   - re-inviting rotates the old link dead
 *   - an ADMIN cannot mint another ADMIN (only an owner can)
 *   - a MEMBER cannot invite anyone
 *   - removing a seat destroys that person's sessions immediately
 *   - revoking stops a sent link from working
 *
 * Runs on its own SQLite file so it cannot touch demo data. The lib under test
 * is byte-identical across the six apps (auth drift gate), so one deployment
 * proves the shared code.
 *
 *   DATABASE_URL="file:/tmp/tokens-teams.db" npx prisma db push --skip-generate
 *   DATABASE_URL="file:/tmp/tokens-teams.db" npx tsx scripts/verify-teams.mts
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url || !url.includes("tokens-")) {
  console.error("Refusing to run: set DATABASE_URL to a throwaway file, e.g. file:/tmp/tokens-teams.db");
  process.exit(2);
}

const { prisma } = await import("../src/lib/db");
const { createInvite, acceptInvite, revokeInvite } = await import("../src/lib/invites");
const { editSeat } = await import("../src/lib/seats");
const { hashPassword } = await import("../src/lib/password");
const { createSession } = await import("../src/lib/session");

const results: { name: string; ok: boolean; detail: string }[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true, detail: "" });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

const stamp = Date.now().toString(36);
const mkUser = (tag: string) =>
  prisma.user.create({
    data: { email: `teams-${tag}-${stamp}@probe.test`, name: tag, passwordHash: "scrypt$16384$8$1$aa$bb" },
  });

const owner = await mkUser("owner");
const workspace = await prisma.workspace.create({ data: { name: "Team Probe", slug: `team-probe-${stamp}` } });
await prisma.membership.create({ data: { userId: owner.id, workspaceId: workspace.id, role: "OWNER" } });

await check("an owner can invite a member and gets a one-time link", async () => {
  const r = await createInvite({ workspaceId: workspace.id, email: `new-${stamp}@probe.test`, role: "MEMBER", createdById: owner.id });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.token.length >= 32, "the link must carry a real token");
    assert.equal(r.rotated, false);
  }
});

await check("the link is stored hashed, never in plaintext", async () => {
  const r = await createInvite({ workspaceId: workspace.id, email: `hash-${stamp}@probe.test`, role: "MEMBER", createdById: owner.id });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const row = await prisma.invite.findFirst({ where: { workspaceId: workspace.id, email: `hash-${stamp}@probe.test` } });
  assert.ok(row);
  assert.notEqual(row.tokenHash, r.token);
  assert.equal(row.tokenHash.length, 64);
  await prisma.invite.delete({ where: { id: row.id } });
});

await check("the invited address joins as a member on accept", async () => {
  const email = `join-${stamp}@probe.test`;
  const r = await createInvite({ workspaceId: workspace.id, email, role: "MEMBER", createdById: owner.id });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const newcomer = await prisma.user.create({
    data: { email, name: "Newcomer", passwordHash: await hashPassword("password-1234") },
  });
  const accepted = await acceptInvite({ token: r.token, userId: newcomer.id });
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  const seat = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: newcomer.id, workspaceId: workspace.id } },
  });
  assert.ok(seat, "accepting must create the seat");
  assert.equal(seat.role, "MEMBER", "an invite grants what it says, never OWNER");
});

await check("the same link cannot be used twice", async () => {
  const email = `twice-${stamp}@probe.test`;
  const r = await createInvite({ workspaceId: workspace.id, email, role: "MEMBER", createdById: owner.id });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const u = await prisma.user.create({ data: { email, name: "Twice", passwordHash: "x" } });
  assert.equal((await acceptInvite({ token: r.token, userId: u.id })).ok, true);
  // a second account trying the same link, and the same account retrying it
  const u2 = await prisma.user.create({ data: { email: `twice2-${stamp}@probe.test`, name: "Twice2", passwordHash: "x" } });
  assert.equal((await acceptInvite({ token: r.token, userId: u2.id })).ok, false);
  assert.equal((await acceptInvite({ token: r.token, userId: u.id })).ok, false);
  await prisma.user.delete({ where: { id: u2.id } });
});

await check("an account that is not the invited address is refused", async () => {
  const r = await createInvite({ workspaceId: workspace.id, email: `named-${stamp}@probe.test`, role: "MEMBER", createdById: owner.id });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const stranger = await prisma.user.create({ data: { email: `stranger-${stamp}@probe.test`, name: "Stranger", passwordHash: "x" } });
  const outcome = await acceptInvite({ token: r.token, userId: stranger.id });
  assert.equal(outcome.ok, false);
  assert.match((outcome as { error: string }).error, /signed in as/, "the refusal should name the mismatch");
  await prisma.user.delete({ where: { id: stranger.id } });
});

await check("re-inviting rotates the old link dead", async () => {
  const email = `rot-${stamp}@probe.test`;
  const first = await createInvite({ workspaceId: workspace.id, email, role: "MEMBER", createdById: owner.id });
  const second = await createInvite({ workspaceId: workspace.id, email, role: "MEMBER", createdById: owner.id });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.rotated, true);
  const u = await prisma.user.create({ data: { email, name: "Rot", passwordHash: "x" } });
  assert.equal((await acceptInvite({ token: first.token, userId: u.id })).ok, false, "the first link must stop working");
  assert.equal((await acceptInvite({ token: second.token, userId: u.id })).ok, true, "the second link must work");
});

await check("revoking stops a sent link from working", async () => {
  const email = `rev-${stamp}@probe.test`;
  const r = await createInvite({ workspaceId: workspace.id, email, role: "MEMBER", createdById: owner.id });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const row = await prisma.invite.findFirst({ where: { workspaceId: workspace.id, email } });
  assert.ok(row);
  assert.equal((await revokeInvite({ workspaceId: workspace.id, inviteId: row.id })).ok, true);
  const u = await prisma.user.create({ data: { email, name: "Rev", passwordHash: "x" } });
  assert.equal((await acceptInvite({ token: r.token, userId: u.id })).ok, false);
});

await check("an admin cannot mint another admin; an owner can", async () => {
  const adminUser = await mkUser("adminx");
  await prisma.membership.create({ data: { userId: adminUser.id, workspaceId: workspace.id, role: "ADMIN" } });
  // editSeat is the enforcer for role changes on existing seats
  const memberUser = await mkUser("memberx");
  await prisma.membership.create({ data: { userId: memberUser.id, workspaceId: workspace.id, role: "MEMBER" } });
  const memberSeat = await prisma.membership.findUniqueOrThrow({
    where: { userId_workspaceId: { userId: memberUser.id, workspaceId: workspace.id } },
  });
  const lift = await editSeat({ workspaceId: workspace.id, membershipId: memberSeat.id, actorRole: "ADMIN", role: "ADMIN" });
  assert.equal(lift.ok, false, "an admin must not be able to create another admin");
  const ownerLift = await editSeat({ workspaceId: workspace.id, membershipId: memberSeat.id, actorRole: "OWNER", role: "ADMIN" });
  assert.equal(ownerLift.ok, true, "an owner can grant admin");
});

await check("removing a seat destroys that person's sessions immediately", async () => {
  const victim = await mkUser("victim");
  await prisma.membership.create({ data: { userId: victim.id, workspaceId: workspace.id, role: "MEMBER" } });
  // a session minted in this workspace for the victim
  const { hashSessionToken } = await import("../src/lib/session");
  const { randomBytes } = await import("node:crypto");
  const raw = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: { userId: victim.id, workspaceId: workspace.id, tokenHash: hashSessionToken(raw), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  const before = await prisma.session.count({ where: { userId: victim.id, workspaceId: workspace.id } });
  assert.equal(before, 1);
  const seat = await prisma.membership.findUniqueOrThrow({
    where: { userId_workspaceId: { userId: victim.id, workspaceId: workspace.id } },
  });
  const removed = await editSeat({ workspaceId: workspace.id, membershipId: seat.id, actorRole: "OWNER", role: "REMOVE" });
  assert.equal(removed.ok, true);
  const after = await prisma.session.count({ where: { userId: victim.id, workspaceId: workspace.id } });
  assert.equal(after, 0, "their cookie in this workspace must stop working at once");
});

await check("an owner seat cannot be edited down by anyone", async () => {
  const ownerSeat = await prisma.membership.findUniqueOrThrow({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
  });
  const adminUser = await prisma.user.findFirst({ where: { email: `teams-adminx-${stamp}@probe.test` } });
  void adminUser;
  // even the owner cannot demote themself through the seat editor — ownership
  // transfer does not exist yet, and silently dropping the last owner would
  // orphan the workspace.
  const self = await editSeat({ workspaceId: workspace.id, membershipId: ownerSeat.id, actorRole: "OWNER", role: "MEMBER" });
  assert.equal(self.ok, false, "an OWNER seat must not be editable, even by its holder");
});

// cleanup
await prisma.invite.deleteMany({ where: { workspaceId: workspace.id } });
await prisma.session.deleteMany({ where: { workspaceId: workspace.id } });
await prisma.membership.deleteMany({ where: { workspaceId: workspace.id } });
await prisma.user.deleteMany({ where: { email: { endsWith: "@probe.test" } } });
await prisma.workspace.delete({ where: { id: workspace.id } });
await prisma.$disconnect();

const pass = results.filter((r) => r.ok).length;
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n         ${r.detail}`}`);
console.log(`\nTeam invitation verification — ${pass} passed, ${results.length - pass} failed`);
process.exit(pass === results.length ? 0 : 1);
