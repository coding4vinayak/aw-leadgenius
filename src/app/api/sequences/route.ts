import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { pageParams } from "@/lib/pagination";
import { validateBody, validateItems, type Validated } from "@/lib/validate";
import { SEQUENCE_CREATE, SEQUENCE_STEP } from "@/lib/fields";
import { conditionProblem } from "@/lib/sequence-engine";
import { isChannelMismatch, sequenceChannelProblem, stepChannelProblem } from "@/lib/channel-fit";

export const dynamic = "force-dynamic";

/** What one validated `stepsConfig` entry is guaranteed to hold. */
type SequenceStepInput = Validated<typeof SEQUENCE_STEP>;

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = await authedWorkspaceId(request, searchParams.get("workspaceId"));
  const channel = searchParams.get("channel");
  const { page, limit } = pageParams(searchParams, 20);


  const where: any = { workspaceId };
  if (channel) where.channel = channel;

  const [sequences, total] = await Promise.all([
    prisma.sequence.findMany({
      where,
      include: { steps: { orderBy: { stepNumber: "asc" } }, _count: { select: { enrollments: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.sequence.count({ where }),
  ]);

  return NextResponse.json({ sequences, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function POST_impl(request: Request) {
  const body = await request.json();
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, SEQUENCE_CREATE);
  if (!input.ok) return input.error;
  // `campaignId` is a create-time link, not a column on Sequence: spreading it
  // into the create below is Prisma's "Unknown argument `campaignId`" — a 500
  // for every caller that used the documented way to attach a sequence to a
  // campaign. The block after the steps writes the CampaignSequence row.
  const { campaignId, ...sequenceData } = input.data;

  // Steps come from the same declared-field table as everything else, because
  // the loop this replaces got two shapes wrong in opposite directions. A
  // mistyped `stepNumber` or `channel` answered
  // `stepsConfig[3] needs stepNumber and channel` — one message for a missing
  // key, a string and an object, naming neither the field nor the problem.
  // `delayDays: "2"` was not an error at all: the spread that wrote it guarded
  // on `typeof s.delayDays === "number"`, so the row took the column's own
  // default of 0, and `nextActionAt` (sequence-engine.ts:134) then scheduled a
  // two-week sequence to run in a day. `channel: "FAX"` passed a
  // `typeof === "string"` check and is a step no sender picks up.
  const steps = validateItems<SequenceStepInput>(body.stepsConfig, "stepsConfig", SEQUENCE_STEP, { max: 50 });
  if (!steps.ok) return steps.error;

  const stepNumbers = steps.items.map((step) => step.stepNumber);
  for (const [i, step] of steps.items.entries()) {
    // A step may name no template or a real one; anything else is a 400, not
    // a skip. Silently ignoring a `templateId: 42` would write a step whose
    // caller believes it has a template, and passing it to Prisma answers with
    // a validation error — a 500 for a wrong type. The row is read with the
    // two columns that decide whether its copy fits this step, so the same
    // lookup answers both "does it exist" and "is it for this channel".
    let tpl: { name: string; channel: string } | null = null;
    if (step.templateId) {
      const found = await prisma.template.findUnique({
        where: { id: step.templateId },
        select: { name: true, channel: true, workspaceId: true },
      });
      if (!found) return NextResponse.json({ error: `stepsConfig[${i}]: template not found` }, { status: 400 });
      if (found.workspaceId !== workspaceId) {
        return NextResponse.json({ error: `stepsConfig[${i}]: template belongs to another workspace` }, { status: 403 });
      }
      tpl = found;
    }

    // `SequenceStep.channel` picks the sender and `Template.channel` describes
    // the copy, and each door only ever checked its own value against its own
    // vocabulary, so nothing compared the pair. The engine then takes the body
    // from the template and the subject only from an EMAIL step, so an EMAIL
    // step on a LinkedIn template mails "New message" and a WHATSAPP step on an
    // email sends its HTML as one bubble.
    if (tpl && isChannelMismatch(step, tpl)) {
      return NextResponse.json({ error: `stepsConfig[${i}]: ${stepChannelProblem(step, tpl)}` }, { status: 400 });
    }

    // A sequence's declared `channel` is what the daily rollup groups its sends
    // by, so it is a claim about the steps beneath it and is checked as one.
    const mismatch = sequenceChannelProblem(input.data.channel, step);
    if (mismatch) {
      return NextResponse.json({ error: `stepsConfig[${i}]: ${mismatch}` }, { status: 400 });
    }

    // Conditions are free-form JSON until this point, and the engine reads
    // `if` / `then` / `branchToStep` out of them: a typo must be a 400 naming
    // the accepted set, not a step that silently spends itself on the next
    // trigger of any kind.
    const problem = conditionProblem(step, stepNumbers);
    if (problem) {
      return NextResponse.json({ error: `stepsConfig[${i}]: ${problem}` }, { status: 400 });
    }
  }

  const sequence = await prisma.sequence.create({
    data: {
      workspaceId,
      ...sequenceData,
      // The caller's own step objects, not the validated subset: this column is
      // free-form JSON, and dropping a key the route happens not to declare is
      // the silent kind of wrong. The SequenceStep rows below take the
      // validated values, which is what the engine reads. A body that named no
      // steps stores `[]`, which is what this route has always written.
      stepsConfig: input.data.stepsConfig ?? [],
    },
  });

  // The engine walks the SequenceStep relation, not the JSON — materialize
  // rows now so an enrolled contact actually has steps to receive.
  if (steps.items.length > 0) {
    await prisma.sequenceStep.createMany({
      data: steps.items.map((step) => ({
        sequenceId: sequence.id,
        stepNumber: step.stepNumber,
        channel: step.channel,
        // An empty templateId is "no template", not a reference: writing ""
        // here fails the SequenceStep -> Template foreign key, which reaches
        // the caller as a 500 for a step that asked for nothing.
        ...(step.templateId ? { templateId: step.templateId } : {}),
        ...(step.delayDays !== undefined ? { delayDays: step.delayDays } : {}),
        ...(step.delayHours !== undefined ? { delayHours: step.delayHours } : {}),
        ...(step.conditions != null ? { conditions: step.conditions } : {}),
      })),
    });
  }

  if (campaignId) {
    const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!campaign) return NextResponse.json({ error: "campaign not found in this workspace" }, { status: 400 });
    await prisma.campaignSequence.upsert({
      where: { campaignId_sequenceId: { campaignId, sequenceId: sequence.id } },
      update: {},
      create: { campaignId, sequenceId: sequence.id, stepOrder: 1 },
    });
  }

  const full = await prisma.sequence.findUnique({
    where: { id: sequence.id },
    include: { steps: { orderBy: { stepNumber: "asc" } } },
  });
  return NextResponse.json(full, { status: 201 });
}

export const GET = withAuth(GET_impl);
export const POST = withAuth(POST_impl);
