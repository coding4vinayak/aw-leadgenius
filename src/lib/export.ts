import { prisma } from "./db";
import { asRecord } from "./json";

/**
 * The export surface for the multichannel outreach engine.
 *
 * Two doors:
 *
 *   - `buildWorkspaceExport` is the portable copy: team, invitations, campaigns
 *     with sequences and steps, templates, A/B tests, contacts and lists,
 *     sending accounts, webhook destinations, and counts for the high-volume
 *     tables (enrollments, activities, replies, sent messages) with stream links.
 *   - `activityCsvHeader` / `activityCsvRow` are the engagement audit: one row
 *     per activity (sent, delivered, opened, clicked, replied, bounced, failed,
 *     unsubscribed) with its metadata, streamed in batches so a high-volume
 *     workspace never has to fit in memory.
 *
 * Content, not credentials. The rows a buyer owns are campaigns, sequences,
 * templates, contacts, enrollments, engagement activities, replies, sent
 * messages, A/B tests, sending accounts and webhook destinations. Password
 * digests, session tokens, API-key hashes, invitation token hashes, webhook
 * signing secrets, sending account encrypted configs and Stripe ids are not
 * exported. A sending account keeps its name and provider but drops its
 * encrypted config. A webhook keeps its destination/events but drops its
 * signing secret.
 *
 * Every query is scoped by workspaceId. A bug in the caller cannot turn one
 * buyer's export into another's.
 */
export const EXPORT_FORMAT = "leadgenius.workspace";
export const EXPORT_VERSION = 1;

/** Collapse a slug to a filename-safe token, then fail closed to "workspace". */
function safeSlug(slug: string): string {
  return (
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace"
  );
}

/** The download filename, pure so the header path is testable without a database. */
export function exportFilename(
  slug: string,
  part: "workspace" | "activities" | "replies" | "sent-messages",
  at: Date = new Date(),
): string {
  const extension = part === "workspace" ? "json" : "csv";
  return `leadgenius-${safeSlug(slug)}-${part}-${at.toISOString().slice(0, 10)}.${extension}`;
}

/** Every export shares these headers; `no-store` keeps a proxy from retaining a copy. */
export function exportDownloadHeaders(filename: string, contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

/** Drop a sending account's encrypted config while keeping the rest. */
export function publicSendingAccount(acc: { id: string; name: string; channel: string; provider: string; dailyLimit: number; warmupEnabled: boolean; warmupStage: number; reputationScore: number; isDefault: boolean; isActive: boolean; createdAt: Date; updatedAt: Date }): Record<string, unknown> {
  return acc;
}

/** Drop a webhook's signing secret while keeping the rest. */
export function publicWebhook(hook: { id: string; url: string; events: string; isActive: boolean; createdAt: Date; updatedAt: Date }): Record<string, unknown> {
  return hook;
}

export async function buildWorkspaceExport(workspaceId: string, exportedAt: Date = new Date()) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true },
  });
  if (!workspace) throw new Error("Workspace not found");

  const [members, invitations, campaigns, sequences, templates, abTests, contacts, contactLists, sendingAccounts, webhooks, enrollmentCount, activityCount, replyCount, sentMessageCount] =
    await Promise.all([
      prisma.membership.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          userId: true,
          role: true,
          createdAt: true,
          user: { select: { email: true, name: true, emailVerified: true } },
        },
      }),
      prisma.invite.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          email: true,
          role: true,
          createdById: true,
          createdAt: true,
          expiresAt: true,
          acceptedAt: true,
        },
      }),
      prisma.campaign.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          status: true,
          goal: true,
          startDate: true,
          endDate: true,
          createdAt: true,
          updatedAt: true,
          sequences: {
            orderBy: { stepOrder: "asc" },
            select: {
              sequenceId: true,
              stepOrder: true,
              delayDays: true,
              delayHours: true,
              conditions: true,
              sequence: {
                select: { id: true, name: true, channel: true, status: true, stepsConfig: true },
              },
            },
          },
        },
      }),
      prisma.sequence.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          channel: true,
          status: true,
          stepsConfig: true,
          createdAt: true,
          updatedAt: true,
          steps: {
            orderBy: { stepNumber: "asc" },
            select: {
              stepNumber: true,
              channel: true,
              templateId: true,
              delayDays: true,
              delayHours: true,
              conditions: true,
            },
          },
        },
      }),
      prisma.template.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          channel: true,
          subject: true,
          body: true,
          variables: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.aBTest.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          campaignId: true,
          name: true,
          hypothesis: true,
          status: true,
          trafficSplit: true,
          winningVariant: true,
          confidence: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
          variants: {
            select: {
              id: true,
              sequenceId: true,
              templateId: true,
              name: true,
              weight: true,
              isControl: true,
              stats: true,
            },
          },
        },
      }),
      prisma.contact.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          email: true,
          phone: true,
          linkedinUrl: true,
          firstName: true,
          lastName: true,
          company: true,
          title: true,
          customFields: true,
          status: true,
          source: true,
          lastContactAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.contactList.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          isDynamic: true,
          filterJson: true,
          createdAt: true,
          updatedAt: true,
          members: {
            select: { contactId: true, addedAt: true },
          },
        },
      }),
      prisma.sendingAccount.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        // config is deliberately absent: it contains the encrypted payload,
        // not content the buyer needs to take with them.
        select: {
          id: true,
          name: true,
          channel: true,
          provider: true,
          dailyLimit: true,
          warmupEnabled: true,
          warmupStage: true,
          reputationScore: true,
          isDefault: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.webhook.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "asc" },
        // The signing secret is a credential. The destination and event
        // list are configuration the buyer can recognize in a new home.
        select: {
          id: true,
          url: true,
          events: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.enrollment.count({ where: { campaign: { workspaceId } } }),
      prisma.activity.count({ where: { enrollment: { campaign: { workspaceId } } } }),
      prisma.reply.count({ where: { workspaceId } }),
      prisma.sentMessage.count({ where: { sendingAccount: { workspaceId } } }),
    ]);

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    workspace,
    counts: {
      members: members.length,
      invitations: invitations.length,
      campaigns: campaigns.length,
      sequences: sequences.length,
      templates: templates.length,
      abTests: abTests.length,
      contacts: contacts.length,
      contactLists: contactLists.length,
      sendingAccounts: sendingAccounts.length,
      webhooks: webhooks.length,
      enrollments: enrollmentCount,
      activities: activityCount,
      replies: replyCount,
      sentMessages: sentMessageCount,
    },
    notes: [
      "Credentials are excluded: password digests, session tokens, API keys and their hashes, invitation token hashes, webhook signing secrets, sending account encrypted configs, and Stripe billing ids.",
      "Engagement activities, replies and sent messages are not embedded in this document. Download them from GET /api/export/activities, which streams CSV in batches.",
    ],
    activities: {
      count: activityCount,
      download: "/api/export/activities",
      contentType: "text/csv; charset=utf-8",
    },
    replies: {
      count: replyCount,
      download: "/api/export/replies",
      contentType: "text/csv; charset=utf-8",
    },
    sentMessages: {
      count: sentMessageCount,
      download: "/api/export/sent-messages",
      contentType: "text/csv; charset=utf-8",
    },
    members,
    invitations,
    campaigns,
    sequences,
    templates,
    abTests,
    contacts,
    contactLists,
    sendingAccounts: sendingAccounts.map(publicSendingAccount),
    webhooks: webhooks.map(publicWebhook),
  };
}

export type WorkspaceExport = Awaited<ReturnType<typeof buildWorkspaceExport>>;

/* ------------------------------------------------------------------ engagement activities */

export interface ActivityCsvRow {
  id: string;
  enrollmentId: string | null;
  contactId: string;
  type: string;
  channel: string;
  messageId: string | null;
  idempotencyKey: string | null;
  metadata: unknown;
  createdAt: Date | string;
}

const FORMULA_START = /^[=+\-@\t\r]/;

function textCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function iso(value: Date | string | null): string {
  if (value === null) return "";
  return value instanceof Date ? value.toISOString() : value;
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

const ACTIVITY_HEADER = [
  "activity_id",
  "enrollment_id",
  "contact_id",
  "type",
  "channel",
  "message_id",
  "idempotency_key",
  "metadata",
  "created_at",
];

export function activityCsvHeader(): string {
  return `${ACTIVITY_HEADER.map(textCell).join(",")}\r\n`;
}

export function activityCsvRow(row: ActivityCsvRow): string {
  return (
    [
      textCell(row.id),
      textCell(row.enrollmentId),
      textCell(row.contactId),
      textCell(row.type),
      textCell(row.channel),
      textCell(row.messageId),
      textCell(row.idempotencyKey),
      textCell(jsonText(row.metadata)),
      textCell(iso(row.createdAt)),
    ].join(",") + "\r\n"
  );
}

/* ------------------------------------------------------------------ replies */

export interface ReplyCsvRow {
  id: string;
  enrollmentId: string | null;
  contactId: string;
  workspaceId: string;
  channel: string;
  content: string;
  sentiment: string | null;
  intent: string | null;
  isAutoReply: boolean;
  processed: boolean;
  createdAt: Date | string;
}

const REPLY_HEADER = [
  "reply_id",
  "enrollment_id",
  "contact_id",
  "workspace_id",
  "channel",
  "content",
  "sentiment",
  "intent",
  "is_auto_reply",
  "processed",
  "created_at",
];

export function replyCsvHeader(): string {
  return `${REPLY_HEADER.map(textCell).join(",")}\r\n`;
}

export function replyCsvRow(row: ReplyCsvRow): string {
  return (
    [
      textCell(row.id),
      textCell(row.enrollmentId),
      textCell(row.contactId),
      textCell(row.workspaceId),
      textCell(row.channel),
      textCell(row.content),
      textCell(row.sentiment),
      textCell(row.intent),
      textCell(row.isAutoReply),
      textCell(row.processed),
      textCell(iso(row.createdAt)),
    ].join(",") + "\r\n"
  );
}

/* ------------------------------------------------------------------ sent messages */

export interface SentMessageCsvRow {
  id: string;
  sendingAccountId: string;
  enrollmentId: string | null;
  contactId: string;
  templateId: string | null;
  channel: string;
  subject: string | null;
  body: string;
  providerMessageId: string | null;
  status: string;
  error: string | null;
  sentAt: Date | string | null;
  createdAt: Date | string;
}

const SENT_MESSAGE_HEADER = [
  "sent_message_id",
  "sending_account_id",
  "enrollment_id",
  "contact_id",
  "template_id",
  "channel",
  "subject",
  "body",
  "provider_message_id",
  "status",
  "error",
  "sent_at",
  "created_at",
];

export function sentMessageCsvHeader(): string {
  return `${SENT_MESSAGE_HEADER.map(textCell).join(",")}\r\n`;
}

export function sentMessageCsvRow(row: SentMessageCsvRow): string {
  return (
    [
      textCell(row.id),
      textCell(row.sendingAccountId),
      textCell(row.enrollmentId),
      textCell(row.contactId),
      textCell(row.templateId),
      textCell(row.channel),
      textCell(row.subject),
      textCell(row.body),
      textCell(row.providerMessageId),
      textCell(row.status),
      textCell(row.error),
      textCell(iso(row.sentAt)),
      textCell(iso(row.createdAt)),
    ].join(",") + "\r\n"
  );
}