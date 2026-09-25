/**
 * "Would this turn be held by the usage pause?" — asked BEFORE an editor opens.
 *
 * The daemon refuses a start/unblock/resume/ask on a paused credential
 * ([usage_pause], src/daemon/usage-pause.ts). Finding that out after the editor
 * closes would leave the human's feedback in a recovery file, so the commands
 * that collect text ask first, next to the identity pre-flight. The daemon is
 * still the authority: this only saves the human typing into a turn that
 * cannot start, and a pending one-shot override is counted exactly as the
 * launch will count it.
 */

import { queryUsagePause } from '../daemon/rpc-fallback';
import { RpcApplicationError } from '../daemon/client';
import { isUsagePauseRefusal } from '../daemon/rpc-error';
import { USAGE_PAUSE_OVERRIDE_KEY } from '../daemon/usage-pause';
import { describeUsagePause, type UsagePauseVerdict } from '../usage-pause/policy';
import { getActor } from '../constants';
import { mayOfferUsagePauseOverride, overrideEligibleActor } from './human-terminal';
import type { Actor } from '../types';
import { theme } from '../render/theme';
import { logger } from '../utils/logger';

export type PreflightVerb = 'unblock' | 'start' | 'resume' | 'ask';

const NOT_DONE: Record<PreflightVerb, string> = {
  unblock: 'unblocked',
  start: 'started',
  resume: 'resumed',
  ask: 'asked',
};

/**
 * The lines explaining why the task's next turn would be refused, or null when
 * it would not be.
 *
 * `beside` judges a model run BESIDE the task instead — the builder role's
 * credential, which is what `lazy ask` spends on a finished task (the record
 * route) — rather than the task's own.
 *
 * Never blocks on a daemon problem: a check that could not run is not evidence
 * of a pause, and the launch itself decides.
 */
export async function usagePauseRefusalLines(
  taskId: string,
  verb: PreflightVerb,
  /** The agent an `--agent` switch will run the turn on; the daemon judges that one. */
  agentId?: string,
  opts: { beside?: boolean } = {},
): Promise<string[] | null> {
  let verdict;
  // Judged as the launch will be: without the pending override unless a
  // person at their own terminal is asking.
  const eligible = await mayOfferUsagePauseOverride();
  try {
    const state = await queryUsagePause({
      taskId,
      ...(agentId ? { agentId } : {}),
      ...(opts.beside ? { beside: true, actor: getActor() } : {}),
      usagePauseOverrideEligible: eligible,
    });
    verdict = (opts.beside ? state.beside?.verdict : state.task?.verdict) ?? null;
  } catch (err) {
    logger.debug(`Usage-pause preflight could not run: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!verdict) return null;
  return preflightRefusalLines(verdict, verb, eligible);
}

/**
 * The pre-flight's refusal for `verdict`. `offerOverride` names the one-shot
 * override command — only to a person who could use it
 * (`mayOfferUsagePauseOverride`), never to the builder or an agent.
 */
export function preflightRefusalLines(
  verdict: UsagePauseVerdict,
  verb: PreflightVerb,
  offerOverride: boolean,
): string[] {
  if (verdict.storeError) {
    // No override lifts this one: a person fixes the file.
    return [
      `The task cannot be ${NOT_DONE[verb]} right now: lazy cannot read its saved usage readings.`,
      `  ${describeUsagePause(verdict)}`,
      `Run ${theme.command('lazy doctor')} for the full diagnosis.`,
    ];
  }
  return [
    `The task cannot be ${NOT_DONE[verb]} right now: new turns on this credential are paused.`,
    `  ${describeUsagePause(verdict)}`,
    ...(offerOverride
      ? [`  To let ONE turn start anyway: ${theme.command(`lazy daemon config set ${USAGE_PAUSE_OVERRIDE_KEY} off`)}`]
      : [`  New turns on this credential can start again once the window resets.`]),
    `Run ${theme.command('lazy doctor')} for the full diagnosis.`,
  ];
}

/** Exit 1 with the pause explanation when the task's next turn would be held. */
export async function requireUsagePauseClear(
  taskId: string,
  verb: PreflightVerb,
  agentId?: string,
): Promise<void> {
  const lines = await usagePauseRefusalLines(taskId, verb, agentId);
  if (!lines) return;
  for (const line of lines) console.error(line);
  process.exit(1);
}

/**
 * Admit an interactive session — `lazy pair` or `lazy chat` — through the
 * usage pause, before it opens (and before any lock is taken). The daemon
 * judges it like a start and may spend the person's one-shot override on it;
 * a refusal exits 1 with the daemon's own explanation.
 *
 * Unlike the pre-flight above, a daemon that cannot be asked is not waved
 * through here: this IS the gate for these sessions, which never pass another.
 * A daemon that is not running fails the command (it needs one anyway); where
 * the RPC is bypassed by design (the daemon itself, the in-process harness) the
 * same admission runs in-process (`queryUsagePause`'s fallback).
 */
export async function admitInteractiveOrExit(
  surface: 'pair' | 'chat',
  taskId?: string,
  /** Decide only — never take the override. For a check before the command's own refusals. */
  opts: { peek?: boolean } = {},
): Promise<void> {
  const refusal = await admitInteractive(surface, taskId, opts);
  if (refusal === null) return;
  console.error(refusal);
  process.exit(1);
}

/**
 * The same admission, returning the daemon's refusal text instead of exiting —
 * for a caller holding a lock or other state its own cleanup must release.
 * Null when admitted.
 */
export async function admitInteractive(
  surface: 'pair' | 'chat',
  taskId?: string,
  opts: { peek?: boolean } = {},
): Promise<string | null> {
  try {
    await queryUsagePause({
      action: 'admitInteractive',
      surface,
      ...(taskId ? { taskId } : {}),
      ...(opts.peek ? { peek: true } : {}),
      // Only a person at a real terminal may TAKE the override (see
      // overrideEligibleActor); anything else is judged on the threshold alone.
      ...(await overrideEligibleActorOrUndefined()),
    });
    return null;
  } catch (err) {
    // The daemon's refusal over RPC, or the same refusal judged in-process
    // when the RPC is bypassed (queryUsagePause's fallback).
    if (err instanceof RpcApplicationError && err.status === 429) return err.message;
    if (isUsagePauseRefusal(err)) return (err as Error).message;
    throw err;
  }
}

async function overrideEligibleActorOrUndefined(): Promise<{ actor?: Actor }> {
  const actor = await overrideEligibleActor();
  return actor ? { actor } : {};
}
