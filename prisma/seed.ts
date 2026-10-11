import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";
import { mintApiKey } from "../src/lib/apikeys";

async function main() {
  console.log("Seeding LeadGenius...");

  const workspace = await prisma.workspace.upsert({
    where: { slug: "demo" },
    update: {},
    create: { name: "Demo Workspace", slug: "demo" },
  });

  console.log("Created workspace:", workspace.id);

  const template = await prisma.template.upsert({
    where: { id: "welcome-template" },
    update: {},
    create: {
      id: "welcome-template",
      workspaceId: workspace.id,
      name: "Welcome Sequence",
      channel: "EMAIL",
      subject: "Quick question for {{firstName}}",
      body: `<p>Hi {{firstName}},</p><p>I noticed {{company}} is doing great work in {{industry}}. I'd love to connect.</p><p>Best,<br>{{senderName}}</p>`,
      variables: ["firstName", "company", "industry", "senderName"],
    },
  });

  const sequence = await prisma.sequence.upsert({
    where: { id: "welcome-sequence" },
    update: {},
    create: {
      id: "welcome-sequence",
      workspaceId: workspace.id,
      name: "Welcome Sequence",
      channel: "EMAIL",
      stepsConfig: [
        { stepNumber: 1, channel: "EMAIL", templateId: template.id, delayDays: 0, delayHours: 0 },
        { stepNumber: 2, channel: "EMAIL", templateId: template.id, delayDays: 2, delayHours: 0 },
        { stepNumber: 3, channel: "LINKEDIN", templateId: template.id, delayDays: 3, delayHours: 0 },
      ],
    },
  });

  console.log("Created sequence:", sequence.name);

  const contacts = [
    { email: "john.doe@acme.com", firstName: "John", lastName: "Doe", company: "Acme Corp", title: "VP Sales" },
    { email: "jane.smith@techstart.io", firstName: "Jane", lastName: "Smith", company: "TechStart", title: "CTO" },
    { email: "bob.wilson@globex.com", firstName: "Bob", lastName: "Wilson", company: "Globex", title: "Founder" },
  ];

  for (const c of contacts) {
    await prisma.contact.upsert({
      // Keyed on the workspace, because that is what the unique is scoped to:
      // upserting on the bare email would let a second tenant's row be picked up
      // here and then never seeded for the workspace that actually owns it.
      where: { workspaceId_email: { workspaceId: workspace.id, email: c.email } },
      update: {},
      create: { workspaceId: workspace.id, ...c, status: "ACTIVE" },
    });
  }

  console.log("Created demo contacts");

  const campaign = await prisma.campaign.upsert({
    where: { id: "demo-campaign" },
    update: {},
    create: {
      id: "demo-campaign",
      workspaceId: workspace.id,
      name: "Q4 Outreach Campaign",
      status: "ACTIVE",
      goal: "Book 10 demos",
    },
  });

  await prisma.campaignSequence.upsert({
    where: { campaignId_sequenceId: { campaignId: campaign.id, sequenceId: sequence.id } },
    update: {},
    create: { campaignId: campaign.id, sequenceId: sequence.id, stepOrder: 1 },
  });

  const campaignContacts = await prisma.contact.findMany({ where: { workspaceId: workspace.id } });
  let enrolledNow = 0;
  for (const contact of campaignContacts) {
    // Enrollment is the campaign's claim on a contact, and the pair has no
    // unique index — so the guard is a lookup, not a create that catches P2002.
    const already = await prisma.enrollment.findFirst({
      where: { campaignId: campaign.id, contactId: contact.id },
      select: { id: true },
    });
    if (already) continue;
    await prisma.enrollment.create({
      data: { campaignId: campaign.id, sequenceId: sequence.id, contactId: contact.id, status: "ACTIVE", currentStep: 0 },
    });
    enrolledNow++;
  }

  console.log(`Enrolled ${enrolledNow} of ${campaignContacts.length} contacts in campaign`);

  
  // Demo API key for smoke tests and the live demo. The plaintext prints once
  // here and is never stored — copy it into smoke scripts, then rotate it.
  await prisma.apiKey.deleteMany({ where: { workspaceId: workspace.id, name: "Demo key" } });
  const demoKey = await mintApiKey(workspace.id, "Demo key");
  console.log("Demo key (copy now, never shown again):", demoKey.plaintext);
console.log("Seeding complete!");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });