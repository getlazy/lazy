/**
 * Parse the New-task form into a typed draft.
 *
 * Boundary only: trim, required-goal, and the Start-now-needs-a-prompt rule.
 * Code / type / agent / parent validation is the daemon's (createTask) — this
 * file must not grow a second copy of those rules. A failed parse keeps every
 * typed field so the page can re-render without losing what was written.
 */

export interface TaskCreateDraft {
  goal: string;
  prompt: string;
  code: string;
  parent: string;
  type: string;
  model: string;
  effort: string;
  review: string;
  reviewGate: string;
  reviewAutoFix: string;
  agent: string;
  startNow: boolean;
}

export type TaskCreateParseResult =
  | { ok: true; draft: TaskCreateDraft }
  | { ok: false; draft: TaskCreateDraft; error: string };

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** Read the submitted boxes. Empty strings mean "not supplied". */
export function readCreateTaskDraft(form: FormData): TaskCreateDraft {
  return {
    goal: field(form, 'goal'),
    prompt: field(form, 'prompt'),
    code: field(form, 'code'),
    parent: field(form, 'parent'),
    type: field(form, 'type'),
    model: field(form, 'model'),
    effort: field(form, 'effort'),
    review: field(form, 'review'),
    reviewGate: field(form, 'review_gate'),
    reviewAutoFix: field(form, 'review_auto_fix'),
    agent: field(form, 'agent'),
    // Checkbox: present with value "1" only when ticked.
    startNow: field(form, 'start_now') === '1',
  };
}

/**
 * Confirm the fields the page itself can judge before calling the daemon.
 *
 * Start-now without a prompt is refused here so we do not create a backlog
 * task and then have start fail with "has no prompt" — the human is still
 * on the form and nothing was written.
 */
export function parseCreateTaskForm(form: FormData): TaskCreateParseResult {
  const draft = readCreateTaskDraft(form);
  if (!draft.goal.trim()) {
    return { ok: false, draft, error: 'The goal cannot be empty.' };
  }
  if (draft.startNow && !draft.prompt.trim()) {
    return {
      ok: false,
      draft,
      error: 'A prompt is required to start a task. Add one, or create the task without starting.',
    };
  }
  return { ok: true, draft };
}
