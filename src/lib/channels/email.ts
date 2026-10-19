import nodemailer from "nodemailer";
import { prisma } from "../db";
import { reputationLedgerWhere, reputationWindowWhere } from "../reputation";

export interface SendResult {
  success: boolean;
  providerId?: string;
  error?: string;
}

export async function sendEmail(msg: { id: string; subject?: string; body: string; sendingAccountId: string; contactId: string }): Promise<SendResult> {
  const account = await prisma.sendingAccount.findUnique({ where: { id: msg.sendingAccountId } });
  if (!account || !account.isActive) return { success: false, error: "Account not found or inactive" };

  const config = account.config as { host: string; port: number; secure: boolean; user: string; pass: string; fromName?: string; fromEmail: string };
  const contact = await prisma.contact.findUnique({ where: { id: msg.contactId } });
  if (!contact?.email) return { success: false, error: "Contact has no email" };

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });

  try {
    const info = await transporter.sendMail({
      from: `${config.fromName || "LeadGenius"} <${config.fromEmail}>`,
      to: contact.email,
      subject: msg.subject || "New message",
      html: msg.body,
      headers: { "X-LeadGenius-Message-Id": msg.id },
    });

    return { success: true, providerId: info.messageId };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  } finally {
    await transporter.close();
  }
}

export async function getEmailAccountHealth(accountId: string): Promise<{ reputation: number; dailySent: number; bounces: number; complaints: number }> {
  // The health panel used to be a third definition of the account's traffic:
  // `SENT`-only counts over TODAY, `complaints: 0` hardcoded, printed next to
  // a `reputation` the app had never computed. Now that the score IS the
  // rolling deliverability rate this window defines, the panel counts
  // THROUGH it — same 14 days, same NOT-FAILED ledger as the cap — so an
  // operator reading "8 bounces" beside a score of 30 is looking at one
  // number's inputs, not a second truth. (`?? 100`, not `|| 100`: a
  // genuinely-bad account that clamps to 0 must not display as perfect.)
  const now = new Date();
  const [sent, bounced, complained] = await Promise.all([
    prisma.sentMessage.count({ where: reputationLedgerWhere(accountId, now) }),
    prisma.sentMessage.count({ where: { ...reputationWindowWhere(accountId, now), status: "BOUNCED" } }),
    prisma.sentMessage.count({ where: { ...reputationWindowWhere(accountId, now), status: "COMPLAINED" } }),
  ]);

  const account = await prisma.sendingAccount.findUnique({ where: { id: accountId }, select: { reputationScore: true } });

  return {
    reputation: account?.reputationScore ?? 100,
    dailySent: sent,
    bounces: bounced,
    complaints: complained,
  };
}