"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * The example-campaign panel: one worked example, and the one click that takes
 * it away again.
 *
 * It talks to `/api/example-campaign` over the session (the browser never
 * holds an API key) and then asks the server to re-render, so what is on the
 * screen is what the server computed — not a number this component invented.
 */
export function ExampleCampaignCard({ loaded }: { loaded: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function call(method: "POST" | "DELETE") {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/example-campaign", { method });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || "Could not reach the server.");
          return;
        }
        router.refresh();
      } catch {
        setError("Network error — try again.");
      }
    });
  }

  if (loaded) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <p className="text-sm font-semibold text-amber-900">
          The example campaign is loaded — it is a sample, not your campaign.
        </p>
        <p className="mt-1 text-xs text-amber-800">
          One draft campaign, a three-step sequence, the two templates behind it, five example
          contacts and three enrollments. Nothing has been sent and nothing will be: outreach
          needs a sending account, and the campaign stays a draft until you connect one and
          activate it. One click takes it and its rows away — nothing of yours is touched.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => call("DELETE")}
            disabled={pending}
            className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
          >
            {pending ? "Working…" : "Remove the example campaign"}
          </button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5">
      <p className="text-sm font-semibold text-gray-900">See the shape of a campaign — one click, no setup.</p>
      <p className="mt-1 text-xs text-gray-600">
        Loads one worked example: a draft campaign, a three-step sequence (email, email, a
        call), the templates behind it with the names they fill, five example contacts and three
        enrollments. It is example data, it is labelled as such, and one click removes it again.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => call("POST")}
          disabled={pending}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
        >
          {pending ? "Loading…" : "Load the example campaign"}
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}
