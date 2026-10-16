import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { queues, enqueue, QueueUnavailableError } from "@/lib/queue";
import { hasEnrichableGap } from "@/lib/enrichment";
import { pageParams } from "@/lib/pagination";
import { asStrings, missingIds, unknownIdsError } from "@/lib/ids";
import { validateBody } from "@/lib/validate";
import { CONTACT_CREATE } from "@/lib/fields";
import { triggerWebhooks } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const listId = searchParams.get("listId");
  const status = searchParams.get("status");
  const { page, limit } = pageParams(searchParams, 50);


  const where: any = { workspaceId };
  if (listId) where.listMemberships = { some: { listId } };
  if (status) where.status = status;

  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.contact.count({ where }),
  ]);

  return NextResponse.json({ contacts, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const body = await request.json();
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, CONTACT_CREATE);
  if (!input.ok) return input.error;
  const { email, phone, linkedinUrl } = input.data;

  if (!email && !phone && !linkedinUrl) {
    return NextResponse.json({ error: "at least one contact method required" }, { status: 400 });
  }

  // Every list the caller names has to exist here, or the contact is created
  // outside all of them and silently misses every campaign keyed to those
  // lists — the same silent-miss failure the nested write below exists to
  // prevent, so it is checked at the boundary instead of left to a P2003. The
  // lookup is scoped to this workspace, so another tenant's list is
  // indistinguishable from one that does not exist.
  const lists = asStrings(body.listIds, "listIds");
  if (lists.error) return lists.error;
  if (lists.values.length) {
    const found = await prisma.contactList.findMany({ where: { workspaceId, id: { in: lists.values } }, select: { id: true } });
    const missing = missingIds(lists.values, found);
    if (missing.length) return unknownIdsError("listIds", missing);
  }

  // The list memberships commit with the contact or not at all: a 201 that left
  // the contact outside every list the caller named is a record that silently
  // misses every campaign keyed to those lists. One nested write does that; an
  // interactive $transaction also does but is a SQLite write-lock queue that
  // collapses under concurrent writers (2.5 rps at c=10, mostly P1008 timeouts).
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      ...input.data,
      ...(lists.values.length
        ? { listMemberships: { create: lists.values.map((listId) => ({ listId })) } }
        : {}),
    },
  });

  // The producer the `enrichment` Worker never had. This route imported `queues` and
  // never called it, which is the shape rule 10 of shared/check-queues.sh now fails on:
  // a Worker polling a keyspace nothing writes to. A create is where the gap between what
  // was sent and what enrichment can fill first exists, so it is where the job belongs.
  //
  // Not a 503, unlike the sequence enqueue in the webhook routes. The row is committed,
  // and a Redis outage answering "your create failed" would have the caller create a
  // second contact. The job is re-derivable from the stored row and
  // `POST /api/contacts/:id?action=enrich` is the manual path, so the queue being down
  // costs a delayed fill, not the write.
  if (hasEnrichableGap(contact)) {
    try {
      await enqueue(queues.enrichment, "enrich-contact", { contactId: contact.id });
    } catch (error) {
      if (!(error instanceof QueueUnavailableError)) throw error;
      console.warn(`contact ${contact.id} created; enrichment not queued — Redis is unreachable`);
    }
  }

  // After the row and any enrichment job are committed, and best-effort by
  // construction: `triggerWebhooks` never throws, so a subscriber that is down
  // cannot turn a 201 into a 500.
  void triggerWebhooks(workspaceId, "contact.created", { contact });

  return NextResponse.json(contact, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
