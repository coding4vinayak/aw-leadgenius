// Round #22 made a template's declaration mean something; it also exposed what
// the declaration was still worth. `renderTemplate`'s catch-all reads
// `Enrollment.metadata` for every name the contact row cannot fill, and no API
// door wrote that column — the demo had to reach through psql to make
// `{{greeting}}` render. So a sequence could promise a merge that no caller was
// allowed to answer, and enroll accepted it. This round opens the door and
// makes the promise cashable: a declared, non-column token must arrive with a
// value at the door that starts the send, or the enrollment is refused by the
// name it cannot fill.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MERGE_VALUE_MAX_LENGTH,
  MERGE_VALUES_MAX_KEYS,
  normalizeMergeValues,
  unfilledMergeTokens,
} from "../../src/lib/template-vars";
import { renderTemplate } from "../../src/lib/sequence-engine";
import { ENROLLMENT_CREATE, ENROLLMENT_PATCH } from "../../src/lib/fields";
import { validateBody } from "../../src/lib/validate";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

describe("normalizeMergeValues", () => {
  it("keeps the scalars as sent, because the render stringifies", () => {
    const result = normalizeMergeValues({ greeting: "Tuesday at ten", seats: 0, followUp: false, notes: "" });
    assert.ok(result.ok);
    assert.deepEqual(result.values, { greeting: "Tuesday at ten", seats: 0, followUp: false, notes: "" });
  });

  it("takes an empty object as \"I supply nothing\", which is the promise's own spelling", () => {
    const result = normalizeMergeValues({});
    assert.ok(result.ok);
    assert.deepEqual(result.values, {});
  });

  it("refuses a bare value, an array and null: only a name → value object can be read", () => {
    for (const bad of ["greeting", 7, true, null, ["a"], { nested: { deeper: 1 } }]) {
      const result = normalizeMergeValues(bad);
      assert.ok(!result.ok, `${JSON.stringify(bad)} should be refused`);
    }
    assert.match(normalizeMergeValues(null).error!, /must be an object of merge names to values, got null/);
    assert.match(normalizeMergeValues("hi").error!, /got a string/);
    assert.match(normalizeMergeValues({ a: [] }).error!, /metadata\.a is an array/);
  });

  it("refuses a key the renderer could never match, and says why", () => {
    const result = normalizeMergeValues({ "meeting-date": "Tuesday" });
    assert.ok(!result.ok);
    assert.match(result.error!, /metadata holds "meeting-date"; a merge name is word characters/);
  });

  it("keeps a number, a boolean and an empty string, and refuses null for the same reason", () => {
    assert.ok(normalizeMergeValues({ a: null }).ok === false);
    assert.match(normalizeMergeValues({ a: null }).error!, /metadata.a is null; a merge value is text, a number or true\/false/);
  });

  it("caps the count, so one enrollment cannot carry a directory", () => {
    const at = Object.fromEntries(Array.from({ length: MERGE_VALUES_MAX_KEYS }, (_, i) => [`v${i}`, i]));
    const over = Object.fromEntries(Array.from({ length: MERGE_VALUES_MAX_KEYS + 1 }, (_, i) => [`v${i}`, i]));
    assert.ok(normalizeMergeValues(at).ok);
    assert.ok(!normalizeMergeValues(over).ok);
    assert.match(normalizeMergeValues(over).error!, /holds 41 merge values; at most 40/);
  });

  it("caps a value's length, because a merge lands in a sentence not an attachment", () => {
    assert.ok(normalizeMergeValues({ a: "x".repeat(MERGE_VALUE_MAX_LENGTH) }).ok);
    const result = normalizeMergeValues({ a: "x".repeat(MERGE_VALUE_MAX_LENGTH + 1) });
    assert.ok(!result.ok);
    assert.match(result.error!, /metadata.a is 501 characters; a merge value is at most 500/);
  });

  it("names the field it was given, so the same rule reads right on either side", () => {
    assert.match(normalizeMergeValues("x", "mergeValues").error!, /^mergeValues must be an object/);
  });
});

describe("unfilledMergeTokens", () => {
  const promise = (name: string, stepNumber = 1, templateName = "opener") => [{ stepNumber, templateName, declared: [name] }];

  it("exempts the five columns the contact row fills", () => {
    assert.deepEqual(unfilledMergeTokens(promise("firstName"), {}), []);
    assert.deepEqual(unfilledMergeTokens(promise("company"), undefined), []);
  });

  it("demands a declared name the contact row cannot fill, by step and by template", () => {
    const problems = unfilledMergeTokens(promise("greeting", 2, "cold-open"), {});
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /^step 2's template "cold-open" fills \{\{greeting\}\} from the enrollment's metadata — send metadata\.greeting or the merge lands blank/,
    );
  });

  it("treats a blank and a whitespace-only string as no value", () => {
    assert.equal(unfilledMergeTokens(promise("greeting"), { greeting: "" }).length, 1);
    assert.equal(unfilledMergeTokens(promise("greeting"), { greeting: "   " }).length, 1);
  });

  it("counts 0 and false as answers, because they are the values most likely to be mistaken for blanks", () => {
    assert.deepEqual(unfilledMergeTokens(promise("seats"), { seats: 0 }), []);
    assert.deepEqual(unfilledMergeTokens(promise("trial"), { trial: false }), []);
  });

  it("is silent when nothing is promised", () => {
    assert.deepEqual(unfilledMergeTokens([], { anything: 1 }), []);
    assert.deepEqual(unfilledMergeTokens([{ stepNumber: 1, templateName: "legacy", declared: [] }], null), []);
  });

  it("names every unkept promise, including one name promised by two steps", () => {
    const problems = unfilledMergeTokens(
      [
        { stepNumber: 1, templateName: "opener", declared: ["greeting", "meetingDate"] },
        { stepNumber: 2, templateName: "bump", declared: ["greeting"] },
      ],
      {},
    );
    assert.deepEqual(
      problems.map((p) => /\{\{(\w+)\}\}/.exec(p)![1]),
      ["greeting", "meetingDate", "greeting"],
    );
    assert.match(problems[2], /^step 2's template "bump"/);
  });

  it("a value that satisfies one step does not speak for the step that promised a different name", () => {
    const problems = unfilledMergeTokens(
      [
        { stepNumber: 1, templateName: "opener", declared: ["greeting"] },
        { stepNumber: 3, templateName: "bump", declared: ["meetingDate"] },
      ],
      { greeting: "Hello" },
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^step 3's template "bump" fills \{\{meetingDate\}\}/);
  });
});

describe("renderTemplate answers the promise directly", () => {
  it("merges a metadata value into the copy", () => {
    assert.equal(renderTemplate("See {{greeting}}?", {}, { greeting: "Tuesday at ten" }), "See Tuesday at ten?");
  });

  it("renders 0 and false as themselves, which `|| \"\"` mailed as a blank", () => {
    assert.equal(renderTemplate("{{seats}} seats", {}, { seats: 0 }), "0 seats");
    assert.equal(renderTemplate("trial: {{trial}}", {}, { trial: false }), "trial: false");
  });

  it("still merges nothing for a name nobody supplied, or a stored null", () => {
    assert.equal(renderTemplate("Hi {{firstName}}, {{greeting}}", { firstName: "Dana" }, {}), "Hi Dana, ");
    assert.equal(renderTemplate("{{greeting}}", {}, { greeting: null }), "");
  });

  it("fills the five columns from the contact row before metadata gets a turn", () => {
    assert.equal(
      renderTemplate("{{company}} / {{title}}", { company: "Barium", title: "Ops" }, { company: "Ignored", title: "Ignored" }),
      "Barium / Ops",
    );
  });
});

describe("both enrollment doors cash the promise before Prisma sees the row", () => {
  const enroll = source("../../src/app/api/enrollments/route.ts");
  const patch = source("../../src/app/api/enrollments/[id]/route.ts");

  it("both import the shape rule, the check, and the one shared loader", () => {
    for (const route of [enroll, patch]) {
      assert.match(route, /import \{[^}]*normalizeMergeValues[^}]*unfilledMergeTokens[^}]*\} from "@\/lib\/template-vars"/);
      assert.match(route, /import \{ mergePromisesForSteps \} from "@\/lib\/merge-promise"/);
    }
  });

  it("the enroll door checks and only then creates", () => {
    assert.ok(enroll.indexOf("unfilledMergeTokens(") < enroll.indexOf("prisma.enrollment.create("));
    assert.ok(enroll.indexOf("normalizeMergeValues(") < enroll.indexOf("prisma.enrollment.create("));
  });

  it("the enroll door asks about the steps that will actually send, including an A/B arm's", () => {
    assert.match(enroll, /let drivingSteps = \[\.\.\.sequence\.steps\]\.sort\(\(a, b\) => a\.stepNumber - b\.stepNumber\)/);
    assert.match(enroll, /drivingSteps = \[\.\.\.armSequence\.steps\]\.sort\(\(a, b\) => a\.stepNumber - b\.stepNumber\)/);
    assert.match(enroll, /unfilledMergeTokens\(await mergePromisesForSteps\(drivingSteps\), mergeValues\)/);
    assert.doesNotMatch(enroll, /mergePromisesForSteps\(sequence\.steps/);
  });

  it("both refuse through the declared 400 envelope, naming metadata", () => {
    assert.equal((enroll.match(/fieldProblem\("metadata"/g) ?? []).length, 2);
    assert.equal((patch.match(/fieldProblem\("metadata"/g) ?? []).length, 2);
  });

  it("enroll writes the column only when values were sent, so a bare enroll stores no empty object", () => {
    assert.match(enroll, /\.\.\.\(mergeValues \? \{ metadata: mergeValues \} : \{\}\)/);
  });

  it("the patch door normalises, re-checks against the enrollment's own sequence, then writes", () => {
    assert.ok(patch.indexOf("normalizeMergeValues(") < patch.indexOf("prisma.enrollment.update("));
    assert.ok(patch.indexOf("unfilledMergeTokens(") < patch.indexOf("prisma.enrollment.update("));
    assert.match(patch, /sequence: \{ include: \{ steps: true \} \}/);
    assert.match(patch, /input\.data\.metadata = normalized\.values/);
  });

  it("the patch door's re-check is what makes a replacement honest: the values it compares are the new ones", () => {
    assert.match(patch, /unfilledMergeTokens\(\n?\s*await mergePromisesForSteps\(\[\.\.\.current\.sequence\.steps\]\.sort\(\(a, b\) => a\.stepNumber - b\.stepNumber\)\),\n?\s*normalized\.values,\n?\s*\)/);
  });
});

describe("the shared loader is one definition", () => {
  const loader = source("../../src/lib/merge-promise.ts");

  it("reads only what the question needs, once per template", () => {
    assert.match(loader, /select: \{ id: true, name: true, variables: true \}/);
    assert.match(loader, /\[\.\.\.new Set\(steps\.map\(\(step\) => step\.templateId\)/);
    assert.match(loader, /if \(templateIds\.length === 0\) return \[\]/);
  });

  it("exempts the same five columns the renderer iterates, and ignores a shape it cannot match", () => {
    assert.match(loader, /import \{ MERGEABLE_COLUMNS \} from "\.\/template-vars"/);
    assert.match(loader, /const columns: string\[\] = \[\.\.\.MERGEABLE_COLUMNS\]/);
    assert.match(loader, /\/\^\\w\+\$\/\.test\(name\)/);
    assert.match(loader, /!columns\.includes\(name\)/);
  });

  it("leaves a dangling template reference to the engine, which refuses it at send by name", () => {
    assert.match(loader, /if \(!template\) continue/);
    assert.match(loader, /if \(!step\.templateId\) continue/);
  });

  it("nothing else in the app defines the read", () => {
    for (const route of [source("../../src/app/api/enrollments/route.ts"), source("../../src/app/api/enrollments/[id]/route.ts")]) {
      assert.doesNotMatch(route, /prisma\.template\.findMany/);
    }
  });
});

describe("the field tables declare the door", () => {
  const metadataField = { kind: "json", objectOnly: true, max: 16384 };

  it("both enrollment tables take metadata, as an object only", () => {
    assert.deepEqual((ENROLLMENT_CREATE as Record<string, unknown>).metadata, metadataField);
    assert.deepEqual((ENROLLMENT_PATCH as Record<string, unknown>).metadata, metadataField);
  });

  it("the boundary refuses an array, a bare string and null before the shape rule ever runs", () => {
    for (const bad of [[1, 2], "greeting", null, 7]) {
      const result = validateBody({ contactId: "c", sequenceId: "s", metadata: bad }, ENROLLMENT_CREATE);
      assert.ok(!result.ok, `${JSON.stringify(bad)} should be refused`);
    }
    assert.ok(validateBody({ contactId: "c", sequenceId: "s", metadata: { greeting: "Tuesday" } }, ENROLLMENT_CREATE).ok);
  });

  it("a metadata-only fix is a write, so status no longer has to ride along", () => {
    assert.ok(validateBody({ metadata: { greeting: "Thursday" } }, ENROLLMENT_PATCH, { requireWrite: true }).ok);
    assert.ok(!(ENROLLMENT_PATCH as Record<string, Record<string, unknown>>).status.required);
  });

  it("an empty patch is still refused", () => {
    assert.ok(!validateBody({}, ENROLLMENT_PATCH, { requireWrite: true }).ok);
  });
});
