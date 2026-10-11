import { complete, completeJson, isLlmConfigured, type LlmUsage } from "./llm";

/**
 * AI-assisted replies for outreach that has already landed.
 *
 * The design question here is what the model is *allowed* to do. A model that
 * can send email to a lead is a liability: wrong tone, invented commitments,
 * a promise nobody authorised. So the model drafts, a human sends, and the
 * draft is never auto-applied. Every function returns `null` rather than
 * guessing when no model is configured — the product behaves identically, it
 * just has nothing to show.
 */

export interface ReplyDraft {
  /** The drafted body, ready for a human to edit. */
  body: string;
  /** One-line summary of the intent we detected, for the reviewer. */
  intent: string;
  /** 0–1. Below `MIN_CONFIDENCE` the caller should not show this as a draft. */
  confidence: number;
  /** Suggested next action for the human, e.g. "book a call". */
  suggestedAction: string;
  usage: LlmUsage;
  model: string;
}

/** Below this we return the draft flagged low-confidence rather than hiding it. */
export const MIN_CONFIDENCE = 0.5;

const SYSTEM = `You draft replies to sales outreach for a small B2B team.

Rules, in priority order:
1. Never invent facts: no pricing, no timelines, no commitments the sender has
   not been given. If the reply needs a fact you do not have, write the reply so
   it defers ("I'll check and come back to you today") and say so in the note.
2. Match the reply's language and its register. A one-word reply gets a short reply.
3. Never push a meeting in the reply if the reply pushed back or asked to stop.
4. Plain text. No markdown, no signatures, no subject line.

Return JSON: { intent, confidence, body, suggestedAction, missingFacts }.
- intent: 2–5 words describing what they said.
- confidence: 0–1, your certainty that this reply is appropriate and factual.
- body: the drafted reply, no greeting padding.
- suggestedAction: what the human should do next.
- missingFacts: array of things you needed but were not given.`;

const UNSUBSCRIBE_MARKERS = [
  "unsubscribe",
  "stop emailing",
  "remove me",
  "do not contact",
  "opt out",
  "not interested",
  "no longer wish",
];

export type ReplySignal =
  | { kind: "unsubscribe"; reason: string }
  | { kind: "objection"; text: string }
  | { kind: "positive"; text: string }
  | { kind: "question"; text: string }
  | { kind: "other"; text: string };

/**
 * Classify a reply *without* a model. This is the safety net: even with an LLM
 * configured, an unsubscribe is handled here and never reaches the model.
 */
export function classifyReplyDeterministic(text: string): ReplySignal {
  const lower = text.toLowerCase();

  if (UNSUBSCRIBE_MARKERS.some((m) => lower.includes(m))) {
    return { kind: "unsubscribe", reason: "explicit opt-out language" };
  }
  if (/\b(not (?:interested|now)|no thanks|no thank you|pass)\b/.test(lower)) {
    return { kind: "unsubscribe", reason: "declined without asking for more" };
  }
  if (/\b(too (?:expensive|early|much)|budget|not right now|we're (?:an )?incumbent|already (?:have|use))\b/.test(lower)) {
    return { kind: "objection", text };
  }
  if (/\b(interested|sounds (?:good|great|interesting)|let'?s (?:talk|chat|schedule)|send (?:me |us )?(?:more|info|details)|tell me more|learn more|more info|book a call|works for me|yes)\b/.test(lower)) {
    return { kind: "positive", text };
  }
  if (text.includes("?") || /\b(could you|can you|what(?:'s| is)|how (?:much|many|do|does)|when)\b/.test(lower)) {
    return { kind: "question", text };
  }
  return { kind: "other", text };
}

export interface DraftReplyInput {
  /** The lead's reply, verbatim. */
  reply: string;
  /** The message we sent them, so the draft answers the actual ask. */
  originalMessage: string;
  /** What we sell, in one or two sentences. */
  productContext: string;
  /** Facts we are actually authorised to state. Anything else is a `missingFact`. */
  knownFacts: string[];
  lead: { firstName?: string | null; company?: string | null; email?: string | null };
  model?: string;
}

/**
 * Draft a reply. Returns null when no model is configured or the call fails —
 * never a fabricated fallback, because a wrong draft that looks real is worse
 * than no draft.
 */
export async function draftReply(input: DraftReplyInput): Promise<ReplyDraft | null> {
  if (!isLlmConfigured()) return null;

  const signal = classifyReplyDeterministic(input.reply);

  // An opt-out is an action, not a writing prompt. It must never depend on a
  // third-party model being reachable to be honoured.
  if (signal.kind === "unsubscribe") return null;

  const facts = input.knownFacts.length ? input.knownFacts.join("\n- ") : "(none given)";
  const user = [
    `Product context: ${input.productContext}`,
    `Authorised facts you may state:`,
    `- ${facts}`,
    ``,
    `We sent them:`,
    input.originalMessage,
    ``,
    `They replied:`,
    input.reply,
    ``,
    `Detected intent (classify it yourself, do not trust this blindly): ${signal.kind}`,
    signal.kind === "objection" ? "They pushed back. Acknowledge it directly; do not be defensive and do not re-pitch." : "",
    signal.kind === "question" ? "They asked something. If the answer is not in the authorised facts, do not invent it." : "",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await completeJson<{
    intent?: string;
    confidence?: number;
    body?: string;
    suggestedAction?: string;
    missingFacts?: string[];
  }>(SYSTEM, user, {
    model: input.model,
    schemaHint:
      '{ "intent": string, "confidence": number, "body": string, "suggestedAction": string, "missingFacts": string[] }',
  });

  if (!result) return null;

  const body = typeof result.data.body === "string" ? result.data.body.trim() : "";
  if (!body) return null;

  return {
    body,
    intent: typeof result.data.intent === "string" ? result.data.intent : signal.kind,
    confidence:
      typeof result.data.confidence === "number"
        ? Math.max(0, Math.min(1, result.data.confidence))
        : MIN_CONFIDENCE,
    suggestedAction:
      typeof result.data.suggestedAction === "string" && result.data.suggestedAction
        ? result.data.suggestedAction
        : "Review and send",
    usage: result.usage,
    model: result.model,
  };
}

/** Short, human-readable note about what the draft is missing. */
export function describeMissingFacts(draft: ReplyDraft, missing: string[]): string {
  if (missing.length === 0) return "";
  return `Draft deliberately omits: ${missing.join(", ")}`;
}
