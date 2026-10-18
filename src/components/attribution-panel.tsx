"use client";

import { useEffect, useState } from "react";
import { loadAttribution, type AttributionResult } from "@/app/attribution-actions";
import type { AttributionRow } from "@/lib/attribution";

const WINDOWS = [7, 14, 30];

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function rate(row: AttributionRow): number {
  return row.sent > 0 ? row.replied / row.sent : 0;
}

function Table({ label, rows, showChannel }: { label: string; rows: AttributionRow[]; showChannel?: boolean }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{label}</h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500">
            <th className="pb-2 pr-4 font-medium">{showChannel ? "Channel" : "Variant"}</th>
            <th className="pb-2 pr-4 font-medium text-right">Sent</th>
            <th className="pb-2 pr-4 font-medium text-right">Opened</th>
            <th className="pb-2 pr-4 font-medium text-right">Clicked</th>
            <th className="pb-2 pr-4 font-medium text-right">Replied</th>
            <th className="pb-2 font-medium text-right">Reply rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-gray-100">
              <td className="py-2 pr-4 font-medium text-gray-900">{r.key}</td>
              <td className="py-2 pr-4 text-right text-gray-600">{r.sent}</td>
              <td className="py-2 pr-4 text-right text-gray-600">{r.opened}</td>
              <td className="py-2 pr-4 text-right text-gray-600">{r.clicked}</td>
              <td className="py-2 pr-4 text-right text-gray-600">{r.replied}</td>
              <td className="py-2 text-right font-semibold text-gray-900">{r.sent > 0 ? pct(rate(r)) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AttributionPanel() {
  const [days, setDays] = useState(14);
  const [view, setView] = useState<{ days: number; result: AttributionResult } | null>(null);

  useEffect(() => {
    let alive = true;
    void loadAttribution(days).then((result) => {
      if (alive) setView({ days, result });
    });
    return () => {
      alive = false;
    };
  }, [days]);

  const state = view?.days === days ? view.result : null;

  return (
    <div className="bg-white rounded-2xl shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900">What is working</h2>
          <p className="text-xs text-gray-500">Replies by channel and A/B variant, from the same activity rows the daily engine counts.</p>
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setDays(w)}
              className={`rounded-lg px-3 py-1 text-xs font-semibold transition ${
                days === w ? "bg-emerald-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {state === null && <p className="text-sm text-gray-500">Loading…</p>}
      {state && !state.ok && <p className="text-sm text-red-600">{state.error}</p>}

      {state && state.ok && (
        <div className="space-y-6">
          {state.attribution.drift.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              The daily rollup and the raw activity rows disagree for this window —{" "}
              {state.attribution.drift.map((d) => `${d.counter}: ${d.activities} vs ${d.rollup}`).join(", ")}.
              A rollup job is missing or short; the events themselves are counted from the source above.
            </div>
          )}
          {state.attribution.totals.sent === 0 && state.attribution.totals.replied === 0 ? (
            <p className="text-sm text-gray-500">No activity in this window yet.</p>
          ) : (
            <>
              <Table label="By channel" rows={state.attribution.byChannel} showChannel />
              <Table label="By A/B variant" rows={state.attribution.byVariant} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
