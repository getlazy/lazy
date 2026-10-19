/**
 * "The last turn FAILED" — derived from the turns, never a new status.
 *
 * A turn that dies on an unrecoverable failure (a dead credential, a bad model
 * id, an endpoint that never came up) or never launches at all parks the task
 * for a human. Before this existed the park looked exactly like a review park:
 * `blocked`, no substate, the reason buried in one turn body — and a person
 * re-sent the same feedback for fourteen hours, reading the silence as the
 * agent ignoring them.
 *
 * The label is derived from the turns: lazy records every such failure as a
 * turn carrying `failure` (src/types `Turn.failure`), so the task has failed
 * exactly while that notice is its latest WORK-type turn and it is not
 * running. Storage projects that fact onto the session
 * (`Session.last_turn_failure`) in the same write as the turn, so list
 * surfaces never read turns.json; any later work turn — the human's next
 * feedback, a successful agent turn — clears it. There is no new status.
 */

import type { Session, Task, TurnFailure } from '../types';

/** The failure a parked task is showing, with when it happened. */
export type TaskTurnFailure = NonNullable<Session['last_turn_failure']>;

/** Statuses in which a failure is the task's current state. */
const SHOWS_FAILURE = new Set<string>(['blocked', 'conflict', 'interrupted', 'submitted']);

/** True when a task in `status` can be showing a failed last turn. */
export function statusCanShowFailure(status: string): boolean {
  return SHOWS_FAILURE.has(status);
}

/**
 * The failure the task is parked on, or null when its last work turn did not
 * fail or it is running. Reads the session's projection, which storage keeps in
 * the same write as the turn — so no surface ever opens turns.json for it.
 */
export function taskTurnFailure(
  task: Pick<Task, 'status'>,
  session: Pick<Session, 'last_turn_failure'> | null | undefined,
): TaskTurnFailure | null {
  if (!SHOWS_FAILURE.has(task.status)) return null;
  return session?.last_turn_failure ?? null;
}

/** Short label every list surface shows beside the status, e.g. `failed:fatal_auth`. */
export function turnFailureLabel(failure: Pick<TurnFailure, 'class'>): string {
  return `failed:${failure.class}`;
}

/** Heading a failure notice turn starts with — lazy's, never the agent's. */
export const TURN_FAILURE_LAUNCH_HEADING = '[Lazy: the turn could not start]';

/**
 * True when a ChatGPT refresh failed because the refresh token had already
 * been spent — by another copy of the same signed-in session.
 */
export function isRefreshTokenReused(text: string): boolean {
  return /refresh_token_reused|refresh token has already been used/i.test(text);
}

/**
 * Why `refresh_token_reused` happens, in words a user can act on. A ChatGPT
 * sign-in hands out ONE refresh token, and every refresh spends it and issues
 * the next. `lazy auth import chatgpt` copies the codex CLI's own session, so
 * from then on lazy and that codex CLI hold the same token: whichever refreshes
 * first retires the other's copy.
 */
export const REFRESH_TOKEN_SHARED_EXPLANATION =
  'This usually means the same ChatGPT sign-in is being used in two places — for example lazy and ' +
  'your own `codex` CLI after `lazy auth import chatgpt` copied its session. Each refresh spends the ' +
  'refresh token both copies hold, so the other copy stops working. After re-importing, sign your ' +
  'own codex CLI in again (`codex login`) so it gets a session of its own.';

/**
 * What lazy itself does next about a failure of this class, in one sentence.
 * A launch failure parks the task `interrupted`, which auto-resume retries a
 * bounded number of times; every other class parks it for a person and nothing
 * retries it. Copy that promised "not retried" for both was wrong.
 */
export function turnFailureRetryNote(cls: string): string {
  return cls === 'launch_failed'
    ? 'lazy retries starting it a few times by itself; if it keeps failing, it stops until a person fixes the cause.'
    : 'Nothing will retry it until a person fixes the cause.';
}

/** What a person does about a failure of this class. */
export function turnFailureRemedy(cls: string, reason: string, agent?: string): string {
  const profile = agent ? `agent profile "${agent}"` : "the task's agent profile";
  const resend = 'Then unblock or resume the task — feedback you already sent is kept and delivered with the next turn, so there is no need to send it again.';
  switch (cls) {
    case 'fatal_auth': {
      const shared = isRefreshTokenReused(reason) ? ` ${REFRESH_TOKEN_SHARED_EXPLANATION}` : '';
      return `Re-connect the credential behind ${profile} (the error details name the step).${shared} ${resend}`;
    }
    case 'fatal_config':
      return `Fix the configuration the error names (model, agent binary or lazy.toml for ${profile}). ${resend}`;
    case 'transient_unreachable':
      return `The endpoint behind ${profile} stayed unreachable after every retry; bring it back or point the profile elsewhere. ${resend}`;
    case 'launch_failed':
      return `Fix the cause the error names (it is about the task's environment, not the agent). ${resend}`;
    default:
      return `Fix the cause the error names. ${resend}`;
  }
}

