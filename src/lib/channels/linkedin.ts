import { prisma } from "../db";

export interface SendResult {
  success: boolean;
  providerId?: string;
  error?: string;
}

export async function sendLinkedIn(msg: { id: string; body: string; sendingAccountId: string; contactId: string }): Promise<SendResult> {
  const account = await prisma.sendingAccount.findUnique({ where: { id: msg.sendingAccountId } });
  if (!account || !account.isActive) return { success: false, error: "Account not found or inactive" };

  const config = account.config as { accessToken: string; userUrn: string };
  const contact = await prisma.contact.findUnique({ where: { id: msg.contactId } });
  if (!contact?.linkedinUrl) return { success: false, error: "Contact has no LinkedIn URL" };

  // LinkedIn API requires the recipient's member URN
  // This is a simplified version - real implementation needs member URN resolution
  const recipientUrn = extractMemberUrn(contact.linkedinUrl);
  if (!recipientUrn) return { success: false, error: "Could not resolve LinkedIn member URN" };

  // The same stand-in principle the SMTP sink gives email, declared the only
  // way the egress guard allows: `LINKEDIN_API_BASE` is the operator's
  // infrastructure decision, read from the environment in this file. A base
  // carried in `config` would be a caller-movable address on the wire — the
  // egress test exists to refuse exactly that, and refused this design first.
  const apiBase = process.env.LINKEDIN_API_BASE ?? "https://api.linkedin.com";

  try {
    const response = await fetch(`${apiBase}/v2/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        recipients: [recipientUrn],
        subject: "Message from LeadGenius",
        body: msg.body,
      }),
    });

    if (!response.ok) {
      // The status belongs in the message: `sendFailureDisposition` reads it
      // to tell a rejection that names the recipient (400/404 + "recipient")
      // from one that names our token (401) or the day (429/5xx). The text
      // alone was "LinkedIn API error: <body>", which made every provider
      // failure the same shape.
      const text = await response.text();
      return { success: false, error: `LinkedIn API error ${response.status}: ${text.slice(0, 300)}` };
    }

    const data = await response.json();
    return { success: true, providerId: data.id };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

function extractMemberUrn(linkedinUrl: string): string | null {
  // Simplified - real implementation would use LinkedIn's member resolution API
  const match = linkedinUrl.match(/linkedin\.com\/in\/([^\/]+)/);
  if (!match) return null;
  return `urn:li:person:${match[1]}`;
}