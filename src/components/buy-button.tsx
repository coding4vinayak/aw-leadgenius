"use client";

import { useState } from "react";

type PriceKey = "USER_MONTHLY" | "USER_ANNUAL";

export function BuyButton({ priceId, label }: { priceId: PriceKey; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function buy() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priceId,
          returnUrl: `${window.location.origin}/dashboard?billing=success`,
        }),
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const data = (await res.json()) as { url?: string; error?: string };
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setError(data.error ?? "Checkout failed — try again or write to support@abetworks.in.");
    } catch {
      setError("Checkout failed — try again or write to support@abetworks.in.");
    }
    setBusy(false);
  }

  return (
    <div>
      <button
        type="button"
        onClick={buy}
        disabled={busy}
        className="mt-6 block w-full rounded-lg bg-blue-600 px-4 py-2 text-center text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? "Redirecting to Stripe…" : label}
      </button>
      {error && <p className="mt-2 text-[12px] text-red-500">{error}</p>}
    </div>
  );
}
