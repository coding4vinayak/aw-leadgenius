import Link from "next/link";
import { prisma } from "@/lib/db";
import { DashboardShell } from "@/components/dashboard-shell";
import { resolveWorkspace } from "@/lib/resolve-workspace";
import { signOut } from "@/app/auth-actions";
import { switchWorkspaceAction } from "@/app/member-actions";
import { createFirstKey } from "@/app/key-actions";
import { ApiKeyOnboarding } from "@/components/api-key-onboarding";
import { AttributionPanel } from "@/components/attribution-panel";
import { AiPanel, type AiField } from "@/components/ai-panel";
import { ManageBillingButton } from "@/components/manage-billing";
import { canManageRoles } from "@/lib/roles";

export const dynamic = "force-dynamic";

function Badge({ tone, children }: { tone: "green" | "blue" | "red" | "gray"; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    green: "bg-green-100 text-green-800",
    blue: "bg-blue-100 text-blue-800",
    red: "bg-red-100 text-red-800",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Card({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

type SubscriptionState = {
  status: string;
  stripeCustomerId: string;
  stripeCurrentPeriodEnd: Date | null;
} | null;

/**
 * The plan the workspace is on, in one honest line. Free workspaces get an
 * upgrade path; paid ones get their renewal date and a way into the portal. The
 * "Payment received" note is a transient flag off the checkout redirect, so it
 * only shows on the first load after a purchase — the persisted status is what
 * stays up after a refresh.
 */
/**
 * Whole days left before the first charge. During a trial the stored period end
 * is the trial end. A helper rather than an inline `Date.now()`: the page is
 * rendered on the server, so the countdown is fixed at render time and the text
 * must come from one place that React's purity rule accepts.
 */
function daysUntil(periodEnd: Date | null): number | null {
  if (!periodEnd) return null;
  return Math.max(0, Math.ceil((periodEnd.getTime() - Date.now()) / 86_400_000));
}

function PlanBanner({ billing, subscription }: { billing?: string; subscription: SubscriptionState }) {
  const paid = subscription ? ["trialing", "active", "past_due"].includes(subscription.status) : false;
  const trialing = subscription?.status === "trialing";
  const justBack = billing === "success" || billing === "portal";
  const renews = subscription?.stripeCurrentPeriodEnd
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(subscription.stripeCurrentPeriodEnd)
    : null;
  const daysLeft = daysUntil(trialing ? subscription?.stripeCurrentPeriodEnd ?? null : null);
  const daysLeftText = daysLeft === null ? null : `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`;

  if (justBack && paid) {
    return (
      <div className="rounded-2xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">
        {trialing ? (
          <>
            Trial started — welcome aboard. Your trial runs until {renews ?? "day 14"}
            {daysLeftText ? <> ({daysLeftText})</> : null}, then the first invoice lands. Cancel any time before then and you are not charged.
          </>
        ) : (
          <>Payment received — welcome aboard. Your plan is <strong>{subscription!.status}</strong>.</>
        )}
      </div>
    );
  }

  if (paid) {
    return (
      <div className="flex items-center justify-between gap-4 rounded-2xl border border-gray-200 bg-white p-4 text-sm">
        <span className="flex items-center gap-2">
          <Badge tone={trialing ? "blue" : "green"}>{subscription!.status}</Badge>
          <span className="text-gray-700">
            {trialing
              ? <>Trial active{daysLeftText ? <> — {daysLeftText}</> : null}{renews ? <>, first charge {renews}</> : null}.</>
              : <>Paid plan active{renews ? <>, renews {renews}</> : null}.</>}
          </span>
        </span>
        <ManageBillingButton />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-gray-200 bg-white p-4 text-sm">
      <span className="flex items-center gap-2">
        <Badge tone="gray">free</Badge>
        <span className="text-gray-700">You are on the free demo. Full product for 14 days on your first paid plan — no charge before day 14, cancel any time from the portal.</span>
      </span>
      <Link href="/pricing" className="shrink-0 rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 transition">
        Start free trial
      </Link>
    </div>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ workspace?: string; billing?: string }> }) {
  const { workspace: requestedSlug, billing } = await searchParams;
  // One policy, shared: the demo stays public, a customer's own workspace needs
  // their session, and naming anyone else's slug is refused rather than served.
  const resolved = await resolveWorkspace(requestedSlug);
  if (!resolved.workspace) {
    return (
      <main className="min-h-screen flex items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-gray-600">
            That workspace needs an account. Sign in to open yours.
          </p>
          <a
            href="/login"
            className="mt-4 inline-block rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-gray-700"
          >
            Sign in
          </a>
        </div>
      </main>
    );
  }
  const workspace = resolved.workspace;
  const session = resolved.session;

  // The reply-drafting feature is scoped to an enrollment, so the panel needs
  // the list. Without this there is nothing in the UI to point the AI at.
  const enrollments = session
    ? await prisma.enrollment.findMany({
        where: { campaign: { workspaceId: workspace.id } },
        include: { contact: true, activities: { orderBy: { createdAt: "desc" }, take: 1 } },
        orderBy: { createdAt: "desc" },
        take: 25,
      })
    : [];

  // The bar's workspace switcher needs the full list. Anonymous visitors get
  // none — the demo badge already says what they are looking at.
  const myWorkspaces = session
    ? await prisma.membership.findMany({
        where: { userId: session.userId },
        include: { workspace: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const liveKeyCount = session
    ? await prisma.apiKey.count({ where: { workspaceId: workspace.id, revokedAt: null } })
    : null;
  // Read the plan straight from the local row, never through getStripe() — a
  // deployment without STRIPE_SECRET_KEY must still render the dashboard.
  const subscription = session
    ? await prisma.subscription.findUnique({
        where: { workspaceId: workspace.id },
        select: { status: true, stripeCustomerId: true, stripeCurrentPeriodEnd: true },
      })
    : null;

  const [campaignCount, contactCount, sentCount, repliedCount, campaigns] = await Promise.all([
    prisma.campaign.count({ where: { workspaceId: workspace.id } }),
    prisma.contact.count({ where: { workspaceId: workspace.id } }),
    prisma.sentMessage.count({ where: { sendingAccount: { workspaceId: workspace.id } } }),
    prisma.activity.count({ where: { enrollment: { campaign: { workspaceId: workspace.id } }, type: "REPLIED" } }),
    prisma.campaign.findMany({
      where: { workspaceId: workspace.id },
      include: { _count: { select: { enrollments: true } } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
  ]);

  return (
    <DashboardShell
      product="LeadGenius"
      accent="text-emerald-600"
      accentSoft="bg-emerald-500"
      account={
        session
          ? {
              name: session.name,
              email: session.email,
              signOut,
              workspaces: myWorkspaces.map((m) => m.workspace),
              currentWorkspaceId: session.workspaceId,
              switchWorkspace: switchWorkspaceAction,
            }
          : null
      }
      workspace={workspace.name}
      title="Outreach dashboard"
    >
        {session && (
          <div className="mb-6">
            <PlanBanner billing={billing} subscription={subscription} />
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card label="Campaigns" value={campaignCount} />
          <Card label="Contacts" value={contactCount} />
          <Card label="Messages sent" value={sentCount} />
          <Card
            label="Replies"
            value={repliedCount}
            sub={sentCount > 0 ? `${((repliedCount / sentCount) * 100).toFixed(1)}% reply rate` : "no sends yet"}
          />
        </div>

        {session && session.workspaceId === workspace.id && canManageRoles(session.role) && (
          <div className="mb-8 rounded-2xl bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-bold text-gray-900">Export</h2>
              <p className="text-xs text-gray-500">Owners and admins</p>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-gray-600">
              The workspace JSON carries campaigns, sequences, templates, contacts, lists,
              sending accounts, webhook destinations and team. Engagements, replies and sent
              messages stream separately as CSV so a high-volume workspace never has to fit
              in memory.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href="/api/export"
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700"
              >
                Download workspace (JSON)
              </a>
              <a
                href="/api/export/activities"
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Download engagement audit (CSV)
              </a>
              <a
                href="/api/export/replies"
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Download replies (CSV)
              </a>
              <a
                href="/api/export/sent-messages"
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Download sent messages (CSV)
              </a>
            </div>
            <p className="mt-3 text-xs text-gray-500">
              Sending account configs, webhook signing secrets, API keys and invitation tokens are never included.
            </p>
          </div>
        )}

        {session && (
          <div className="mb-8">
            <AttributionPanel />
          </div>
        )}

        <div className="bg-white rounded-2xl shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Campaigns</h2>
          {campaigns.length === 0 ? (
            <p className="text-sm text-gray-500">No campaigns yet. Create one via <code>POST /api/campaigns</code>.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="pb-2 pr-4 font-medium">Name</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Enrolled</th>
                    <th className="pb-2 font-medium">Goal</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className="border-t border-gray-100">
                      <td className="py-3 pr-4 font-medium text-gray-900">{c.name}</td>
                      <td className="py-3 pr-4">
                        <Badge tone={c.status === "ACTIVE" ? "green" : c.status === "PAUSED" ? "blue" : "gray"}>{c.status}</Badge>
                      </td>
                      <td className="py-3 pr-4 text-gray-600">{c._count.enrollments}</td>
                      <td className="py-3 text-gray-600">{c.goal ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      {session && (
        <div className="mt-6">
          <AiPanel
            config={{
              title: "Draft a reply",
              blurb:
                "Paste a reply and the model drafts a response for a human to review. It never invents pricing or commitments, and it is not sent for you.",
              endpoint: "/api/ai/draft-reply",
              entityLabel: "Enrollment",
              idField: "enrollmentId",
              workspaceId: workspace.id,
              inputLabel: "Their reply",
              inputPlaceholder: "Sounds interesting, tell me more",
              buttonLabel: "Draft reply",
              draft: true,
              emptyText: "No enrollments yet. Enrol a contact in a campaign first.",
              options: enrollments.map((e) => ({
                id: e.id,
                label: `${e.contact.firstName ?? e.contact.email ?? e.contact.id} — ${e.activities[0]?.type ?? "no activity yet"}`,
              })),
            }}
            fields={[
              { path: "draft.intent", title: "Detected intent" },
              { path: "draft.body", title: "Drafted reply", mono: true },
              { path: "draft.suggestedAction", title: "Suggested next step" },
            ] satisfies AiField[]}
          />
        </div>
      )}

      {session && liveKeyCount === 0 && (
        // Only for a signed-in workspace with no usable key: a stranger on the
        // public demo has no account to attach a key to, and prompting them
        // would be an invitation to sign up mid-demo.
        <div className="mt-6">
          <ApiKeyOnboarding createKey={createFirstKey} />
        </div>
      )}
      </DashboardShell>
  );
}
