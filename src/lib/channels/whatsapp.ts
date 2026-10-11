import Twilio from "twilio";
import { prisma } from "../db";

export interface SendResult {
  success: boolean;
  providerId?: string;
  error?: string;
}

export async function sendWhatsApp(msg: { id: string; body: string; sendingAccountId: string; contactId: string }): Promise<SendResult> {
  const account = await prisma.sendingAccount.findUnique({ where: { id: msg.sendingAccountId } });
  if (!account || !account.isActive) return { success: false, error: "Account not found or inactive" };

  const config = account.config as { accountSid: string; authToken: string; fromNumber: string; };
  const contact = await prisma.contact.findUnique({ where: { id: msg.contactId } });
  if (!contact?.phone) return { success: false, error: "Contact has no phone number" };

  const client = Twilio(config.accountSid, config.authToken);

  try {
    const message = await client.messages.create({
      from: `whatsapp:${config.fromNumber}`,
      to: `whatsapp:${contact.phone}`,
      body: msg.body,
    });

    return { success: true, providerId: message.sid };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export async function handleIncomingWhatsApp(webhookData: any): Promise<{ contactId?: string; content: string }> {
  const from = webhookData.From?.replace("whatsapp:", "");
  const body = webhookData.Body || "";
  const messageSid = webhookData.MessageSid;

  const contact = await prisma.contact.findFirst({ where: { phone: from } });
  if (!contact) return { content: body };

  return { contactId: contact.id, content: body };
}