import { prisma } from "./db";
import { canEditRole, canGrant } from "./roles";
import { SUBSCRIPTION_STATUS_ACTIVE } from "./stripe";

/**
 * The seat meter, which is the other half of a per-user price.
 *
 * Checkout bills for the members in the workspace (#106) and the pricing page
 * promises the invoice "scales with your team", but until now the number lived
 * only inside Stripe: an Owner on a one-seat plan could invite thirty
 * colleagues and neither the product nor the bill noticed. Storing the line
 * item quantity at every sync and reading it here is what makes the price real
 * — and it is the upgrade path, because the way past the limit is to buy
 * another seat, which is the transaction this product exists to repeat.
 */
export type SeatUsage = {
  /** What the subscription is billed for, or null when the workspace has no
   *  known number — a plan this app has not synced since the column existed, or
   *  no paid plan at all. */
  cap: number | null;
  /** Seats already occupied or promised: every member, plus every invite that
   *  has not been accepted and has not expired. A pending link is a seat
   *  committed the moment somebody says yes, so counting members alone would let
   *  an Owner hand out links all afternoon and leave the invoice behind. */
  used: number;
};

/**
 * The count in one sentence, next to the rule it describes: the banner a
 * manager reads and the error an invite form returns must not be free to word
 * the same limit differently. Null when there is nothing to compare against —
 * an unknown cap has no number to spell out, and inventing one here would be
 * the same lie the meter refuses.
 */
export function seatSummary(usage: SeatUsage): string | null {
  const { cap, used } = usage;
  if (cap === null) return null;
  if (used > cap)
    return (
      `${used} of ${cap} paid seats are taken — the team is bigger than the plan, ` +
      `and the invoice is short ${used - cap} ${used - cap === 1 ? "seat" : "seats"}.`
    );
  if (used === cap)
    return cap === 1
      ? "The only paid seat is taken or already invited — the next person needs another seat."
      : `All ${cap} paid seats are taken or already invited — the next person needs another seat.`;
  const open = cap - used;
  return `${used} of ${cap} paid seats taken, ${open} ${open === 1 ? "is" : "are"} still open.`;
}

/**
 * The rule as plain arithmetic, so it can be driven with real numbers and no
 * database.
 *
 * An unknown cap is not a zero cap. Refusing to let a paying team invite anybody
 * because a column this app only just started writing was never populated is a
 * support ticket and a churn risk, not a billing win — so the meter fails open
 * on `null` and the next sync closes it.
 *
 * The refusal is the summary sentence plus the way out, built from the same
 * call: a banner that says one thing and an error that says another is how a
 * limit reads like a bug.
 */
export function seatDecision(usage: SeatUsage): { allowed: true } | { allowed: false; error: string } {
  if (usage.cap === null || usage.used < usage.cap) return { allowed: true };
  return {
    allowed: false,
    error:
      `${seatSummary(usage)} The plan is priced per user, so the way past the limit is to buy ` +
      `another seat — the billing portal changes the quantity in one click, and the invoice ` +
      `scales with it.`,
  };
}

export async function seatUsage(workspaceId: string, now: Date = new Date()): Promise<SeatUsage> {
  const [subscription, members, pending] = await Promise.all([
    prisma.subscription.findUnique({
      where: { workspaceId },
      select: { status: true, stripeSeats: true },
    }),
    prisma.membership.count({ where: { workspaceId } }),
    prisma.invite.count({ where: { workspaceId, acceptedAt: null, expiresAt: { gt: now } } }),
  ]);
  const cap = subscription
    ? (SUBSCRIPTION_STATUS_ACTIVE as readonly string[]).includes(subscription.status)
      ? subscription.stripeSeats
      : null
    : null;
  return { cap, used: members + pending };
}

/**
 * Changing or ending an existing seat.
 *
 * Invitations only ever *add* access, so this is the half that fixes a mistake:
 * the member who should have been an admin, the colleague who has left. It lives in
 * lib rather than in the server action for the same reason the invite rules do — it
 * is the most powerful thing an owner can click, and it has to be drivable from a
 * script against a real database instead of read and hoped over.
 *
 * Three rules hold it together:
 *
 *   - The workspace comes from the caller's session, and the seat is looked up by
 *     id *within* it. A membership id from another tenant resolves to nothing.
 *   - canEditRole decides whether this seat is yours to touch, so an admin cannot
 *     re-role another admin, and nobody can touch an owner from inside the product.
 *   - canGrant decides which roles may be handed out, so the dropdown cannot
 *     sidestep "only an owner may make an admin" — an invite and a role change are
 *     the same privilege wearing different clothes.
 */

/** Not a role. An instruction to take the seat away, kept out of the role
 *  namespace so a made-up role can never be spelled like a verb. */
export const REMOVE = "REMOVE";

/** The role names go into sentences, so the article has to follow them rather
 *  than being hardcoded to "a". */
function article(role: string): string {
  return role === "ADMIN" || role === "OWNER" ? "an" : "a";
}

export type SeatOutcome =
  | { ok: true; action: "role" | "removed" | "unchanged"; who: string; role?: string }
  | { ok: false; error: string };

export async function editSeat(input: {
  workspaceId: string;
  membershipId: string;
  actorRole: string;
  role: string;
}): Promise<SeatOutcome> {
  const seat = await prisma.membership.findFirst({
    where: { id: input.membershipId, workspaceId: input.workspaceId },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!seat) return { ok: false, error: "That seat is not in your workspace." };

  if (!canEditRole(input.actorRole, seat.role)) {
    return {
      ok: false,
      error:
        `As ${article(input.actorRole)} ${input.actorRole.toLowerCase()}, ` +
        `you cannot change ${article(seat.role)} ${seat.role.toLowerCase()} seat.`,
    };
  }

  const who = seat.user.name || seat.user.email;

  if (input.role === REMOVE) {
    await prisma.$transaction([
      prisma.membership.delete({ where: { id: seat.id } }),
      // Their cookie was minted in this workspace. Delete the seat alone and the
      // browser keeps a workspace it has been removed from until something else
      // reloads: the row is gone but the session still names the id. Other
      // workspaces this account belongs to are untouched, which is why the filter
      // is the pair rather than the user alone.
      prisma.session.deleteMany({
        where: { userId: seat.userId, workspaceId: seat.workspaceId },
      }),
    ]);
    return { ok: true, action: "removed", who };
  }

  const grantable = canGrant(input.actorRole, input.role);
  if (!grantable.ok) return { ok: false, error: grantable.error };
  if (input.role === seat.role) return { ok: true, action: "unchanged", who, role: input.role };

  await prisma.membership.update({ where: { id: seat.id }, data: { role: input.role } });
  return { ok: true, action: "role", who, role: input.role };
}
