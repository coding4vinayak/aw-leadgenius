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

/** A merge value is a phrase of copy, not an essay: 500 characters. */
export const MERGE_VALUE_MAX_LENGTH = 500;
/** One enrollment answers one prospect. */
export const MERGE_VALUES_MAX_KEYS = 40;

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
 * The declaration is stored as the array the shape rule leaves behind: a
 * `json` column whose boundary accepts object-or-array and refuses a bare
 * string, so `["a","b"]` is the only spelling a caller can send and the only
 * shape a reader can find. `normalizeVariableDeclaration` still reads a
 * comma-separated string too — the rule lives here, not in the field table,
 * so a caller is one declaration-shape edit away from both spellings, never
 * one function away.
 *
 * Names are trimmed, de-duplicated in order, and capped. A name the renderer
 * could never substitute is refused here rather than stored to be quietly
 * unfilled later — `first-name` cannot match `{{\w+}}`.
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

/**
 * The declaration is a promise about a send that has not happened yet. The
 * five columns are filled from the contact row, which every enrollment has;
 * every other declared name is filled from `Enrollment.metadata` — a column
 * this app has no door for until this round, which made a declared
 * `{{meetingDate}}` an emptiness no API caller could answer. These two
 * functions are that door's rules: the shape the values may have, and the
 * check that a promised value is actually carried.
 */

/**
 * A merge value after the shape rule: text, a number or a boolean — the three
 * things that can honestly be dropped into a sentence. Prisma's `InputJsonValue`
 * takes exactly this, which is the type's way of agreeing.
 */
export type MergeValues = Record<string, string | number | boolean>;

/**
 * The merge values one enrollment supplies. No coercion: text, a number or a
 * boolean is stored as sent, because the render stringifies and `0` / `false`
 * are answers a prospect should see, not blanks. An object or an array has no
 * honest reading inside a sentence of copy — the first lands in the mail as
 * `[object Object]`, the second as a joined list nobody wrote — and `null`
 * says "nothing was filled", which the caller can already say by leaving the
 * key out.
 *
 * A key the renderer could never match is refused for the same reason the
 * template door refuses it in a declaration: `meeting-date` is not a token
 * shape, so the value would be dead data — paid for, never read.
 */
export function normalizeMergeValues(
  value: unknown,
  name = "metadata",
): { ok: true; values: MergeValues; error?: undefined } | { ok: false; values?: undefined; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `${name} must be an object of merge names to values, got ${describe(value)}` };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MERGE_VALUES_MAX_KEYS) {
    return { ok: false, error: `${name} holds ${entries.length} merge values; at most ${MERGE_VALUES_MAX_KEYS}` };
  }
  const values: MergeValues = {};
  for (const [key, raw] of entries) {
    if (!VAR_NAME.test(key)) {
      return {
        ok: false,
        error: `${name} holds ${short(key)}; a merge name is word characters — the renderer's {{…}} never matches anything else, so this value could never be read`,
      };
    }
    // The three shapes a sentence can carry, checked positively so the stored
    // type says the same thing this message does.
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      return {
        ok: false,
        error: `${name}.${key} is ${describe(raw)}; a merge value is text, a number or true/false — send "" for blank, or leave the key out`,
      };
    }
    if (typeof raw === "string" && raw.length > MERGE_VALUE_MAX_LENGTH) {
      return { ok: false, error: `${name}.${key} is ${raw.length} characters; a merge value is at most ${MERGE_VALUE_MAX_LENGTH}` };
    }
    values[key] = raw;
  }
  return { ok: true, values };
}

/**
 * Every declared name the contact row cannot fill must have a value on this
 * enrollment, or the send that follows will merge it to a blank in front of a
 * real prospect. A step whose template declares nothing is silent — no
 * promise, nothing to demand — and a blank string counts as no value, because
 * the merge is the difference between "Hi ," and "Hi Dana".
 */
export function unfilledMergeTokens(
  promises: Array<{ stepNumber: number; templateName: string; declared: readonly string[] }>,
  supplied: MergeValues | null | undefined,
): string[] {
  const problems: string[] = [];
  for (const promise of promises) {
    for (const name of promise.declared) {
      const columns: string[] = [...MERGEABLE_COLUMNS];
      if (columns.includes(name)) continue;
      const value = supplied?.[name];
      if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
        problems.push(
          `step ${promise.stepNumber}'s template "${promise.templateName}" fills {{${name}}} from the enrollment's metadata — send metadata.${name} or the merge lands blank in a real prospect's email`,
        );
      }
    }
  }
  return problems;
}
