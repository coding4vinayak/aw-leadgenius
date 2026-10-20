// `Template.variables` was a declaration written by the API, validated for
// JSON-ness, and read by nothing: `["firstNane"]` was a clean 201 whose typo
// surfaced as a blank in a prospect's email. This round gives the column a
// reader — the boundary checks it against the text it claims to describe,
// through one vocabulary the renderer itself iterates.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MERGEABLE_COLUMNS,
  extractMergeVars,
  normalizeVariableDeclaration,
  checkTemplateVariables,
} from "../../src/lib/template-vars";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

describe("extractMergeVars", () => {
  it("finds tokens in order of first appearance, de-duplicated, across both texts", () => {
    assert.deepEqual(
      extractMergeVars("Hi {{firstName}} at {{company}}", "{{firstName}}, {{company}} and {{title}}"),
      ["firstName", "company", "title"],
    );
  });

  it("tolerates the nullable subject and an absent text", () => {
    assert.deepEqual(extractMergeVars(null, "by {{email}}", undefined), ["email"]);
    assert.deepEqual(extractMergeVars(), []);
  });

  it("sees only what the renderer's {{\\w+}} can match", () => {
    assert.deepEqual(extractMergeVars("{{ first-name }} {{a-b}} {{ok9_}}"), ["ok9_"]);
  });
});

describe("normalizeVariableDeclaration", () => {
  it("accepts a list and a comma-separated string, and stores one shape", () => {
    assert.deepEqual(normalizeVariableDeclaration([" firstName ", "company"]).names, ["firstName", "company"]);
    assert.deepEqual(normalizeVariableDeclaration("firstName, , lastName,firstName").names, ["firstName", "lastName"]);
  });

  it("a comma inside a LIST entry is not a second name — the split is the string spelling's", () => {
    assert.equal(normalizeVariableDeclaration(["company,foo"]).ok, false);
    assert.match(normalizeVariableDeclaration(["company,foo"]).error!, /word characters/);
  });

  it("refuses a name the renderer could never substitute", () => {
    const bad = normalizeVariableDeclaration(["first-name", "first name"]);
    assert.equal(bad.ok, false);
    assert.match(bad.error!, /word characters/);
  });

  it("refuses a non-list, a non-string entry, and an over-long name", () => {
    assert.match(normalizeVariableDeclaration(42).error!, /array of variable names or a comma-separated string/);
    assert.match(normalizeVariableDeclaration(["ok", 7]).error!, /every variable must be text/);
    assert.match(normalizeVariableDeclaration(["x".repeat(61)]).error!, /at most 60 characters/);
  });

  it("caps the declaration at 50 names, counted after de-duplication", () => {
    const many = Array.from({ length: 51 }, (_, i) => `v${i}`);
    assert.match(normalizeVariableDeclaration(many).error!, /declares 51 variables; at most 50/);
    assert.deepEqual(normalizeVariableDeclaration(many.slice(0, 50)).ok, true);
  });
});

describe("checkTemplateVariables reads the declaration against the text", () => {
  it("a declared name no text uses is decoration", () => {
    assert.deepEqual(checkTemplateVariables(["firstName", "firstNane"], ["Hi {{firstName}}"]), [
      'variables declares "firstNane", which no subject or body text ever uses',
    ]);
  });

  it("a token no declaration covers is an emptiness", () => {
    assert.deepEqual(checkTemplateVariables(["firstName"], ["Hi {{firstName}}, from {{company}}"]), [
      "text uses {{company}}, which variables never declares",
    ]);
  });

  it("both directions report at once, text order first within each rule", () => {
    const problems = checkTemplateVariables(["title", "phone"], ["Hi {{firstName}} at {{company}}"]);
    assert.deepEqual(problems, [
      'variables declares "title", which no subject or body text ever uses',
      'variables declares "phone", which no subject or body text ever uses',
      "text uses {{firstName}}, which variables never declares",
      "text uses {{company}}, which variables never declares",
    ]);
  });

  it("an empty declaration makes the rules silent — no promise, nothing to break", () => {
    assert.deepEqual(checkTemplateVariables([], ["Hi {{whoever}}"]), []);
  });

  it("a full honest declaration across subject and body passes", () => {
    assert.deepEqual(
      checkTemplateVariables(["firstName", "greeting"], ["{{greeting}} there", "Hi {{firstName}}"]),
      [],
    );
  });
});

describe("one vocabulary: the renderer iterates what the boundary knows", () => {
  const engine = source("../../src/lib/sequence-engine.ts");
  const render = /function renderTemplate[\s\S]*?\n\}/.exec(engine)?.[0] ?? "";

  it("the column list is the five contact fields the send fills", () => {
    assert.deepEqual([...MERGEABLE_COLUMNS], ["firstName", "lastName", "company", "title", "email"]);
  });

  it("renderTemplate substitutes from MERGEABLE_COLUMNS, not five literals", () => {
    assert.ok(render.includes("for (const column of MERGEABLE_COLUMNS)"));
  });

  it("each substitution is a callback, so a contact value is never a `$` pattern", () => {
    assert.ok(
      render.includes('out.replace(new RegExp(`\\\\{\\\\{${column}\\\\}\\\\}`, "g"), () => contact?.[column] || "")'),
    );
  });

  it("the metadata catch-all still closes the render, so {{anyWord}} remains a token shape", () => {
    assert.ok(
      render.includes('return out.replace(/\\{\\{(\\w+)\\}\\}/g, (_, key) => metadata?.[key] || "")'),
    );
  });

  it("the renderer knows nothing else about declarations", () => {
    assert.doesNotMatch(render, /checkTemplateVariables|normalizeVariableDeclaration/);
  });
});

describe("the template routes check before Prisma ever sees the row", () => {
  const create = source("../../src/app/api/templates/route.ts");
  const patch = source("../../src/app/api/templates/[id]/route.ts");

  it("both doors import the shared module", () => {
    assert.match(create, /import \{ normalizeVariableDeclaration, checkTemplateVariables \} from "@\/lib\/template-vars"/);
    assert.match(patch, /import \{ normalizeVariableDeclaration, checkTemplateVariables \} from "@\/lib\/template-vars"/);
  });

  it("create normalises, then cross-checks, then creates — in that order", () => {
    assert.match(create, /const template = await prisma\.template\.create/);
    const normAt = create.indexOf("normalizeVariableDeclaration(input.data.variables)");
    const checkAt = create.indexOf("checkTemplateVariables(declared.names");
    const createAt = create.indexOf("prisma.template.create");
    assert.ok(normAt !== undefined && normAt >= 0 && checkAt > normAt && createAt > checkAt, "normalise < cross-check < create");
  });

  it("patch overlays the STORED row — editing body alone cannot silently orphan a declaration", () => {
    assert.match(patch, /select: \{ workspaceId: true, body: true, subject: true, variables: true \}/);
    assert.match(patch, /hasOwn\("variables"\) \? input\.data\.variables : _owned\.variables/);
    const checkAt = patch.indexOf("checkTemplateVariables(declaredNames, [merged.subject, merged.body])");
    const updateAt = patch.indexOf("prisma.template.update");
    assert.ok(checkAt >= 0 && updateAt > checkAt, "cross-check < update");
  });

  it("a refusal is the declared envelope: 400 through fieldProblem, naming the field", () => {
    assert.match(create, /return fieldProblem\("variables", declared\.error\)/);
    assert.match(create, /return fieldProblem\("variables", problems\.join\("; "\)\)/);
    assert.match(patch, /return fieldProblem\("variables", declared\.error\)/);
    assert.match(patch, /return fieldProblem\("variables", problems\.join\("; "\)\)/);
  });

  it("DELETE stays unbothered: a declaration is not a reference", () => {
    const del = /async function DELETE_impl[\s\S]*?\n\}/.exec(patch)?.[0] ?? "";
    assert.doesNotMatch(del, /checkTemplateVariables/);
  });
});
