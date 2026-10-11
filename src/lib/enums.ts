/**
 * The string columns in `prisma/schema.prisma` that hold an enumerated value
 * document that value in a comment, because SQLite has no enum type and Prisma
 * has no way to check a `String` against a comment. So `channel: "FAX"` is a
 * clean insert today, and the row is then invisible to every comparison the
 * code makes — `if (account.channel === "EMAIL")` in
 * `api/sending-accounts/route.ts`, the channel filter on the list routes, the
 * sequence engine's choice of sender.
 *
 * These arrays are transcribed from those comments and nothing else; where a
 * table here and the schema comment disagree, the schema is the one to fix.
 * The write routes validate against them (see `src/lib/validate.ts`) so that a
 * value outside the set answers 400 at the boundary instead of becoming a row
 * that silently does nothing.
 */

/** Sequence.channel */
export const SEQUENCE_CHANNELS = ["EMAIL", "WHATSAPP", "LINKEDIN", "MULTI"] as const;
/** SequenceStep.channel — what one step can send, including the two human steps. */
export const STEP_CHANNELS = ["EMAIL", "WHATSAPP", "LINKEDIN", "CALL", "TASK"] as const;
/** Template.channel */
export const TEMPLATE_CHANNELS = ["EMAIL", "WHATSAPP", "LINKEDIN"] as const;
/** SendingAccount.channel — there is no MULTI sending account; MULTI is a sequence. */
export const SENDING_CHANNELS = ["EMAIL", "WHATSAPP", "LINKEDIN"] as const;
/** SendingAccount.provider */
export const SENDING_PROVIDERS = ["SMTP", "TWILIO", "META", "LINKEDIN_API", "OUTREACH_IO"] as const;
/** Campaign.status */
export const CAMPAIGN_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED"] as const;
/** Sequence.status */
export const SEQUENCE_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
/** Contact.status */
export const CONTACT_STATUSES = ["ACTIVE", "BOUNCED", "UNSUBSCRIBED", "DO_NOT_CONTACT"] as const;
/** Enrollment.status */
export const ENROLLMENT_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "BOUNCED", "REPLIED", "UNSUBSCRIBED"] as const;
