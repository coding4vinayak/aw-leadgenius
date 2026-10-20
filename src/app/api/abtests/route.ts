import { NextResponse } from "next/server";
import { withAuth, authedWorkspaceId } from "@/lib/apikeys";
import { prisma } from "@/lib/db";
import { validateBody, validateItems } from "@/lib/validate";
import { ABTEST_CREATE, ABTEST_VARIANT } from "@/lib/fields";
import { validateAbTestSemantics, type AbTestVariantInput } from "@/lib/abtest";
import { armChannelProblem } from "@/lib/channel-fit";
import { declareSplit } from "@/lib/traffic-split";

export const dynamic = "force-dynamic";

/**
 * Create an A/B test and switch it on.
 *
 * The schema modeled `ABTest`/`ABTestVariant` (weights, control, per-variant
 * sequence and template) and attribution already groups by `abVariant.name`,
 * but nothing in the product could ever create a row — `byVariant` was
 * honestly empty because there was no writer. This route is that writer: a
 * test arrives RUNNING (a DRAFT the campaign cannot use is a form field, not
 * a feature), the variants carry the traffic split, and from the next enroll
 * onward `POST /api/enrollments` assigns arms deterministically (abtest.ts).
 *
 * Validation is the house stack: `validateBody` for the test's scalars,
 * `validateItems` for the variant rows' shapes (2..10 entries), and
 * `validateAbTestSemantics` for the cross-entry rules no per-field table can
 * state — unique names, exactly one control, weights summing to 100.
 *
 * Tenant scoping is the standing pair: the workspace comes from the API key,
 * never the body (`authedWorkspaceId` 403s a foreign claim), and both the
 * campaign and every variant's sequence must exist *in that workspace* —
 * a test wired to another tenant's sequence would enroll their contacts
 * through it.
 */
async function POST_impl(request: Request) {
  const body = await request.json();
  const workspaceId = await authedWorkspaceId(request, body.workspaceId);

  const input = validateBody(body, ABTEST_CREATE);
  if (!input.ok) return input.error;

  const items = validateItems<AbTestVariantInput>(body.variants, "variants", ABTEST_VARIANT, { required: true, min: 2, max: 10 });
  if (!items.ok) return items.error;

  const parsed = validateAbTestSemantics(input.data, items.items);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { campaignId, name, hypothesis, variants } = parsed.value;

  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
  if (!campaign) return NextResponse.json({ error: "campaign not found in this workspace" }, { status: 404 });

  // Every id the variants carry must be a row of this workspace — the standing
  // rule for id-typed fields (an id is a claim that a row exists, not a
  // column value). A test wired to another tenant's sequence would enroll
  // their contacts through it; a test wired to a missing template would ship
  // an arm whose messages read `undefined`.
  for (const variant of variants) {
    const sequence = await prisma.sequence.findFirst({
      where: { id: variant.sequenceId, workspaceId },
      select: { id: true, steps: { select: { stepNumber: true, channel: true } } },
    });
    if (!sequence) {
      return NextResponse.json({ error: `variant "${variant.name}" names a sequence that does not exist in this workspace` }, { status: 400 });
    }
    if (variant.templateId) {
      const template = await prisma.template.findFirst({
        where: { id: variant.templateId, workspaceId },
        select: { id: true, name: true, channel: true },
      });
      if (!template) {
        return NextResponse.json({ error: `variant "${variant.name}" names a template that does not exist in this workspace` }, { status: 400 });
      }
      // An arm's copy rides EVERY step of the track it overrides (#24), so it is
      // judged against all of them: a variant template written for LINKEDIN would
      // drop its subjectless body onto every EMAIL step of the arm — the one
      // prospect-visible outcome of an arm whose steps the create door never read.
      const problem = armChannelProblem(`arm "${variant.name}"`, template, sequence.steps);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    }
  }

  const test = await prisma.aBTest.create({
    data: {
      workspaceId,
      campaignId,
      name,
      hypothesis,
      status: "RUNNING",
      startedAt: new Date(),
      // The copy the completion door is later asked to believe, written through
      // the same function that reads it: the column is the arms, keyed by name.
      trafficSplit: declareSplit(variants),
      variants: {
        create: variants.map((v) => ({
          name: v.name,
          weight: v.weight,
          isControl: v.isControl,
          sequenceId: v.sequenceId,
          templateId: v.templateId ?? null,
          // The column's declared starting stats. Attribution never reads
          // these — it folds Activity rows live — but the row shape promises
          // them, and a stored `null` is a crash for whatever reads them next.
          stats: { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0 },
        })),
      },
    },
    include: { variants: { orderBy: { name: "asc" } } },
  });

  return NextResponse.json({ abTest: test }, { status: 201 });
}

export const POST = withAuth(POST_impl);
