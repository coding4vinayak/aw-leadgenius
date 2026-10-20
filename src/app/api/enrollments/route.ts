import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { processSequenceStep } from "@/lib/sequence-engine";
import { assignVariant } from "@/lib/abtest";
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
  // A contact the workspace marked dead does not start an outreach.
  // `Contact.status` is the operator's lifecycle column — bounced, unsubscribed,
  // do-not-contact — and until this check enrolling a DO_NOT_CONTACT contact was
  // a clean 201 whose sequence would email them anyway, which is exactly the
  // "spam complaints" half of the sentence this product sells against. A status
  // that changes *after* enrollment is the engine's problem to stop (see
  // `sequence-engine`); this boundary is the one that refuses to start.
  if (contact.status !== "ACTIVE") {
    return NextResponse.json(
      { error: `contact is ${contact.status} — only an ACTIVE contact can start an outreach; set the contact back to ACTIVE first` },
      { status: 409 },
    );
  }

  if (campaignId) {
    const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!campaign) return NextResponse.json({ error: "campaign not found in this workspace" }, { status: 404 });
  } else if (sequence.campaignLinks.length > 0) {
    campaignId = sequence.campaignLinks[0].campaignId;
  } else {
    return NextResponse.json({ error: "campaignId required: this sequence is not linked to any campaign" }, { status: 400 });
  }

  // A/B: a RUNNING test on the campaign decides the arm, and the arm decides
  // the sequence — that override is the entire product of an A/B test (two
  // copies of the outreach, one number telling them apart). The assignment is
  // deterministic per (test, contact), so a retried enroll cannot move a
  // contact between arms and contaminate the comparison. An arm whose
  // sequence is gone or empty is a loud 409: enrolling such an arm into the
  // *requested* sequence would quietly put a non-comparable contact in the
  // control cohort.
  let armSequenceId = sequenceId;
  let abVariantId: string | undefined;
  const test = await prisma.aBTest.findFirst({
    where: { campaignId, workspaceId, status: "RUNNING" },
    orderBy: { startedAt: "asc" },
    include: { variants: { orderBy: { name: "asc" } } },
  });
  if (test && test.variants.length >= 2) {
    const chosen = assignVariant(test.id, contactId, test.variants);
    if (chosen) {
      abVariantId = chosen.id;
      if (chosen.sequenceId !== sequenceId) {
        const armSequence = await prisma.sequence.findFirst({
          where: { id: chosen.sequenceId, workspaceId },
          include: { steps: true },
        });
        if (!armSequence) {
          return NextResponse.json({ error: `arm "${chosen.name}" points at a sequence that no longer exists — pause the test before enrolling` }, { status: 409 });
        }
        if (armSequence.steps.length === 0) {
          return NextResponse.json({ error: `arm "${chosen.name}" points at a sequence with no steps` }, { status: 409 });
        }
        armSequenceId = chosen.sequenceId;
      }
    }
  }

  const existing = await prisma.enrollment.findFirst({
    where: { contactId, sequenceId: armSequenceId, status: "ACTIVE" },
  });
  if (existing) {
    return NextResponse.json({ error: "contact is already actively enrolled in this sequence", enrollmentId: existing.id }, { status: 409 });
  }

  const enrollment = await prisma.enrollment.create({
    data: { campaignId, sequenceId: armSequenceId, contactId, status: "ACTIVE", currentStep: 0, ...(abVariantId ? { abVariantId } : {}) },
  });

  let warning: string | undefined;
  try {
    await processSequenceStep(enrollment.id, "ENROLLED");
  } catch (error) {
    warning = error instanceof Error ? error.message : "first step could not start";
  }

  const full = await prisma.enrollment.findUnique({
    where: { id: enrollment.id },
    include: { contact: true, sequence: true, campaign: true, abVariant: { select: { name: true, isControl: true } } },
  });
  return NextResponse.json({ enrollment: full, ...(warning ? { warning } : {}) }, { status: 201 });
}

export const POST = withAuth(POST_impl);
