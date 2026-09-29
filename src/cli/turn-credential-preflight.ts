/**
 * "Would this turn be refused for want of a model credential?" — asked BEFORE
 * an editor or prompt opens.
 *
 * The daemon refuses a turn whose agent profile has no credential
 * (src/daemon/credential-gate.ts), and it may be running with none at all.
 * Finding that out after the editor closes would leave the human's words in a
 * recovery file, so every verb that collects text and then launches a turn asks
 * first, next to the identity and usage-pause pre-flights. The daemon is still
 * the authority: this only saves typing into a turn that cannot start.
 */

import { tryRpc } from '../daemon/client';
import { logger } from '../utils/logger';

/**
 * The daemon's refusal for the task's next turn, or null when it would launch.
 *
 * `agentId` is the profile an `--agent` switch will run the turn on; `beside`
 * judges a model run beside the task instead (the builder role's profile, which
 * a record-route `lazy ask` spends). Never blocks on a daemon problem: a check
 * that could not run is not evidence of a missing credential, and the launch
 * itself decides.
 */
export async function turnCredentialRefusal(
  taskId: string,
  opts: { agentId?: string; beside?: boolean } = {},
): Promise<string | null> {
  try {
    const answer = await tryRpc<{ refusal: string | null }>('turnCredentialCheck', {
      taskId,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.beside ? { beside: true } : {}),
    });
    return answer?.refusal ?? null;
  } catch (err) {
    logger.debug(`Turn-credential preflight could not run: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Exit 1 with the daemon's refusal when the task's next turn has no credential. */
export async function requireTurnCredential(
  taskId: string,
  opts: { agentId?: string; beside?: boolean } = {},
): Promise<void> {
  const refusal = await turnCredentialRefusal(taskId, opts);
  if (!refusal) return;
  console.error(refusal);
  console.error('Nothing was opened or saved; connect the credential and run this again.');
  process.exit(1);
}
