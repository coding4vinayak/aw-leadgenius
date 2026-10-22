// The example campaign: the worked example a new workspace loads, and the
// rules that keep it from ever being mistaken for the customer's own.
//
// This is a conversion feature with a data-safety edge, so both halves are
// pinned here: the example is valid by the app's *own* rules (the same
// declared-field tables, template rules and merge rules the API enforces),
// and the removal is narrow (so "one click" can never mean "and your data
// too").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkTemplateVariables, normalizeMergeValues, unfilledMergeTokens } from "../../src/lib/template-vars";
import { subjectProblem } from "../../src/lib/subject-fit";
import {
  EXAMPLE_CAMPAIGN_NAME,
  EXAMPLE_CONTACT_EMAILS,
  EXAMPLE_SEQUENCE_NAME,
  EXAMPLE_TEMPLATES,
  isExampleCampaign,
} from "../../src/lib/example-campaign";

test("every template declares only the names its own text uses", () => {
  for (const template of EXAMPLE_TEMPLATES) {
    const problems = checkTemplateVariables(template.variables, [template.subject, template.body]);
    assert.deepEqual(problems, [], `${template.name}: ${problems.join("; ")}`);
  }
});

test("every template's subject fits the channel it sends on", () => {
  for (const template of EXAMPLE_TEMPLATES) {
    const verdict = subjectProblem({ name: template.name, channel: "EMAIL", subject: template.subject });
    assert.equal(verdict, null, `${template.name}: ${verdict}`);
  }
});

test("the merge values a send needs are named by the templates that need them", () => {
  // The enrollment door refuses an enrollment whose templates declare a name
  // the contact row cannot fill, so the example has to carry those names.
  const supplied = normalizeMergeValues({ industry: "Logistics", senderName: "Ravi from Example Co" });
  assert.equal(supplied.ok, true);
  const unfilled = unfilledMergeTokens(
    EXAMPLE_TEMPLATES.map((t, index) => ({
      stepNumber: index + 1,
      templateName: t.name,
      declared: t.variables,
    })),
    supplied.ok ? supplied.values : {},
  );
  assert.deepEqual(unfilled, []);
});

test("every example contact is unmistakably example data", () => {
  assert.equal(EXAMPLE_CONTACT_EMAILS.length, 5);
  for (const email of EXAMPLE_CONTACT_EMAILS) {
    assert.ok(email.endsWith("@example.com"), `${email} must be on a reserved domain`);
  }
});

test("the example is found by its exact name and nothing else", () => {
  assert.equal(isExampleCampaign(EXAMPLE_CAMPAIGN_NAME), true);
  assert.equal(isExampleCampaign(EXAMPLE_CAMPAIGN_NAME + " "), false, "a trailing space is a different name");
  assert.equal(isExampleCampaign("Example"), false);
  assert.equal(isExampleCampaign("My example: logistics outreach"), false);
  assert.equal(isExampleCampaign("logistics outreach"), false);
  assert.ok(EXAMPLE_SEQUENCE_NAME.startsWith("Example: "), "the sequence says what it is");
});

test("the first run loads and removes through one door, the way the dashboard calls it", () => {
  const route = readFileSync(new URL("../../src/app/api/example-campaign/route.ts", import.meta.url), "utf8");
  assert.ok(route.includes("loadExampleCampaign"), "POST must load");
  assert.ok(route.includes("removeExampleCampaign"), "DELETE must remove");
  assert.ok(route.includes("getSession"), "the door is a session as well as a key");
  assert.ok(route.includes("authedWorkspaceId"), "a key is a door too");
});

test("the panel offers the example, and says it can be taken away", () => {
  const card = readFileSync(new URL("../../src/components/example-campaign-card.tsx", import.meta.url), "utf8");
  assert.ok(card.includes("/api/example-campaign"));
  assert.ok(card.includes("Remove the example campaign"), "the way back has to be on the panel");
  assert.ok(card.includes("example data"), "the panel has to say what it is");
  assert.ok(card.includes("Nothing has been sent"), "and what it has not done");

  const dashboard = readFileSync(new URL("../../src/app/dashboard/page.tsx", import.meta.url), "utf8");
  assert.ok(dashboard.includes("ExampleCampaignCard"), "the dashboard must offer it");
  assert.ok(dashboard.includes("isExampleCampaign"), "and recognise it when it is loaded");
  assert.ok(
    !dashboard.includes("No campaigns yet. Create one via"),
    "the empty screen's advice is for a buyer who already writes code",
  );
});
