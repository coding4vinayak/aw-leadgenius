import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav, SiteFooter } from "@/components/site";
import { VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: "LeadGenius — Outreach that earns replies, not spam complaints.",
  description: "Multichannel sequences across email, WhatsApp, and LinkedIn — with warmup, reputation guardrails, and a full sent-to-replied trail on every contact.",
};

export default function Home() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main>
        <section className="mx-auto max-w-4xl px-6 pb-16 pt-20 text-center">
          <p className="inline-block rounded-full bg-blue-50 text-blue-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide">
            v{VERSION} · Now generally available
          </p>
          <h1 className="mt-6 text-5xl font-bold tracking-tight">LeadGenius</h1>
          <p className="mx-auto mt-4 max-w-2xl text-xl text-gray-600">Outreach that earns replies, not spam complaints.</p>
          <p className="mx-auto mt-3 max-w-2xl text-gray-600">Multichannel sequences across email, WhatsApp, and LinkedIn — with warmup, reputation guardrails, and a full sent-to-replied trail on every contact.</p>
          <div className="mt-8 flex justify-center gap-4">
            <Link href="/pricing" className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 transition">
              Start 14-day free trial
            </Link>
            <a href="/dashboard?workspace=demo" className="rounded-lg border border-gray-300 hover:bg-gray-50 px-6 py-3 font-semibold transition">
              Open live demo
            </a>
          </div>
        </section>
        <section id="features" className="mx-auto max-w-6xl px-6 py-12">
          <h2 className="text-center text-2xl font-bold">Why teams pick LeadGenius</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Multichannel sequences</h3>
            <p className="mt-2 text-sm text-gray-600">Email, WhatsApp, and LinkedIn steps in one sequence with per-step delays and branch conditions.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">A/B variants that settle it</h3>
            <p className="mt-2 text-sm text-gray-600">Test subject lines and openers head-to-head; winners emerge from real reply data.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Warmup that protects domains</h3>
            <p className="mt-2 text-sm text-gray-600">New senders start at 5 sends/day and step up by 5 each nightly warmup pass, until they reach your daily limit.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Guardrails in code, not runbooks</h3>
            <p className="mt-2 text-sm text-gray-600">Spent or low-reputation accounts are skipped automatically. Bounces and complaints pause enrollments.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Analytics per step</h3>
            <p className="mt-2 text-sm text-gray-600">Overview, campaign, sequence, and daily views — see exactly where replies come from.</p>
          </div>
          <div className="rounded-2xl border p-6 border-gray-200 bg-white shadow-sm">
            <h3 className="font-bold text-gray-900">Webhooks for everything</h3>
            <p className="mt-2 text-sm text-gray-600">HMAC-signed deliveries for provider events, so your CRM hears about replies in seconds.</p>
          </div>
          </div>
        </section>
        <section className="border-y border-gray-200 bg-gray-50">
          <div className="mx-auto max-w-4xl space-y-6 px-6 py-12">
            <h2 className="text-2xl font-bold">Live in three steps</h2>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">1</span>
            <div><p className="font-bold text-gray-900">Create a campaign</p><p className="mt-1 text-sm text-gray-600">Draft it in minutes, or start from the Q4 Outreach Campaign in the demo workspace.</p></div>
          </div>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">2</span>
            <div><p className="font-bold text-gray-900">Enroll contacts</p><p className="mt-1 text-sm text-gray-600">Import a list or add contacts one by one; sequences, delays, and branches do the rest.</p></div>
          </div>
          <div className="flex gap-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">3</span>
            <div><p className="font-bold text-gray-900">Earn replies</p><p className="mt-1 text-sm text-gray-600">Sending accounts, warmup, and guardrails keep you in the primary tab while analytics show what worked.</p></div>
          </div>
          </div>
        </section>
        <section className="mx-auto max-w-4xl px-6 py-12">
          <h2 className="text-2xl font-bold">Questions, answered</h2>
          <div className="mt-6 space-y-4">
          <div><p className="font-semibold text-gray-900">Is there a trial?</p><p className="mt-1 text-gray-600">Yes — the live demo workspace has a real campaign, sequence, and contacts. No card required.</p></div>
          <div><p className="font-semibold text-gray-900">Will this get my domain flagged?</p><p className="mt-1 text-gray-600">The engine enforces deliverability: warmup ramps that start new senders at 5 sends/day, reputation floors, daily limits, and auto-pause on bounces.</p></div>
          <div><p className="font-semibold text-gray-900">Can I cancel anytime?</p><p className="mt-1 text-gray-600">Yes. Plans are month-to-month; service runs to the end of your billing period.</p></div>
          <div><p className="font-semibold text-gray-900">Do you offer annual billing?</p><p className="mt-1 text-gray-600">Yes — $290 per user per year, two months free, one invoice.</p></div>
          </div>
        </section>
        <section className="mx-auto max-w-4xl px-6 pb-16 text-center">
          <h2 className="text-2xl font-bold">Try it free — a live demo, or 14 days of the full product.</h2>
          <div className="mt-6 flex justify-center gap-4">
            <Link href="/pricing" className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 transition">
              Start 14-day free trial
            </Link>
            <a href="/dashboard?workspace=demo" className="rounded-lg border border-gray-300 hover:bg-gray-50 px-6 py-3 font-semibold transition">
              Open live demo
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
