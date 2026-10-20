import { prisma } from "@/lib/db";
import { MERGEABLE_COLUMNS } from "./template-vars";

/**
 * Which template a step will actually send.
 *
 * Exported because TWO callers must agree on it: the engine picks the copy with
 * it, and the enrollment doors use it to decide which merge promises are live.
 * An arm's variant template overrides EVERY step of the arm — that is the
 * division of labour the variant's two fields state: `sequenceId` sends a
 * different track, `templateId` sends different copy down the same one. A door
 * that read `step.templateId` alone would therefore check promises the send
 * never makes and wave through the one it does: the arm's template declaring
 * `{{meetingDate}}` would enroll clean and mail the blank.
 *
 * `undefined` is accepted beside `null` because the two callers describe the
 * same absence differently — the engine's step type has `templateId?: string`
 * while the database column is nullable — and neither can override anything.
 */
export function effectiveTemplateId(
  variantTemplateId: string | null | undefined,
  stepTemplateId: string | null | undefined,
): string | null {
  return variantTemplateId ?? stepTemplateId ?? null;
}

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

/**
 * The merge promises the sends of one enrollment actually make, read from the
 * templates those steps will resolve to.
 *
 * One function, used by both enrollment doors, because two doors each writing
 * their own `step → template → declaration` read is how this fleet got its
 * divergent definitions of the same number. The step order is decided here for
 * the same reason: the first step that reaches a template is the one its
 * refusal names.
 */
export async function mergePromisesForSteps(
  steps: Array<{ stepNumber: number; templateId: string | null | undefined }>,
  variantTemplateId?: string | null,
): Promise<MergePromise[]> {
  const ordered = [...steps].sort((a, b) => a.stepNumber - b.stepNumber);
  const ids = [
    ...new Set(
      ordered
        .map((step) => effectiveTemplateId(variantTemplateId, step.templateId))
        .filter((id): id is string => id !== null),
    ),
  ];
  if (ids.length === 0) return [];

  const templates = await prisma.template.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, variables: true },
  });
  const byId = new Map(templates.map((template) => [template.id, template]));

  const promises: MergePromise[] = [];
  const counted = new Set<string>();
  for (const step of ordered) {
    const templateId = effectiveTemplateId(variantTemplateId, step.templateId);
    // An arm template is ONE promise, not one per step it overrides: three
    // identical refusals would be noise, and the value demanded is the same.
    if (!templateId || counted.has(templateId)) continue;
    const template = byId.get(templateId);
    // A dangling reference is the engine's to refuse at send, by name; here it
    // simply makes no promise.
    if (!template) continue;
    counted.add(templateId);
    const declared = columnExempt(template.variables);
    if (declared.length) promises.push({ stepNumber: step.stepNumber, templateName: template.name, declared });
  }
  return promises;
}
