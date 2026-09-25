/**
 * Pins the action-dialog chrome and script contract for a protection-gate
 * refusal: passphrase is the primary affordance under the failed step, the
 * CLI command is secondary, and the gate text is not painted a second time
 * in #lz-action-error.
 *
 * Also pins dismiss-while-running and tall-form layout: Close stays clickable
 * for the whole run (dismiss does not cancel), success closes even without a
 * redirect, and the dialog grows to the viewport with a sticky submit row.
 */
import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { actionDialogChromeHtml, actionDialogScript } from '../../src/server/action-dialog';

describe('action dialog protection-gate remedy', () => {
  test('chrome reserves a slot for the in-dialog remedy', () => {
    const html = actionDialogChromeHtml();
    expect(html).toContain('id="lz-action-dialog"');
    expect(html).toContain('id="lz-action-remedy"');
    expect(html).toContain('id="lz-action-error"');
    expect(html).toContain('id="lz-action-steps"');
  });

  test('a passphrase refusal renders the field first and skips the duplicate error', () => {
    const script = actionDialogScript();
    expect(script).toContain("remedy.uiAction === 'passphrase'");
    expect(script).toContain('Approve and accept');
    expect(script).toContain('Or run this in the project directory');
    expect(script).toContain('renderPassphraseRemedy(remedy)');
    // The failed-step detail already has the gate text; showError would
    // paint it again.
    expect(script).toContain('renderPassphraseRemedy(remedy);\n        return;');
    expect(script).toContain('lz-action-form-hidden');
  });

  // INVARIANT (approval-happens-at-accept — move-file-approval-to-accept): the
  // dialog has no protected-file gate, because unblock takes no file decision
  // and reverts nothing. This test used to assert the opposite: Keep/Revert
  // radios per pending file with submit disabled until every one was answered.
  // Re-adding any of it would be rebuilding the revert one call site at a time.
  test('unblock has no per-file Keep/Revert gate', () => {
    const script = actionDialogScript();
    expect(script).not.toContain('wireUnblockPending');
    expect(script).not.toContain('data-lz-unblock-pending');
    expect(script).not.toContain('Keep or Revert');
  });

  test('page-level forms can opt into always intercepting', () => {
    const script = actionDialogScript();
    expect(script).toContain('data-lz-action-when');
    expect(script).toContain("when !== 'always'");
  });
});

describe('action dialog dismiss while running', () => {
  // INVARIANT: dismissing the dialog never disables Close for the run, never
  // cancels the server run, and never blocks ESC. A review can take minutes;
  // the human must get the page back without a refresh.
  test('Close is never disabled for a running action', () => {
    const script = actionDialogScript();
    expect(script).toContain('function setRunning(on)');
    expect(script).not.toContain('closeBtn.disabled');
    // Old bug: cancel listener called preventDefault while running.
    expect(script).not.toContain("addEventListener('cancel'");
    // Dismiss clears the client follow only — no AbortController / fetch abort.
    expect(script).not.toContain('AbortController');
    expect(script).not.toContain('.abort(');
    expect(script).toContain('clearFollow()');
    expect(script).toContain("addEventListener('close'");
  });

  test('success closes the dialog even without a redirect', () => {
    const script = actionDialogScript();
    expect(script).toContain("snap.status === 'done'");
    expect(script).not.toContain("snap.status === 'done' && snap.redirect");
    expect(script).toContain('if (snap.redirect) location.assign(snap.redirect)');
  });

  test('chrome Close is a method=dialog submit, never a disabled affordance', () => {
    const html = actionDialogChromeHtml();
    expect(html).toContain('method="dialog"');
    expect(html).toContain('data-lz-action-cancel');
    expect(html).not.toMatch(/data-lz-action-cancel[^>]*disabled/);
  });
});

describe('action dialog tall-form layout', () => {
  // INVARIANT: the dialog grows up to the viewport and pins the submit row
  // so Accept with raised items / passphrase never hides the primary action
  // below a surprise scroll.
  test('stylesheet grows to the viewport and sticks the form actions', async () => {
    const css = await readFile(join(import.meta.dir, '../../src/server/styles/review.css'), 'utf-8');
    expect(css).toContain('dialog.lz-action-dialog');
    expect(css).toContain('min-height: min(28rem, calc(100vh - 40px))');
    expect(css).toContain('max-height: calc(100vh - 40px)');
    expect(css).toContain('height: auto');
    // Old fixed height — must not return. Assert the property line, not a
    // substring of min-height: min(28rem, …).
    expect(/^\s*height:\s*min\(28rem/m.test(css)).toBe(false);
    expect(css).toContain('.lz-action-dialog-body .rv-form-actions');
    expect(css).toContain('position: sticky');
    expect(css).toContain('bottom: 0');
    // Dimmed Close while running was the old "busy" cue; Close stays usable.
    expect(css).not.toContain('dialog.lz-action-running .lz-action-dialog-close button');
  });
});
