import { prisma } from "./db";

export interface EnrichmentResult {
  email?: string;
  company?: string;
  title?: string;
  socialProfiles?: Record<string, string>;
  technographics?: string[];
  intentSignals?: string[];
}

/**
 * There is no email-verification provider here (#56). `null` rather than a placeholder
 * that answered `true`, because this is the only thing between `guessEmail`'s first
 * pattern and `Contact.email`, and `Contact.email` is what campaigns send to:
 * `src/lib/channels/email.ts:28` hands it to nodemailer's `to` without looking at it. An
 * unverified guess in that column is an outbound message to an address nobody checked
 * exists, and the bounce is paid for by the sending account's reputation.
 *
 * The verifier's absence is what the gate below reads, so landing a provider in #56 turns
 * the guess on in the worker and in the producer at the same time, in one place.
 */
const emailVerifier: ((email: string) => Promise<boolean>) | null = null;

/**
 * The gap this function can write into, stated once so the route that queues the job and
 * the worker that runs it cannot disagree. This is why `enrichment` needs a producer at
 * all: dev db 0 held exactly one key for it, `bull:enrichment:meta`, which is bullmq's
 * stored signature for a queue that has never received a job, while the only caller of
 * `enrichContact` ran it inline inside a request (`GET`-side `POST /api/contacts/:id
 * ?action=enrich`).
 *
 * `linkedinUrl` is deliberately not here. `findLinkedIn` had no provider and returned "",
 * the branch was a write that could never happen, and the family's precedent for that
 * shape is `lookupPhone` — deleted at #56, kept absent by the queue.test.ts arm that
 * also forbids linkedin's helpers. Contact.linkedinUrl remains a real column; enrichment
 * is not what fills it. See #56 for the providers.
 */
export function hasEnrichableGap(contact: {
  email?: string | null;
  company?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): boolean {
  return (
    (!contact.company && !!contact.email) ||
    (!!emailVerifier && !contact.email && !!contact.firstName && !!contact.lastName && !!contact.company)
  );
}

/**
 * Public consumer domains. Without this, `dana@gmail.com` yields a company of "gmail",
 * and `sequence-engine.ts:126` renders `{{company}}` straight into the body a prospect
 * reads. A list is a blunt instrument — the durable version is a domain table, which
 * belongs with the providers in #56 — but it is the difference between a wrong guess and
 * no write, and the producer makes this branch reachable for the first time.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me",
  "protonmail.com", "gmx.com", "mail.com", "yandex.com", "zoho.com", "fastmail.com",
]);

export async function enrichContact(contactId: string): Promise<EnrichmentResult | null> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact || !hasEnrichableGap(contact)) return null;

  const results: EnrichmentResult = {};

  if (!contact.email && contact.firstName && contact.lastName && contact.company && emailVerifier) {
    results.email = await guessEmail(contact.firstName, contact.lastName, contact.company, emailVerifier);
  }

  if (!contact.company && contact.email) {
    results.company = extractCompanyFromEmail(contact.email);
  }

  await prisma.contact.update({
    where: { id: contactId },
    data: {
      ...(results.email && { email: results.email }),
      ...(results.company && { company: results.company }),
      ...(results.title && { title: results.title }),
    },
  });

  return results;
}

async function guessEmail(
  firstName: string,
  lastName: string,
  company: string,
  verify: (email: string) => Promise<boolean>,
): Promise<string | undefined> {
  const domain = await getCompanyDomain(company);
  if (!domain) return "";

  const patterns = [
    `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${domain}`,
    `${firstName.toLowerCase()}${lastName.toLowerCase()}@${domain}`,
    `${firstName.toLowerCase()}.${lastName[0].toLowerCase()}@${domain}`,
    `${firstName[0].toLowerCase()}.${lastName.toLowerCase()}@${domain}`,
  ];

  for (const email of patterns) {
    if (await verify(email)) return email;
  }
  return "";
}

async function getCompanyDomain(company: string): Promise<string | null> {
  try {
    const response = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(company)}`);
    const data = await response.json();
    return data[0]?.domain || null;
  } catch {
    return null;
  }
}

function extractCompanyFromEmail(email: string): string | undefined {
  const domain = email.split("@")[1];
  if (!domain || PUBLIC_EMAIL_DOMAINS.has(domain.toLowerCase())) return "";
  return domain.split(".")[0];
}