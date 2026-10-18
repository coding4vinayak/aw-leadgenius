// The refusal that keeps a deleted template from erasing its own reference.
//
// Both template FKs are optional, so the database's `SetNull` erases the
// reference at delete time — by the time a send could refuse, there is nothing
// left to refuse about, and the step sends placeholder copy. The refusal
// therefore lives in the templates delete route; these cases pin its message
// and the route's order of operations.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { templateInUseMessage } from "../../src/lib/templates";

describe("templateInUseMessage", () => {
  it("names a sequence and the steps that reference the template", () => {
    const message = templateInUseMessage({
      sequenceSteps: [
        { sequenceName: "Ridgeview intro", stepNumber: 2 },
        { sequenceName: "Ridgeview intro", stepNumber: 1 },
      ],
      arms: [],
    });
    assert.match(message, /^template is in use by sequence "Ridgeview intro" \(step 1, 2\) — it cannot be deleted while a reference exists$/);
  });

  it("names a test and its arm", () => {
    const message = templateInUseMessage({ sequenceSteps: [], arms: [{ testName: "Subject test", armName: "B" }] });
    assert.match(message, /^template is in use by A\/B test "Subject test" \(arm "B"\)/);
  });

  it("names both kinds when both hold the template", () => {
    const message = templateInUseMessage({
      sequenceSteps: [{ sequenceName: "Intro", stepNumber: 1 }],
      arms: [{ testName: "Copy test", armName: "Control" }],
    });
    assert.match(message, /sequence "Intro" \(step 1\) and A\/B test "Copy test" \(arm "Control"\)/);
  });
});

describe("the templates delete route", () => {
  const route = readFileSync(new URL("../../src/app/api/templates/[id]/route.ts", import.meta.url), "utf8");

  it("asks who references the template before it deletes the row", () => {
    const asks = route.indexOf("sequenceStep.findMany");
    const deletes = route.indexOf("prisma.template.delete");
    assert.ok(asks > -1, "the route asks for referencing steps");
    assert.ok(deletes > -1, "the route still deletes templates");
    assert.ok(asks < deletes, "the question is asked before the delete, not after");
    assert.match(route, /aBTestVariant\.findMany/);
    assert.match(route, /templateInUseMessage\(/);
    assert.match(route, /\{ status: 409 \}/);
  });
});
