/**
 * Parse the Link form into a typed draft.
 *
 * Boundary only: trim and require a ref. Code / parent validation is the
 * daemon's (`linkTask`) — this file must not grow a second copy of those
 * rules. A failed parse keeps every typed field so the page can re-render
 * without losing what was written.
 */

export interface TaskLinkDraft {
  ref: string;
  parent: string;
  code: string;
}

export type TaskLinkParseResult =
  | { ok: true; draft: TaskLinkDraft }
  | { ok: false; draft: TaskLinkDraft; error: string };

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** Read the submitted boxes. Empty strings mean "not supplied". */
export function readLinkTaskDraft(form: FormData): TaskLinkDraft {
  return {
    ref: field(form, 'ref'),
    parent: field(form, 'parent'),
    code: field(form, 'code'),
  };
}

/**
 * Confirm the fields the page itself can judge before calling the daemon.
 *
 * A blank ref is refused here so we do not round-trip a daemon 400 for an
 * empty box the human is still looking at.
 */
export function parseLinkTaskForm(form: FormData): TaskLinkParseResult {
  const draft = readLinkTaskDraft(form);
  if (!draft.ref.trim()) {
    return { ok: false, draft, error: 'A pull-request URL or branch name is required.' };
  }
  return { ok: true, draft };
}
