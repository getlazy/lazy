/**
 * The structured remedy that travels with a refused accept.
 *
 * WHY THIS EXISTS
 * `lazy accept` refuses for a dozen distinct, each individually fixable,
 * reasons. At a terminal the refusal message is enough — it names the command.
 * In the review page it was not: the human got "Accept failed: <prose>" and had
 * to reconstruct the command themselves, which for a refusal naming 43
 * protected files is not a thing a person should be asked to do by hand.
 *
 * So the DAEMON — which is the only place that knows why it refused — attaches
 * this alongside the message, and every client renders it. The web page never
 * re-derives a remedy by pattern-matching the prose: a reason it has no mapping
 * for still shows the daemon's message verbatim plus whatever `command` the
 * daemon composed, and never an invented one.
 *
 * These types live in src/types/ because both sides need them and neither may
 * import the other (src/daemon imports src/server, so the reverse is a cycle).
 */

/**
 * Stable slug for a refusal. Clients switch on this for in-UI affordances;
 * anything they do not recognize falls back to message + command.
 */
export type AcceptRefusalReason =
  | 'approval-required'
  | 'approval-invalid'
  | 'pending-violations'
  | 'resurrection'
  | 'lfs-raw-blob'
  | 'out-of-sync'
  | 'merge-conflict'
  | 'mid-merge'
  | 'dirty-worktree'
  | 'no-session'
  | 'interrupted'
  | 'working'
  | 'parent-active'
  | 'no-commits'
  | 'already-accepted'
  | 'forge-approval-required'
  | 'mr-closed';

/**
 * A remedy the review page can perform itself, instead of sending the human to
 * a terminal. Absent when the only route is the command line.
 */
export type AcceptRemedyUiAction = 'passphrase' | 'sync';

export interface AcceptRemedy {
  reason: AcceptRefusalReason;
  /** One imperative line: what to do next, in the human's words. */
  next: string;
  /**
   * The exact, copy-pasteable command that fixes this refusal — every flag and
   * every file already filled in, nothing for the human to reconstruct.
   * Omitted when no single command fixes it (e.g. "wait for the agent").
   */
  command?: string;
  /** An action the review UI can offer in-page. */
  uiAction?: AcceptRemedyUiAction;
  /** Files the refusal is about, for display next to the command. */
  files?: string[];
}

const REASONS: ReadonlySet<string> = new Set<AcceptRefusalReason>([
  'approval-required', 'approval-invalid', 'pending-violations', 'resurrection',
  'lfs-raw-blob', 'out-of-sync', 'merge-conflict', 'mid-merge', 'dirty-worktree',
  'no-session', 'interrupted', 'working', 'parent-active', 'no-commits',
  'already-accepted', 'forge-approval-required', 'mr-closed',
]);

const UI_ACTIONS: ReadonlySet<string> = new Set<AcceptRemedyUiAction>(['passphrase', 'sync']);

/**
 * Parse a remedy that arrived over a transport (an RPC error body).
 *
 * Validated rather than cast: this crosses an external boundary, and a
 * half-shaped remedy must degrade to "no remedy" — the message alone — instead
 * of rendering `undefined` at the human as if it were a command.
 */
export function parseAcceptRemedy(value: unknown): AcceptRemedy | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.reason !== 'string' || !REASONS.has(raw.reason)) return undefined;
  if (typeof raw.next !== 'string' || !raw.next.trim()) return undefined;

  const remedy: AcceptRemedy = {
    reason: raw.reason as AcceptRefusalReason,
    next: raw.next,
  };
  if (typeof raw.command === 'string' && raw.command.trim()) remedy.command = raw.command;
  if (typeof raw.uiAction === 'string' && UI_ACTIONS.has(raw.uiAction)) {
    remedy.uiAction = raw.uiAction as AcceptRemedyUiAction;
  }
  if (Array.isArray(raw.files)) {
    const files = raw.files.filter((f): f is string => typeof f === 'string');
    if (files.length) remedy.files = files;
  }
  return remedy;
}

/**
 * Read a remedy off a thrown error, wherever it came from.
 *
 * In-process (the daemon's own web handler) the daemon's error object carries
 * `.remedy` directly; over RPC the client re-attaches the parsed one. Both are
 * read through this single accessor so callers never care which path they are on.
 */
export function acceptRemedyOf(err: unknown): AcceptRemedy | undefined {
  if (!err || typeof err !== 'object') return undefined;
  return parseAcceptRemedy((err as { remedy?: unknown }).remedy);
}
