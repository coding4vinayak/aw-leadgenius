import { NextResponse } from "next/server";
import { withAuth, assertOwns } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { validateBody, fieldProblem } from "@/lib/validate";
import { TEMPLATE_PATCH } from "@/lib/fields";
import { templateInUseMessage } from "@/lib/templates";
import { normalizeVariableDeclaration, checkTemplateVariables } from "@/lib/template-vars";
import { strandedByChannel } from "@/lib/channel-fit";
import { subjectProblem } from "@/lib/subject-fit";

export const dynamic = "force-dynamic";

async function GET_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, template.workspaceId);
  return NextResponse.json(template);
}

async function PATCH_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const requestBody = await request.json();
  const _owned = await prisma.template.findUnique({
    where: { id },
    select: { workspaceId: true, name: true, channel: true, body: true, subject: true, variables: true },
  });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  const input = validateBody(requestBody, TEMPLATE_PATCH, { requireWrite: true });
  if (!input.ok) return input.error;

  // The same cross-check as create, against the row the update would leave:
  // editing only `body` must not silently orphan a declaration, and editing
  // only `variables` must not claim a token the stored text never uses. The
  // stored value is the default for each side of the comparison; a key the
  // caller named overrides it. `variables: []` says "no promise" — the column
  // goes empty and the rules go silent, exactly as for a template that was
  // written before they had a reader.
  const hasOwn = (key: "body" | "subject" | "variables" | "channel") => key in input.data;
  if (hasOwn("variables") || hasOwn("body") || hasOwn("subject")) {
    const merged = {
      body: hasOwn("body") ? (input.data.body as string) : _owned.body,
      subject: hasOwn("subject") ? (input.data.subject as string | null) : _owned.subject,
      variables: hasOwn("variables") ? input.data.variables : _owned.variables,
    };
    let declaredNames: readonly string[] = [];
    if (merged.variables !== undefined && merged.variables !== null) {
      const declared = normalizeVariableDeclaration(merged.variables);
      if (!declared.ok) return fieldProblem("variables", declared.error);
      declaredNames = declared.names;
      if (hasOwn("variables")) input.data.variables = declared.names;
    }
    const problems = checkTemplateVariables(declaredNames, [merged.subject, merged.body]);
    if (problems.length) return fieldProblem("variables", problems.join("; "));
  }

  // `channel` says what kind of copy this row is, and steps say which carrier they
  // send it on from the other side of the same reference. Deleting a referenced
  // template is refused outright (DELETE above), so moving its channel is the one
  // edit that changes what a live step sends without the step being touched at all
  // — which is why it is judged against the rows that reference it, by name, under
  // the merged-row rule #22 established for `variables`. Patching the channel it
  // already carries strands nothing, so it is not asked.
  if (input.data.channel !== undefined && input.data.channel !== _owned.channel) {
    const stranded = await strandedByChannel(id, _owned.name, input.data.channel);
    if (stranded.length) return fieldProblem("channel", stranded.join("; "));
  }

  // The row's own two columns are then judged against each other, with the same
  // overlay: `channel` decides whether `subject` is mandatory or meaningless, and
  // only a patch that names one of the two can change the answer. Patching the
  // `name` or the `body` of a template this rule would refuse is not asked to
  // write a subject line the caller never touched — the illegality predates the
  // edit and the message below is what fixes it.
  //
  // This comes after the strand question on purpose: when a channel edit both
  // misdescribes this row and strands live steps, the rows are the reason the edit
  // is not worth making, and clearing a subject would not unstrand them.
  if (hasOwn("channel") || hasOwn("subject")) {
    const verdict = subjectProblem({
      name: _owned.name,
      channel: hasOwn("channel") ? (input.data.channel as string) : _owned.channel,
      subject: hasOwn("subject") ? (input.data.subject as string | null) : _owned.subject,
    });
    if (verdict) return fieldProblem("subject", verdict);
  }

  const template = await prisma.template.update({ where: { id }, data: input.data });
  return NextResponse.json(template);
}

async function DELETE_impl(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const _owned = await prisma.template.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!_owned) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await assertOwns(request, _owned.workspaceId);

  // Both template references are optional foreign keys whose database action
  // is `SetNull`, so the delete itself would erase the reference before any
  // send could notice — the send after it falls back to placeholder copy (or,
  // for an arm, to the step's copy). The refusal lives here, where the
  // reference still exists to be named.
  const [sequenceSteps, arms] = await Promise.all([
    prisma.sequenceStep.findMany({
      where: { templateId: id },
      select: { stepNumber: true, sequence: { select: { name: true } } },
    }),
    prisma.aBTestVariant.findMany({
      where: { templateId: id },
      select: { name: true, abTest: { select: { name: true } } },
    }),
  ]);
  if (sequenceSteps.length > 0 || arms.length > 0) {
    return NextResponse.json(
      {
        error: templateInUseMessage({
          sequenceSteps: sequenceSteps.map((step) => ({ sequenceName: step.sequence.name, stepNumber: step.stepNumber })),
          arms: arms.map((arm) => ({ testName: arm.abTest.name, armName: arm.name })),
        }),
      },
      { status: 409 },
    );
  }

  await prisma.template.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = withAuth(GET_impl);
export const PATCH = withAuth(PATCH_impl);
export const DELETE = withAuth(DELETE_impl);
