/**
 * "Do we know who you are?" — asked BEFORE any editor or prompt opens.
 *
 * THE INVARIANT THIS SERVES is the most important one in lazy: the human must
 * never type feedback into `$EDITOR` only to have a pre-flight failure discard
 * it (CLAUDE.md, "Never Lose Human Feedback"). The daemon refuses a
 * store-writing RPC when it cannot name the acting person, so every command
 * that collects text from a human asks this question first, in the same
 * lightweight preflight block that already checks task status.
 *
 * It ASKS THE DAEMON rather than resolving git config here, because the
 * daemon's environment is the authority — it is the process that will perform
 * the write, and a CLI invoked from a different shell may see different config
 * (docs/design/actor-identity-and-remote-clients.md §3.4).
 *
 * Per the single-warning-surface rule, the point of occurrence prints the
 * refusal and ONE pointer; `lazy doctor` is where the diagnosis lives.
 */

import { queryIdentity } from '../daemon/rpc-fallback';
import { theme } from '../render/theme';
import { logger } from '../utils/logger';

/**
 * Exit 1 with git's wording when this daemon cannot attribute a write.
 *
 * Never blocks on a daemon problem: an identity check that could not run is not
 * evidence that the identity is missing, and the command the human actually
 * typed will report the real failure a moment later with a far better message.
 */
export async function requireActorIdentity(): Promise<void> {
  let refusal: string | undefined;
  try {
    const identity = await queryIdentity();
    if (identity.configured) return;
    refusal = identity.refusal;
  } catch (err) {
    logger.debug(
      `Identity preflight could not reach the daemon: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  console.error(refusal ?? 'Actor identity unknown.');
  console.error('');
  console.error(`Run ${theme.command('lazy doctor')} for the full diagnosis.`);
  process.exit(1);
}
