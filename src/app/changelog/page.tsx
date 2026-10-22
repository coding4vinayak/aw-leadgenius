import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Changelog — LeadGenius",
  description: "What changed in LeadGenius, newest first.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Changelog</h1>
        <p className="mt-2 text-gray-600">Newest first. Breaking changes are marked <strong>BREAKING</strong> and get 30 days&apos; notice here before they ship.</p>
        <div className="mt-8 space-y-8 border-l-2 border-blue-600 pl-6">
          <div>
            <p className="text-sm text-muted">October 2026</p>
            <h2 className="text-lg font-bold">v1.4.0 — Also in the Abetworks suite</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>The pricing page now says what the suite is: every product is sold standalone, and one contract can set up a workspace across all of them.</li>
              <li>It names the three products teams pair this one with, each linking to its own sign-up and saying what it costs &mdash; so a buyer reading this page is a buyer the team could have had a different conversation with.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.3.0 — See the shape of a campaign before you write one</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>A new workspace can load one worked example in a click: a draft campaign, a three-step sequence (email, email, a call), the two templates behind it with the names they fill, five example contacts and three enrollments.</li>
              <li>The example is built by the app&rsquo;s own rules &mdash; the same field tables, template rules, channel rules and merge rules the API enforces &mdash; so it can never be something the product would refuse at its own door.</li>
              <li>Nothing has been sent and nothing will be: outreach needs a sending account, and the campaign stays a draft until you connect one and activate it. One click removes the example and its rows; nothing of yours is touched.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.2.0 — The channel, the subject and the arm</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li><strong>Attribution</strong> answers &quot;which channel earned the reply&quot;, from the app's own sent activity rather than from a guess.</li>
              <li><strong>A/B tests</strong> assign each contact to an arm by a hash of their id, so the same person always lands in the same arm.</li>
              <li>The subject, the carrier and the traffic split are checked at the door, so a sequence cannot be built that sends email copy to a chat channel — and a contact marked dead is refused at enrollment and stopped by the sweep itself.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">October 2026</p>
            <h2 className="text-lg font-bold">v1.1.0 — Take the outreach trail with you</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>Owners and admins can download a workspace JSON with campaigns, sequences, templates, contacts, lists, sending accounts, webhook destinations and team.</li>
              <li>Engagement activities, replies and sent messages download as streamed CSVs. Sending account configs, webhook signing secrets, API keys and invitation tokens are never included.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-gray-600">September 2026</p>
            <h2 className="text-lg font-bold">v1.0.0 — Initial public release</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-600">
              <li>General availability: Multichannel sequences across email, WhatsApp, and LinkedIn — with warmup, reputation guardrails, and a full sent-to-replied trail on every contact.</li>
              <li>Public pricing, terms, privacy, and support pages.</li>
              <li>Live demo workspace, no card required.</li>
            </ul>
          </div>
        </div>
        <p className="mt-8 text-gray-600">How we version: <code>major.minor.patch</code>. Minor adds features, patch fixes bugs, major is reserved for contract changes — and those are announced here first.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
