import { describe, short } from "./validation-engine";

/**
 * `Template.variables` was validated, stored, indexed by nothing, and read by
 * nothing: a template declaring `["firstNane"]` was a 201, and the typo only
 * surfaced as a blank in a prospect's email. The column is the shape a UI
 * needs — a list of merge tokens the template promises to fill — so this file
 * makes the promise mean something: one vocabulary shared with the renderer,
 * a shape rule for the declaration, and a cross-check against the text the
 * declaration claims describes.
 */

/**
 * The tokens `renderTemplate` substitutes from the contact row. The list is
 * exported because the renderer iterates it, so the boundary can only ever
 * know the names the send actually fills: a vocabulary the renderer ignored
 * would be a second table that can drift, which is what this column was.
 */
export const MERGEABLE_COLUMNS = ["firstName", "lastName", "company", "title", "email"] as const;

/** What the renderer's catch-all accepts, and so what a name can be. */
const VAR_NAME = /^\w+$/;

/**
 * Merge tokens in template text, in order of first appearance, de-duplicated.
 * Order matters to the message: the first problem a caller should see is the
 * first one in their own text.
 */
export function extractMergeVars(...texts: Array<string | null | undefined>): string[] {
  const found: string[] = [];
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!found.includes(match[1])) found.push(match[1]);
    }
  }
  return found;
}

/**
 * The declaration may be a list of names or a comma-separated string, and both
 * spellings are normalised to one list: trimmed, de-duplicated in order, capped.
 * A name the renderer could never substitute is refused here rather than
 * stored to be quietly unfilled later — `first-name` cannot match `{{\w+}}`.
 */
export function normalizeVariableDeclaration(
  value: unknown,
  name = "variables",
  max = 50,
): { ok: true; names: string[]; error?: undefined } | { ok: false; names?: undefined; error: string } {
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") {
        return { ok: false, error: `${name} holds ${describe(entry)}; every variable must be text` };
      }
      parts.push(entry);
    }
  } else if (typeof value === "string") {
    parts.push(...value.split(","));
  } else {
    return { ok: false, error: `${name} must be an array of variable names or a comma-separated string, got ${describe(value)}` };
  }

  const names: string[] = [];
  for (const part of parts) {
    const token = part.trim();
    if (!token) continue;
    if (token.length > 60) {
      return { ok: false, error: `${name} holds ${short(token)}; a variable name is at most 60 characters` };
    }
    if (!VAR_NAME.test(token)) {
      return { ok: false, error: `${name} holds ${short(token)}; a merge variable is word characters — the renderer's {{…}} never matches anything else` };
    }
    if (!names.includes(token)) names.push(token);
  }
  if (names.length > max) {
    return { ok: false, error: `${name} declares ${names.length} variables; at most ${max}` };
  }
  return { ok: true, names };
}

/**
 * The declaration and the text read against each other. A declared name no
 * text contains is decoration; a token no declaration covers is an emptiness
 * the sender will not notice and the prospect will.
 *
 * Both rules are silent when nothing is declared, because templates written
 * before this column had a reader exist, and their authors never made a
 * promise to break. Declaring is what takes the check out of maybe.
 */
export function checkTemplateVariables(
  declared: readonly string[],
  texts: Array<string | null | undefined>,
): string[] {
  if (declared.length === 0) return [];
  const used = extractMergeVars(...texts);
  const problems: string[] = [];

  for (const name of declared) {
    if (!used.includes(name)) problems.push(`variables declares "${name}", which no subject or body text ever uses`);
  }
  for (const name of used) {
    if (!declared.includes(name)) problems.push(`text uses {{${name}}}, which variables never declares`);
  }
  return problems;
}
