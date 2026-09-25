/**
 * Submit confirmation tiers — one wording, every surface.
 *
 * Protected target → plain yes/no (default No).
 * Unprotected or unknown → strong: type the target branch (or the task code).
 * An existing PR skips the escalation: updating it is not the hazard.
 *
 * The daemon's preflight is the only source of the verdict. This module
 * formats that verdict; it never asks the forge itself.
 */

export type SubmitConfirmTier = 'plain' | 'strong' | 'none';

export interface SubmitPreflight {
  canSubmit: boolean;
  refusal?: string;
  targetBranch: string;
  taskCode: string | null;
  targetIsProtected: boolean | 'unknown';
  unknownReason?: string;
  existingPrUrl?: string | null;
  confirmationTier: SubmitConfirmTier;
  forgeName: string;
  /**
   * The target is an intermediate task branch (the parent task's). Only a
   * person's explicit submit gets this far with one; the PR/MR is opened
   * against that branch, and accept still merges locally and closes it.
   */
  intermediate?: boolean;
}

export function submitPlainConfirmText(preflight: SubmitPreflight): string {
  return `Create PR into \`${preflight.targetBranch}\` (protected on ${preflight.forgeName})?`;
}

export function submitStrongConfirmText(preflight: SubmitPreflight): string {
  if (preflight.intermediate) {
    return (
      `\`${preflight.targetBranch}\` is an intermediate task branch — lazy never opens a PR for one on its own. ` +
      `This opens one on ${preflight.forgeName} for review; accept still merges locally and closes it. ` +
      `Type the target branch name (\`${preflight.targetBranch}\`) or the task code to proceed.`
    );
  }
  const unknown = preflight.targetIsProtected === 'unknown' && preflight.unknownReason
    ? ` Whether it is protected could not be determined (${preflight.unknownReason}).`
    : '';
  return (
    `\`${preflight.targetBranch}\` is not protected on ${preflight.forgeName}.${unknown} ` +
    `Accept will merge locally and a PR is likely unnecessary. ` +
    `Type the target branch name (\`${preflight.targetBranch}\`) or the task code to proceed.`
  );
}

export function submitConfirmMatches(
  typed: string,
  preflight: SubmitPreflight,
  taskCode: string | null,
): boolean {
  const value = typed.trim();
  if (!value) return false;
  if (value === preflight.targetBranch) return true;
  if (taskCode && value === taskCode) return true;
  return false;
}

export function submitTierFromPreflight(preflight: {
  canSubmit: boolean;
  targetIsProtected: boolean | 'unknown';
  existingPrUrl?: string | null;
}): SubmitConfirmTier {
  if (!preflight.canSubmit) return 'none';
  if (preflight.existingPrUrl) return 'plain';
  if (preflight.targetIsProtected === true) return 'plain';
  return 'strong';
}
