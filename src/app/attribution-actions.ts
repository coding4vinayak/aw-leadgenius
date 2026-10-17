"use server";

import { requireSession } from "@/lib/session";
import { getAttribution, type Attribution } from "@/lib/attribution";

export type AttributionResult = { ok: true; attribution: Attribution } | { ok: false; error: string };

/**
 * Load the workspace's attribution window, from the browser session.
 *
 * The workspace comes from the session, never from the form — the same rule
 * `createFirstKey` set: a signed-in customer cannot point the read at somebody
 * else's workspace by tampering with the request.
 */
export async function loadAttribution(days: number): Promise<AttributionResult> {
  const session = await requireSession();
  const window = Math.min(Math.max(Math.round(Number(days)) || 14, 1), 90);
  const end = new Date();
  const start = new Date(end.getTime() - window * 86_400_000);
  const attribution = await getAttribution(session.workspaceId, start, end);
  return { ok: true, attribution };
}
