
/**
 * "Would this turn be refused for want of a model credential?" — asked BEFORE
 * an editor or prompt opens.
 *
 * The daemon refuses a turn whose agent profile has no credential
 * (src/daemon/credential-gate.ts), and it may be running with none at all.
 * Verbs that collect text and then launch a turn WITHOUT saving it first
 * (`lazy ask`) ask first, so nothing is typed into a turn that cannot start.
 * `lazy unblock` deliberately does not: the daemon saves its feedback before
 * refusing. The daemon is still the authority either way.
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

