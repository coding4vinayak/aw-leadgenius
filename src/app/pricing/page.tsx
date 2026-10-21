import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";
import { BuyButton } from "@/components/buy-button";
import { ManageBillingButton } from "@/components/manage-billing";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { PRICES, SUBSCRIPTION_STATUS_ACTIVE } from "@/lib/stripe";

export const metadata: Metadata = {
  title: "Pricing — LeadGenius",
  description: "LeadGenius pricing: $29 per user/month.",
};

/** The part of the `Subscription` row this page can say anything about. */
type Plan = { status: string; stripePriceId: string | null; stripeCurrentPeriodEnd: Date | null };

/**
 * Module-level for the same reason the dashboard banner's countdown is: the page
 * renders on the server, so the date is read once here rather than called from
 * inside the component body.
 */
function renewalDate(periodEnd: Date | null): string | null {
  return periodEnd ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(periodEnd) : null;
}

/**
 * What a workspace that is already paying needs to be told before it looks at
 * these cards: which plan it is on, what happens next, and where a change is
 * actually made. `POST /api/billing/checkout` refuses a second subscription, so
 * leaving two "Start free trial" buttons in front of a paying customer is a
 * button that no longer does anything.
 */
function planLine(plan: Plan): string {
  const named =
    plan.stripePriceId === PRICES.USER_ANNUAL ? "Annual" : plan.stripePriceId === PRICES.USER_MONTHLY ? "Monthly" : "current";
  const renews = renewalDate(plan.stripeCurrentPeriodEnd);
  if (plan.status === "trialing") {
    return `This workspace is trialing the ${named} plan${renews ? ` until ${renews}` : ""}, when the first invoice lands.`;
  }
  if (plan.status === "past_due") {
    return `This workspace is on the ${named} plan, and its last payment was declined. Updating the card is the fix — a new subscription would not pay the old one.`;
  }
  return `This workspace is on the ${named} plan${renews ? `, renews ${renews}` : ""}.`;
}

export default async function Page() {
  const session = await getSession();
  const plan = session
    ? await prisma.subscription.findUnique({
        where: { workspaceId: session.workspaceId },
        select: { status: true, stripePriceId: true, stripeCurrentPeriodEnd: true },
      })
    : null;
  const billed = plan !== null && (SUBSCRIPTION_STATUS_ACTIVE as readonly string[]).includes(plan.status);

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Pricing</h1>
        <p className="mt-2 text-gray-600">Every tier includes unlimited campaigns and the full activity trail. You pay per seat, never per email. Checkout bills the size of your team — everyone in the workspace plus the invites still outstanding — and the billing portal is where seats go up or down afterwards.</p>
        {billed && plan ? (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
            <span>{planLine(plan)}</span>
            <ManageBillingButton label="Change plan in the portal" />
          </div>
        ) : null}
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-wide text-gray-600">Monthly</p>
            <p className="mt-2 text-4xl font-bold">$29</p>
            <p className="mt-1 text-sm text-gray-600">per user/month</p>
            {plan?.stripePriceId === PRICES.USER_MONTHLY ? (
              <p className="mt-6 rounded-lg bg-green-50 px-4 py-2 text-center text-sm font-semibold text-green-700">Your plan</p>
            ) : billed ? (
              <div className="mt-6">
                <ManageBillingButton label="Switch in the portal" />
              </div>
            ) : (
              <BuyButton priceId="USER_MONTHLY" label="Start 14-day free trial" />
            )}
          </div>
          <div className="rounded-2xl border-2 border-blue-600 p-6 bg-blue-50">
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Annual — 2 months free</p>
            <p className="mt-2 text-4xl font-bold">$290</p>
            <p className="mt-1 text-sm text-gray-600">per user/month, billed yearly</p>
            {plan?.stripePriceId === PRICES.USER_ANNUAL ? (
              <p className="mt-6 rounded-lg bg-green-50 px-4 py-2 text-center text-sm font-semibold text-green-700">Your plan</p>
            ) : billed ? (
              <div className="mt-6">
                <ManageBillingButton label="Switch in the portal" />
              </div>
            ) : (
              <BuyButton priceId="USER_ANNUAL" label="Start 14-day free trial" />
            )}
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-wide text-gray-600">Enterprise</p>
            <p className="mt-2 text-4xl font-bold">Custom</p>
            <p className="mt-1 text-sm text-gray-600">Audit exports available; SSO, SLA and onboarding by custom arrangement</p>
            <a href="mailto:support@abetworks.in?subject=LeadGenius%20enterprise" className="mt-6 block rounded-lg border border-blue-600 px-4 py-2 text-center text-sm font-semibold text-blue-600 hover:bg-blue-50 transition">Talk to us</a>
          </div>
        </div>
        <h2 className="mt-12 text-xl font-bold">Questions</h2>
        <div className="mt-4 space-y-4">
          <div><p className="font-semibold text-gray-900">Is there a trial?</p><p className="mt-1 text-gray-600">Yes, two. The live demo workspace is open to anyone, no card. And every paid plan starts with a 14-day free trial — cancel from the billing portal any time before day 14 and you are not charged.</p></div>
          <div><p className="font-semibold text-gray-900">Will this get my domain flagged?</p><p className="mt-1 text-gray-600">The engine enforces deliverability: warmup ramps that start new senders at 5 sends/day, reputation floors, daily limits, and auto-pause on bounces.</p></div>
          <div><p className="font-semibold text-gray-900">Can I cancel anytime?</p><p className="mt-1 text-gray-600">Yes. Plans are month-to-month; service runs to the end of your billing period.</p></div>
          <div><p className="font-semibold text-gray-900">Do you offer annual billing?</p><p className="mt-1 text-gray-600">Yes — $290 per user per year, two months free, one invoice.</p></div>
          <div><p className="font-semibold text-gray-900">Already paying, and want to change something?</p><p className="mt-1 text-gray-600">The billing portal does it — more seats, fewer seats, or the annual plan, which credits what you have already paid. A second checkout would be a second subscription, and Stripe keeps charging the one you have.</p></div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
