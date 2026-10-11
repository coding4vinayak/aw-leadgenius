import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { resolveAiActor, withAiAuth } from "@/lib/ai-actor";
import { isLlmConfigured } from "@/lib/llm";
import { validateBody } from "@/lib/validate";
import { AI_DRAFT_REPLY } from "@/lib/fields";
import {
  draftReply,
  classifyReplyDeterministic,
  describeMissingFacts,
  MIN_CONFIDENCE,
} from "@/lib/ai-reply";

export const dynamic = "force-dynamic";

/**
 * POST /api/ai/draft-reply
 *
 * The model drafts; a human sends. Nothing here writes to the database and
 * nothing here sends anything — the response is a suggestion the caller shows
 * next to the reply. An opt-out detected by the deterministic classifier is
 * honoured without calling a model at all.
 */
async function POST_impl(request: Request) {
  // Malformed bytes used to escape here: `request.json()` throws, `withAuth`
  // only maps ApiKeyError, and the caller got a 500 for a body that is not JSON.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be JSON" }, { status: 400 });
  }
  // A browser holds a session cookie, a script holds a bearer key; both are
  // accepted, and in both cases the workspace comes from the credential. The
  // claim is read off the unvalidated body on purpose: whose workspace the
  // caller *says* this is, before anything else about it is believed.
  const claim = (raw as { workspaceId?: unknown } | null)?.workspaceId;
  const actor = await resolveAiActor(request, {
    // Handed over as it came out of the body. `String(claim)` used to happen on
    // the next line, and that coercion is what made this app answer differently
    // from its siblings: `false` became the text `"false"` and so a 403, while
    // `["<own id>"]` became the id itself and so a 200
    // (`/tmp/abectorial/n25-leadgenius-before.txt`).
    claimedWorkspaceId: claim,
    // And no claim is passed *down* either: the vendored module decides what a
    // claim means, so this route cannot be the app that disagrees about it.
    keyWorkspaceId: () => authedWorkspaceId(request),
  });
  const workspaceId = actor.workspaceId;

  const input = validateBody(raw, AI_DRAFT_REPLY);
  if (!input.ok) return input.error;
  const { enrollmentId, reply, productContext, knownFacts, model } = input.data;

  // Scoped by workspace in the query itself: another tenant's enrollment is not
  // found, rather than fetched and then refused.
  const enrollment = await prisma.enrollment.findFirst({
    where: { id: enrollmentId, campaign: { workspaceId } },
    include: {
      contact: true,
      sequence: true,
      campaign: true,
      activities: { orderBy: { createdAt: "asc" }, take: 20 },
    },
  });
  if (!enrollment) return NextResponse.json({ error: "enrollment not found" }, { status: 404 });

  // The classifier runs first and is authoritative for opt-outs.
  const signal = classifyReplyDeterministic(reply);
  if (signal.kind === "unsubscribe") {
    return NextResponse.json({
      drafted: false,
      signal,
      action: "unsubscribe",
      reason: "Opt-out detected without a model; pause this enrollment and honour it.",
    });
  }

  if (!isLlmConfigured()) {
    return NextResponse.json({
      drafted: false,
      signal,
      configured: false,
      reason: "No LLM_API_KEY set — classification above still works, drafting does not.",
    });
  }

  // The last thing we sent them, so the draft answers the actual ask.
  const lastOutbound = [...enrollment.activities]
    .reverse()
    .find((a) => a.type === "SENT" || a.type === "DELIVERED" || a.type === "CLICKED");

  const draft = await draftReply({
    reply,
    originalMessage: readOutboundContent(lastOutbound?.metadata),
    productContext:
      productContext?.trim() || `Outreach for ${enrollment.campaign.name || "our product"}.`,
    knownFacts: Array.isArray(knownFacts) ? knownFacts.filter((f): f is string => typeof f === "string") : [],
    lead: {
      firstName: enrollment.contact.firstName,
      company: enrollment.contact.company,
      email: enrollment.contact.email,
    },
    model,
  });

  if (!draft) {
    return NextResponse.json(
      { drafted: false, signal, reason: "The model was unreachable or returned nothing usable." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    drafted: true,
    signal,
    draft: {
      body: draft.body,
      intent: draft.intent,
      confidence: draft.confidence,
      lowConfidence: draft.confidence < MIN_CONFIDENCE,
      suggestedAction: draft.suggestedAction,
    },
    usage: draft.usage,
    model: draft.model,
    note: "Draft only — a human reviews and sends. Nothing was written or sent.",
  });
}

export const POST = withAuth(withAiAuth(POST_impl));

/** Activity.metadata is free-form JSON; pull the body out only if it is there. */
function readOutboundContent(metadata: unknown): string {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const content = (metadata as Record<string, unknown>).content;
    if (typeof content === "string" && content.trim()) return content;
  }
  return "No record of the message we sent.";
}
