/**
 * What holds a template back from deletion, named the way the buyer can act
 * on it.
 *
 * Both template references in the schema (`SequenceStep.templateId`,
 * `ABTestVariant.templateId`) are optional foreign keys, so the database's own
 * `SetNull` erases the reference the moment the row is deleted — before any
 * send, or any send-time refusal, could see it. A deleted step template used
 * to unfurl into the placeholder `Step N` copy, and a deleted arm template
 * fell the arm back to the step's copy. The refusal therefore lives at the
 * delete, where the reference still exists to be named.
 */
export interface TemplateUse {
  /** One entry per referencing step, so a sequence's steps group into one clause. */
  sequenceSteps: Array<{ sequenceName: string; stepNumber: number }>;
  arms: Array<{ testName: string; armName: string }>;
}

export function templateInUseMessage(use: TemplateUse): string {
  const stepsBySequence = new Map<string, number[]>();
  for (const step of use.sequenceSteps) {
    stepsBySequence.set(step.sequenceName, [...(stepsBySequence.get(step.sequenceName) ?? []), step.stepNumber]);
  }

  const parts: string[] = [];
  for (const [name, steps] of stepsBySequence) {
    parts.push(`sequence "${name}" (step ${steps.sort((a, b) => a - b).join(", ")})`);
  }
  for (const arm of use.arms) {
    parts.push(`A/B test "${arm.testName}" (arm "${arm.armName}")`);
  }

  return `template is in use by ${parts.join(" and ")} — it cannot be deleted while a reference exists`;
}
