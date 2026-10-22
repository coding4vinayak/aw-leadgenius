import { prisma } from "../src/lib/db";
import {
  EXAMPLE_CAMPAIGN_NAME,
  loadExampleCampaign,
  removeExampleCampaign,
} from "../src/lib/example-campaign";

const workspace = await prisma.workspace.create({
  data: { name: "First-run check", slug: `first-run-${Date.now()}` },
});

console.log("1. load:", JSON.stringify(await loadExampleCampaign(workspace.id)));
console.log("2. load again:", JSON.stringify(await loadExampleCampaign(workspace.id)));

const campaign = await prisma.campaign.findFirst({
  where: { workspaceId: workspace.id },
  include: { sequences: { include: { sequence: { include: { steps: true } } } } },
});
console.log("3. campaign:", campaign?.name, campaign?.status, "goal:", campaign?.goal);
console.log("   sequence:", campaign?.sequences[0].sequence.name, campaign?.sequences[0].sequence.channel);
console.log("   steps:", campaign?.sequences[0].sequence.steps.map((s) => `${s.stepNumber}:${s.channel}`).join(" "));
const contacts = await prisma.contact.findMany({ where: { workspaceId: workspace.id } });
console.log("   contacts:", contacts.map((c) => `${c.email}(${c.status})`).join(" "));
const enrollments = await prisma.enrollment.findMany({ where: { campaignId: campaign!.id } });
console.log("   enrollments:", enrollments.length, "metadata:", JSON.stringify(enrollments[0]?.metadata));

// A customer's own campaign must survive the removal.
const own = await prisma.campaign.create({
  data: { workspaceId: workspace.id, name: "My real campaign", goal: "ship it", status: "ACTIVE" },
});

console.log("4. remove:", JSON.stringify(await removeExampleCampaign(workspace.id)));
const left = await prisma.campaign.findMany({ where: { workspaceId: workspace.id } });
console.log("5. campaigns left:", left.map((c) => c.name));
console.log("   the customer's campaign survived:", left.some((c) => c.id === own.id));
console.log("   the example is gone:", !left.some((c) => c.name === EXAMPLE_CAMPAIGN_NAME));
console.log("   its enrollments are gone:", await prisma.enrollment.count({ where: { campaignId: campaign!.id } }));
console.log("   its contacts are gone:", await prisma.contact.count({ where: { workspaceId: workspace.id } }));

await prisma.workspace.delete({ where: { id: workspace.id } });
await prisma.$disconnect();
