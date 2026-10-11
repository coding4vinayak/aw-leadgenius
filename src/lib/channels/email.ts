import nodemailer from "nodemailer";
import { prisma } from "../db";

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
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const [sent, bounced] = await Promise.all([
    prisma.sentMessage.count({ where: { sendingAccountId: accountId, createdAt: { gte: today, lt: tomorrow }, status: "SENT" } }),
    prisma.sentMessage.count({ where: { sendingAccountId: accountId, createdAt: { gte: today, lt: tomorrow }, status: "BOUNCED" } }),
  ]);

  const account = await prisma.sendingAccount.findUnique({ where: { id: accountId }, select: { reputationScore: true } });

  return {
    reputation: account?.reputationScore || 100,
    dailySent: sent,
    bounces: bounced,
    complaints: 0,
  };
}