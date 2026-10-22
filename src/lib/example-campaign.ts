import { prisma } from "./db";
import { validateBody, validateItems } from "./validate";
import {
  CAMPAIGN_CREATE,
  CONTACT_CREATE,
  ENROLLMENT_CREATE,
  SEQUENCE_CREATE,
  SEQUENCE_STEP,
  TEMPLATE_CREATE,
} from "./fields";
import {
  checkTemplateVariables,
  normalizeMergeValues,
  normalizeVariableDeclaration,
  unfilledMergeTokens,
} from "./template-vars";
import { subjectProblem } from "./subject-fit";
import { isChannelMismatch, sequenceChannelProblem } from "./channel-fit";
import { mergePromisesForSteps } from "./merge-promise";

/**
 * The example campaign: what a new workspace loads, and the way to take it
 * away again.
 *
 * This app's first run was an empty dashboard whose only advice was "No
 * campaigns yet. Create one via `POST /api/campaigns`" — advice for a buyer
 * who already writes code. A signup that starts on an empty screen ends on a
 * cancelled subscription, so a new workspace now gets one worked example: a
 * campaign, a three-step sequence, the templates behind it, five contacts and
 * three enrollments.
 *
 * Two rules, the same ones the other apps in the suite follow:
 *
 * 1. It is example data, and it says so — in every name, in the description,
 *    and on the panel that offers it.
 * 2. One click removes it, and removes *only* it. The removal finds the rows
 *    by their exact names, so a customer's own campaign, sequence, template or
 *    contact is never touched.
 *
 * **The example is built by the app's own rules.** Every payload below goes
 * through the same declared field tables, the same template rules, the same
 * channel rules and the same merge rules that the API enforces — so the
 * example cannot be something the product would refuse at its own door. When a
 * rule changes, this file is refused too, loudly, and the test says which.
 *
 * **The example sends nothing.** Outreach needs a sending account, and a fresh
 * workspace has none, so the campaign is a draft and the enrollments wait. The
 * panel says that in as many words rather than letting a prospect find out by
 * watching an empty queue.
 */

/** The names are the markers: the removal path finds the example by them. */
export const EXAMPLE_CAMPAIGN_NAME = "Example: logistics outreach";
export const EXAMPLE_SEQUENCE_NAME = "Example: three-step welcome";
export const EXAMPLE_TEMPLATE_NAMES = ["Example: first email", "Example: follow-up"] as const;
export const EXAMPLE_CONTACT_EMAILS = [
  "ola.farouk@example.com",
  "ravi.mehta@example.com",
  "sofia.almeida@example.com",
  "tom.becker@example.com",
  "mina.park@example.com",
] as const;

/** True when a campaign is the example one. */
export function isExampleCampaign(name: string): boolean {
  return name === EXAMPLE_CAMPAIGN_NAME;
}

/** The words the door used, so a failure says which rule spoke. */
async function doorSays(error: unknown): Promise<string> {
  if (error && typeof (error as { json?: unknown }).json === "function") {
    try {
      const body = (await (error as Response).json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      /* the body was not JSON — the door's name still says which rule spoke */
    }
  }
  return "refused";
}

/** The body every example email sends, with the names the renderer reads. */
const FIRST_EMAIL_BODY = `<p>Hi {{firstName}},</p><p>I noticed {{company}} is running logistics across {{industry}} — we help teams like {{company}} reply to enquiries the same day.</p><p>Would a 15-minute look at how another team did it be worth it?</p><p>Best,<br>{{senderName}}</p>`;

const FOLLOW_UP_BODY = `<p>Hi {{firstName}},</p><p>Following up on my note — {{company}}'s team is the kind that answers fast, and I did not want to be the reason you missed it.</p><p>Best,<br>{{senderName}}</p>`;

const FIRST_EMAIL_SUBJECT = "Quick question about {{company}}";
const FOLLOW_UP_SUBJECT = "Re: {{company}}";

/**
 * The two templates, and the names each one declares.
 *
 * A template declares only the names its own text uses — the door refuses a
 * declaration nothing reads, and it is right to: a promise nobody fills is a
 * blank in front of a real prospect.
 */
export const EXAMPLE_TEMPLATES = [
  {
    name: EXAMPLE_TEMPLATE_NAMES[0],
    subject: FIRST_EMAIL_SUBJECT,
    body: FIRST_EMAIL_BODY,
    variables: ["firstName", "company", "industry", "senderName"],
  },
  {
    name: EXAMPLE_TEMPLATE_NAMES[1],
    subject: FOLLOW_UP_SUBJECT,
    body: FOLLOW_UP_BODY,
    variables: ["firstName", "company", "senderName"],
  },
] as const;

/**
 * Load the example campaign into a workspace.
 *
 * Idempotent: a second call finds the example already there and changes
 * nothing, so a double-click (or a retried request) cannot stack two copies.
 * The removal path is the way back to an empty workspace.
 */
export async function loadExampleCampaign(workspaceId: string) {
  const existing = await prisma.campaign.findFirst({
    where: { workspaceId, name: EXAMPLE_CAMPAIGN_NAME },
    select: { id: true },
  });
  if (existing) {
    const enrollments = await prisma.enrollment.count({ where: { campaignId: existing.id } });
    return { created: false, campaignId: existing.id, enrollments, contacts: 0, sequences: 0 };
  }

  // ── the templates ──────────────────────────────────────────────────────
  const templates: { id: string; name: string; channel: string }[] = [];
  for (const { name, subject, body, variables } of EXAMPLE_TEMPLATES) {
    const declared = normalizeVariableDeclaration(variables);
    if (!declared.ok) throw new Error(`the example campaign was refused by the template door: ${await doorSays(declared.error)}`);
    const input = validateBody(
      { name, channel: "EMAIL", subject, body, variables: declared.names },
      TEMPLATE_CREATE,
    );
    if (!input.ok) throw new Error(`the example campaign was refused by the template door: ${await doorSays(input.error)}`);
    const problems = checkTemplateVariables(declared.names, [input.data.subject, input.data.body]);
    if (problems.length) throw new Error(`the example campaign was refused by the template door: ${problems.join("; ")}`);
    const verdict = subjectProblem({
      name: input.data.name,
      channel: input.data.channel,
      subject: input.data.subject,
    });
    if (verdict) throw new Error(`the example campaign was refused by the template door: ${await doorSays(verdict)}`);
    const created = await prisma.template.create({
      data: {
        workspaceId,
        name: input.data.name,
        channel: input.data.channel,
        subject: input.data.subject ?? null,
        body: input.data.body,
        variables: declared.names,
      },
    });
    templates.push({ id: created.id, name: created.name, channel: created.channel });
  }

  // ── the sequence and its steps ─────────────────────────────────────────
  const stepsConfig = [
    { stepNumber: 1, channel: "EMAIL", templateId: templates[0].id, delayDays: 0, delayHours: 0 },
    { stepNumber: 2, channel: "EMAIL", templateId: templates[1].id, delayDays: 2, delayHours: 0 },
    { stepNumber: 3, channel: "CALL", templateId: null, delayDays: 3, delayHours: 0 },
  ];
  const sequenceInput = validateBody(
    { name: EXAMPLE_SEQUENCE_NAME, channel: "MULTI", stepsConfig },
    SEQUENCE_CREATE,
  );
  if (!sequenceInput.ok) throw new Error(`the example campaign was refused by the sequence door: ${await doorSays(sequenceInput.error)}`);
  const steps = validateItems<Record<string, unknown>>(stepsConfig, "stepsConfig", SEQUENCE_STEP, { max: 50 });
  if (!steps.ok) throw new Error(`the example campaign was refused by the sequence door: ${await doorSays(steps.error)}`);
  for (const step of steps.items) {
    const template = step.templateId
      ? templates.find((t) => t.id === step.templateId)
      : undefined;
    if (step.templateId && !template) throw new Error(`the example campaign was refused by the sequence door: ${await doorSays(`stepsConfig: template not found`)}`);
    if (template && isChannelMismatch(step as never, template as never)) {
      throw new Error(`the example campaign was refused by the sequence door: ${await doorSays(`stepsConfig: the step and the template send differently`)}`);
    }
    const mismatch = sequenceChannelProblem(sequenceInput.data.channel, step as never);
    if (mismatch) throw new Error(`the example campaign was refused by the sequence door: ${await doorSays(mismatch)}`);
  }

  const sequence = await prisma.sequence.create({
    data: {
      workspaceId,
      name: sequenceInput.data.name,
      channel: sequenceInput.data.channel,
      stepsConfig,
    },
  });
  await prisma.sequenceStep.createMany({
    data: steps.items.map((step) => ({
      sequenceId: sequence.id,
      stepNumber: step.stepNumber as number,
      channel: step.channel as string,
      templateId: (step.templateId as string | null) ?? null,
      delayDays: (step.delayDays as number) ?? 0,
      delayHours: (step.delayHours as number) ?? 0,
    })),
  });

  // ── the campaign, and the sequence's place in it ───────────────────────
  const campaignInput = validateBody(
    { name: EXAMPLE_CAMPAIGN_NAME, goal: "book a demo" },
    CAMPAIGN_CREATE,
  );
  if (!campaignInput.ok) throw new Error(`the example campaign was refused by the campaign door: ${await doorSays(campaignInput.error)}`);
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId,
      name: campaignInput.data.name,
      goal: campaignInput.data.goal ?? null,
      // The schema's own default is DRAFT, and a draft sends nothing.
      status: "DRAFT",
    },
  });
  await prisma.campaignSequence.create({
    data: { campaignId: campaign.id, sequenceId: sequence.id, stepOrder: 1 },
  });

  // ── the contacts ───────────────────────────────────────────────────────
  const people = [
    { email: EXAMPLE_CONTACT_EMAILS[0], firstName: "Ola", lastName: "Farouk", company: "Example Freight", title: "Head of Operations", industry: "Logistics" },
    { email: EXAMPLE_CONTACT_EMAILS[1], firstName: "Ravi", lastName: "Mehta", company: "Example Cold Chain", title: "Founder", industry: "Logistics" },
    { email: EXAMPLE_CONTACT_EMAILS[2], firstName: "Sofia", lastName: "Almeida", company: "Example Studios", title: "Operations Manager", industry: "Creative" },
    { email: EXAMPLE_CONTACT_EMAILS[3], firstName: "Tom", lastName: "Becker", company: "Example Haulage", title: "Fleet Manager", industry: "Transport" },
    { email: EXAMPLE_CONTACT_EMAILS[4], firstName: "Mina", lastName: "Park", company: "Example Returns", title: "Head of Support", industry: "Retail" },
  ];
  const contactIds: string[] = [];
  for (const person of people) {
    const input = validateBody(person, CONTACT_CREATE);
    if (!input.ok) throw new Error(`the example campaign was refused by the contact door: ${await doorSays(input.error)}`);
    if (!input.data.email && !input.data.phone && !input.data.linkedinUrl) {
      throw new Error(`the example campaign was refused by the contact door: ${await doorSays("at least one contact method required")}`);
    }
    const contact = await prisma.contact.create({
      data: {
        workspaceId,
        email: input.data.email ?? null,
        firstName: input.data.firstName ?? null,
        lastName: input.data.lastName ?? null,
        company: input.data.company ?? null,
        title: input.data.title ?? null,
        status: "ACTIVE",
      },
    });
    contactIds.push(contact.id);
  }

  // ── the enrollments ────────────────────────────────────────────────────
  // Three of the five are enrolled, with the merge values their templates
  // declare and the contact row cannot fill. The fourth is left out so the
  // list shows a prospect who is not in the campaign yet, and the fifth is
  // marked bounced, because the lifecycle column is part of the product.
  await prisma.contact.update({
    where: { id: contactIds[4] },
    data: { status: "BOUNCED" },
  });

  let enrolled = 0;
  for (const [index, contactId] of contactIds.slice(0, 3).entries()) {
    const person = people[index];
    const merge = normalizeMergeValues({ industry: person.industry, senderName: "Ravi from Example Co" });
    if (!merge.ok) throw new Error(`the example campaign was refused by the enrollment door: ${await doorSays(merge.error)}`);
    const input = validateBody(
      { contactId, sequenceId: sequence.id, campaignId: campaign.id, metadata: merge.values },
      ENROLLMENT_CREATE,
    );
    if (!input.ok) throw new Error(`the example campaign was refused by the enrollment door: ${await doorSays(input.error)}`);
    const unfilled = unfilledMergeTokens(await mergePromisesForSteps(steps.items as never, templates[0].id), merge.values);
    if (unfilled.length) throw new Error(`the example campaign was refused by the enrollment door: ${unfilled.join("; ")}`);
    await prisma.enrollment.create({
      data: {
        campaignId: campaign.id,
        sequenceId: sequence.id,
        contactId,
        status: "ACTIVE",
        currentStep: 0,
        metadata: merge.values,
      },
    });
    enrolled += 1;
  }

  return {
    created: true,
    campaignId: campaign.id,
    enrollments: enrolled,
    contacts: people.length,
    sequences: 1,
  };
}

/**
 * Remove the example campaign, and only the example campaign.
 *
 * The rows are found by their exact names, so a customer's own campaign,
 * sequence, template or contact is never touched. Deleting the campaign
 * cascades to its enrollments; the sequence, its steps and the templates are
 * removed by name.
 */
export async function removeExampleCampaign(workspaceId: string) {
  const campaign = await prisma.campaign.findFirst({
    where: { workspaceId, name: EXAMPLE_CAMPAIGN_NAME },
    select: { id: true },
  });
  if (!campaign) return { removed: 0, enrollments: 0, contacts: 0 };

  const enrollments = await prisma.enrollment.count({ where: { campaignId: campaign.id } });
  const sequences = await prisma.campaignSequence.findMany({
    where: { campaignId: campaign.id },
    select: { sequenceId: true },
  });
  const sequenceIds = sequences.map((s) => s.sequenceId);
  // The example's contacts are the ones it made — including the two it did
  // not enroll (one is on the list, one is marked bounced), so the removal
  // finds them by the example's own address list rather than by who happened
  // to be in the campaign.
  const contacts = await prisma.contact.findMany({
    where: { workspaceId, email: { in: [...EXAMPLE_CONTACT_EMAILS] } },
    select: { id: true },
  });
  const contactIds = contacts.map((c) => c.id);

  // The sequence and the templates are the example's own; a sequence the
  // customer made is not in this list, so it stays.
  for (const id of sequenceIds) {
    const sequence = await prisma.sequence.findUnique({ where: { id }, select: { name: true } });
    if (sequence?.name !== EXAMPLE_SEQUENCE_NAME) continue;
    await prisma.sequenceStep.deleteMany({ where: { sequenceId: id } });
    await prisma.sequence.delete({ where: { id } });
  }
  for (const id of contactIds) {
    await prisma.contact.delete({ where: { id } });
  }
  for (const name of EXAMPLE_TEMPLATE_NAMES) {
    await prisma.template.deleteMany({ where: { workspaceId, name } });
  }
  await prisma.campaign.delete({ where: { id: campaign.id } });

  return { removed: 1, enrollments, contacts: contactIds.length };
}
