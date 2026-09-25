/**
 * The one Decide affordance for raised items, rendered identically wherever a
 * raised item is shown: the Raised-tab dialog/panel (`raisedPanelHtml`) and
 * any remaining permalink wrap.
 *
 * There used to be two of these — a dropdown for raised items and a separate
 * card for follow-ups — because they were two entities. They are one now
 * (docs/design/raised-items-unified.md), so there is one control, offering the
 * same five decisions on every item. The `blocking` flag changes only the COPY:
 * a blocking item's promote hint says the decision also clears the accept gate.
 *
 * Acknowledge and dismiss are the same act — "I saw it and I am taking no
 * action" — differing only in valence ("maybe later" vs "will not act"), which
 * is worth recording over time. Both close a blocking item's gate.
 *
 * Promote is a CARD, not a bare button: the goal and the code are the two
 * things a human wants to correct before a task exists under a name nobody
 * chose.
 *
 * Plain-form POST, like the rest of the review surface. The enhancement script
 * only HIDES the fields that do not apply to the selected decision; with
 * JavaScript off every field is visible and the single Apply button still works.
 */

import { escapeHtml } from './review-diff';
import type { RaisedItemResolveAction } from '../types';

/** The decisions a human can record on a raised item from the web. */
export const RAISED_DECISIONS = [
  'respond',
  'acknowledge',
  'dismiss',
  'promote_subtask',
  'promote_peer',
] as const;

export interface RaisedDecisionInput {
  /** Raised item id the decision applies to. */
  id: string;
  action: RaisedItemResolveAction;
  /** Response / note / dismiss reason; null when blank. */
  response: string | null;
  /** Promote-card goal override; undefined when blank (storage synthesizes one). */
  goal?: string;
  /** Promote-card code override; undefined when blank (storage allocates one). */
  code?: string;
}

/**
 * Read a decide form. Returns a message instead of throwing so every route can
 * re-render its own page with the reason in place.
 *
 * Accepts both field spellings: the bracketed `raised_action[<id>]` the review
 * page uses (so the accept/unblock island can copy the same controls) and the
 * plain `raised_action` a standalone page posts.
 */
export function parseRaisedDecisionForm(
  form: FormData,
  options: { id?: string } = {},
): { decision: RaisedDecisionInput } | { error: string } {
  const id = (options.id ?? String(form.get('id') ?? '')).trim();
  if (!id) return { error: 'A raised-item decision needs a raised item id.' };
  const pick = (base: string): string =>
    String(form.get(`${base}[${id}]`) ?? form.get(base) ?? '').trim();
  const action = pick('raised_action') || String(form.get('action') ?? '').trim();
  if (!(RAISED_DECISIONS as readonly string[]).includes(action)) {
    return {
      error: 'Choose a decision: respond, acknowledge, dismiss, promote to subtask, or promote to peer.',
    };
  }
  // One form carries every decision's fields, so a note typed before switching
  // the select to promote would ride along unused. Promotion records no
  // response in the storage vocabulary — drop it here rather than downstream,
  // so the parsed shape says exactly what will be recorded.
  const isPromote = action === 'promote_subtask' || action === 'promote_peer';
  const response = isPromote ? null : pick('raised_response') || null;
  const goal = pick('raised_goal') || undefined;
  const code = pick('raised_code') || undefined;
  return {
    decision: {
      id,
      action: action as RaisedItemResolveAction,
      response,
      ...(goal ? { goal } : {}),
      ...(code ? { code } : {}),
    },
  };
}

export interface RaisedDecideFormOptions {
  /** Where the form POSTs — a raw path; this module escapes it. */
  action: string;
  /** Raised item id, carried as a hidden field. */
  id: string;
  /** Whether this item gates accept — decides the option set and the copy. */
  blocking: boolean;
  /** Prefilled promote goal — the item's title. */
  defaultGoal: string;
  /** Prefilled promote code, when the agent proposed one. */
  defaultCode?: string;
  /** `card` stacks the fields for the permalink page; `inline` stays compact in the review list. */
  variant?: 'inline' | 'card';
  /**
   * Emit `raised_action[<id>]`-style names and mark them `data-rv-raised-field`,
   * so the review island can copy a decision into accept/unblock. Off for a
   * standalone page, where there is nothing to copy into.
   */
  bracketed?: boolean;
}

/**
 * The Decide dropdown plus the fields each decision needs.
 *
 * Every field is inside ONE form with ONE submit, so a decision is one gesture
 * whether or not the browser runs the enhancement script.
 */
export function raisedDecideFormHtml(options: RaisedDecideFormOptions): string {
  const { action, id, blocking, defaultGoal, defaultCode, variant = 'inline', bracketed = false } = options;
  const idAttr = escapeHtml(id);
  const name = (base: string) => (bracketed ? `${escapeHtml(base)}[${idAttr}]` : escapeHtml(base));
  const copyAttr = bracketed ? ' data-rv-raised-field' : '';
  const promoteHint = blocking
    ? 'Creates the task — never auto-starts it — records this item promoted, and clears the accept gate: dispatching the work IS the decision.'
    : 'Creates a backlog task — never auto-starts it — and records this item promoted.';
  return `<form class="rv-raised-decide rv-raised-decide-${variant}" method="post" action="${escapeHtml(action)}">
      <input type="hidden" name="id" value="${idAttr}">
      <label class="rv-raised-action">
        <span class="rv-raised-field-label">Decide</span>
        <select name="${name('raised_action')}"${copyAttr} required>
          <option value="">Decide…</option>
          <option value="respond">Respond to agent</option>
          <option value="acknowledge">Acknowledge — noted</option>
          <option value="promote_subtask">Promote to subtask</option>
          <option value="promote_peer">Promote to peer task</option>
          <option value="dismiss">Dismiss</option>
        </select>
      </label>
      <label class="rv-raised-response" data-raised-for="respond acknowledge dismiss">
        <span class="rv-raised-field-label">Response</span>
        <input type="text" name="${name('raised_response')}"${copyAttr}
               placeholder="Response, note, or dismiss reason">
      </label>
      <!-- No data-rv-raised-field on the promote card: accept/unblock's
           raised_resolutions carry only the action and a response, so a goal or
           code copied into that form would be silently dropped. Promoting with
           an edited goal is this form's own POST. -->
      <div class="rv-raised-promote-card" data-raised-for="promote_subtask promote_peer">
        <p class="rv-hint">${escapeHtml(promoteHint)}</p>
        <label class="rv-raised-goal">
          <span class="rv-raised-field-label">Goal</span>
          <input type="text" name="${name('raised_goal')}" value="${escapeHtml(defaultGoal)}" placeholder="Goal for the promoted task">
        </label>
        <label class="rv-raised-code">
          <span class="rv-raised-field-label">Code</span>
          <input type="text" name="${name('raised_code')}" value="${escapeHtml(defaultCode ?? '')}" placeholder="derived from goal if empty">
        </label>
      </div>
      <button type="submit">Apply</button>
    </form>`;
}

/**
 * Hide the fields that do not belong to the chosen decision.
 *
 * Enhancement only: it never submits, never rewrites the form, and does nothing
 * at all when the select is missing — so a browser with scripting off shows
 * every field and the same single POST still records the same decision.
 */
export function raisedDecideScript(): string {
  return `<script>
    (function() {
      var forms = document.querySelectorAll('form.rv-raised-decide');
      for (var i = 0; i < forms.length; i++) {
        (function(form) {
          var select = form.querySelector('select[name^="raised_action"]');
          if (!select) return;
          var groups = form.querySelectorAll('[data-raised-for]');
          function sync() {
            for (var g = 0; g < groups.length; g++) {
              var wants = (groups[g].getAttribute('data-raised-for') || '').split(' ');
              groups[g].hidden = wants.indexOf(select.value) === -1;
            }
          }
          select.addEventListener('change', sync);
          sync();
        })(forms[i]);
      }
    })();
  </script>`;
}

/** Human-readable confirmation for a recorded decision. */
export function raisedDecisionNotice(
  action: RaisedItemResolveAction,
  promotedLabel?: string,
): string {
  switch (action) {
    case 'respond':
    case 'answer':
      return 'Response recorded — it rides the next unblock to the agent.';
    case 'acknowledge':
      return 'Raised item acknowledged — noted, nothing started.';
    case 'dismiss':
      return 'Raised item dismissed — it stays on the record.';
    case 'promote_subtask':
      return `Promoted to subtask ${promotedLabel ?? ''}`.trim() + ' (never auto-starts).';
    case 'promote_peer':
      return `Promoted to peer task ${promotedLabel ?? ''}`.trim() + ' (never auto-starts).';
  }
}
