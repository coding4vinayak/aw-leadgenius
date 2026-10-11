import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { pageParams } from "@/lib/pagination";
import { validateBody, validateItems, type Validated } from "@/lib/validate";
import { SEQUENCE_CREATE, SEQUENCE_STEP } from "@/lib/fields";

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
  const { campaignId } = input.data;

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

  for (const [i, step] of steps.items.entries()) {
    // A step may name no template or a real one; anything else is a 400, not
    // a skip. Silently ignoring a `templateId: 42` would write a step whose
    // caller believes it has a template, and passing it to Prisma answers with
    // a validation error — a 500 for a wrong type.
    if (step.templateId) {
      const tpl = await prisma.template.findUnique({ where: { id: step.templateId } });
      if (!tpl) return NextResponse.json({ error: `stepsConfig[${i}]: template not found` }, { status: 400 });
      if (tpl.workspaceId !== workspaceId) {
        return NextResponse.json({ error: `stepsConfig[${i}]: template belongs to another workspace` }, { status: 403 });
      }
    }
  }

  const sequence = await prisma.sequence.create({
    data: {
      workspaceId,
      ...input.data,
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
