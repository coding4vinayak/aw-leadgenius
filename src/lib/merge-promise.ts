import { prisma } from "@/lib/db";
import { MERGEABLE_COLUMNS } from "./template-vars";

/**
 * The merge promises a sequence's steps actually make, read from the templates
 * they reference.
 *
 * `Template.variables` is a promise about a send, and `unfilledMergeTokens`
 * decides whether an enrollment can keep it — but the routes must first turn
 * `step → templateId → declaration` into one honest list, and two doors that
 * each wrote their own version of that read is how this fleet got its
 * divergent numbers in the first place. One function, used by enroll and by
 * the enrollment patch, so both ask the same question of the same rows.
 */
export interface MergePromise {
  stepNumber: number;
  templateName: string;
  /**
   * Declared names the contact row cannot fill — the five columns are exempt,
   * so what is left is exactly what only `Enrollment.metadata` can answer.
   */
  declared: string[];
}

/**
 * A stored declaration is read, never re-validated: templates written before
 * the column had a reader hold whatever JSON their author sent. Only word-shaped
 * string entries count as a promise — anything else names a token the
 * renderer's `{{\w+}}` could never match, so demanding a value for it would be
 * an enrollment that can never be satisfied.
 */
function columnExempt(variables: unknown): string[] {
  if (!Array.isArray(variables)) return [];
  // `MERGEABLE_COLUMNS` is `as const`, and a readonly list has no `includes`
  // for a widened `string` — the same five names, read as a mutable view.
  const columns: string[] = [...MERGEABLE_COLUMNS];
  return variables.filter(
    (name): name is string => typeof name === "string" && /^\w+$/.test(name) && !columns.includes(name),
  );
}

export async function mergePromisesForSteps(
  steps: Array<{ stepNumber: number; templateId: string | null }>,
): Promise<MergePromise[]> {
  const templateIds = [...new Set(steps.map((step) => step.templateId).filter((id): id is string => id !== null))];
  if (templateIds.length === 0) return [];

  const templates = await prisma.template.findMany({
    where: { id: { in: templateIds } },
    select: { id: true, name: true, variables: true },
  });
  const byId = new Map(templates.map((template) => [template.id, template]));

  const promises: MergePromise[] = [];
  for (const step of steps) {
    if (!step.templateId) continue;
    const template = byId.get(step.templateId);
    // A dangling reference is the engine's to refuse at send, by name; here it
    // simply makes no promise.
    if (!template) continue;
    const declared = columnExempt(template.variables);
    if (declared.length) promises.push({ stepNumber: step.stepNumber, templateName: template.name, declared });
  }
  return promises;
}
