import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { processSequenceStep } from "@/lib/sequence-engine";
import { validateBody } from "@/lib/validate";
import { ENROLLMENT_CREATE } from "@/lib/fields";

export const dynamic = "force-dynamic";

/**
 * Enroll a contact into a sequence. This is the step the UI's "Enroll"
 * button (and every real customer) needs: before this route existed,
 * enrollments could only be created by the seed script, so sequences could
 * never reach a contact added through the product itself.
 *
 * POST { workspaceId, contactId, sequenceId, campaignId? }
 * campaignId defaults to the sequence's first linked campaign.
 * The first step kicks immediately; without an active sending account for
 * the step's channel the enrollment stays ACTIVE at step 0 and the response
 * says so instead of pretending it sent.
 */
async function POST_impl(request: Request) {
  const body = await request.json();
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, ENROLLMENT_CREATE);
  if (!input.ok) return input.error;
  const { contactId, sequenceId } = input.data;
  let { campaignId } = input.data;

  // `contactId: 42` used to be a 500, from inside the `findFirst` below: an id
  // is input, and the where clause is not the place to find out it is a number.
  const [contact, sequence] = await Promise.all([
    prisma.contact.findFirst({ where: { id: contactId, workspaceId } }),
    prisma.sequence.findFirst({
      where: { id: sequenceId, workspaceId },
      include: { campaignLinks: { orderBy: { stepOrder: "asc" } }, steps: true },
    }),
  ]);
  if (!contact) return NextResponse.json({ error: "contact not found in this workspace" }, { status: 404 });
  if (!sequence) return NextResponse.json({ error: "sequence not found in this workspace" }, { status: 404 });
  if (sequence.steps.length === 0) {
    return NextResponse.json({ error: "sequence has no steps — add steps before enrolling" }, { status: 409 });
  }

  if (campaignId) {
    const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!campaign) return NextResponse.json({ error: "campaign not found in this workspace" }, { status: 404 });
  } else if (sequence.campaignLinks.length > 0) {
    campaignId = sequence.campaignLinks[0].campaignId;
  } else {
    return NextResponse.json({ error: "campaignId required: this sequence is not linked to any campaign" }, { status: 400 });
  }

  const existing = await prisma.enrollment.findFirst({
    where: { contactId, sequenceId, status: "ACTIVE" },
  });
  if (existing) {
    return NextResponse.json({ error: "contact is already actively enrolled in this sequence", enrollmentId: existing.id }, { status: 409 });
  }

  const enrollment = await prisma.enrollment.create({
    data: { campaignId, sequenceId, contactId, status: "ACTIVE", currentStep: 0 },
  });

  let warning: string | undefined;
  try {
    await processSequenceStep(enrollment.id, "ENROLLED");
  } catch (error) {
    warning = error instanceof Error ? error.message : "first step could not start";
  }

  const full = await prisma.enrollment.findUnique({
    where: { id: enrollment.id },
    include: { contact: true, sequence: true, campaign: true },
  });
  return NextResponse.json({ enrollment: full, ...(warning ? { warning } : {}) }, { status: 201 });
}

export const POST = withAuth(POST_impl);
