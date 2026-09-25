/**
 * Submit control for the task page — header and Current review share one
 * dialog, the same confirmation tiers as `lazy submit`.
 *
 * The button is offered whenever submit *could* succeed (blocked or conflict
 * with work to send). The dialog — not a disabled control — is where a
 * refusal lands (local driver, intermediate parent, no commits). Hiding the
 * button when preflight said no is how it went missing on the page a reviewer
 * actually looks at.
 */

import { escapeHtml } from './review-diff';
import { actionDialogButtonHtml, actionDialogTemplateHtml } from './action-dialog';
import {
  submitPlainConfirmText,
  submitStrongConfirmText,
} from '../submit-confirmation';
import type { TaskSubmitPreflight } from './task-actions';
import type { TaskStatus } from '../types';

/** Statuses from which a PR can be opened. Mirrors `submitTaskPreflight`. */
export function taskCanOfferSubmit(status: TaskStatus): boolean {
  return status === 'blocked' || status === 'conflict';
}

/**
 * Enabled Submit button plus its dialog template.
 *
 * Always clickable. `preflight.canSubmit === false` (or a missing preflight)
 * fills the dialog with the refusal so the reviewer sees why, instead of a
 * greyed-out control that looks like the action does not exist.
 */
export function submitActionHtml(
  taskId: string,
  preflight: TaskSubmitPreflight | null | undefined,
): string {
  const btn = actionDialogButtonHtml({ verb: 'submit', label: 'Submit' });
  return btn + actionDialogTemplateHtml('submit', submitDialogBodyHtml(taskId, preflight));
}

export function submitDialogBodyHtml(
  taskId: string,
  preflight: TaskSubmitPreflight | null | undefined,
): string {
  if (!preflight) {
    return `<div class="lz-action-form lz-submit">
      <p>Submit could not be checked just now. Reload the page and try again.</p>
    </div>`;
  }
  if (!preflight.canSubmit) {
    return `<div class="lz-action-form lz-submit">
      <p>${escapeHtml(preflight.refusal ?? 'Submit is not available.')}</p>
    </div>`;
  }
  if (preflight.confirmationTier === 'plain') {
    return `<form method="post" action="/tasks/${escapeHtml(taskId)}/actions/submit" class="lz-action-form lz-submit" data-lz-action-form>
        <p>${escapeHtml(submitPlainConfirmText(preflight))}</p>
        <label class="lz-confirm-check"><input type="checkbox" name="confirm" value="1" required> Yes, create the PR</label>
        <div class="rv-form-actions"><button type="submit" class="btn">Submit for review</button></div>
      </form>`;
  }
  return `<form method="post" action="/tasks/${escapeHtml(taskId)}/actions/submit" class="lz-action-form lz-submit" data-lz-action-form>
      <p>${escapeHtml(submitStrongConfirmText(preflight))}</p>
      <input class="input" type="text" name="typed_confirmation" required placeholder="${escapeHtml(preflight.targetBranch)}" autocomplete="off">
      <div class="rv-form-actions"><button type="submit" class="btn">Submit for review</button></div>
    </form>`;
}
