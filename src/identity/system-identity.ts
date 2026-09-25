/**
 * WHO IS ACTING WHEN NOBODY ASKED — the configured account, and nothing else.
 *
 * The daemon starts turns and writes rows by itself: the reconciler resuming a
 * crashed task, auto-deliver handing an agent queued feedback, a sync nobody
 * typed. Those are §3.3 case 3 in
 * docs/design/actor-identity-and-remote-clients.md, and until now they recorded
 * nobody. They record the account that CONFIGURED the automation instead:
 *
 *   TEAMS — the owner of the project's service credential, the member whose
 *   Anthropic account those turns already spend
 *   (`Project#service_claude_credential`), pushed to the daemon beside the
 *   secret itself (src/daemon/user-credentials.ts).
 *
 *   A LAPTOP — the git identity (§3.4), because in single-person mode all three
 *   cases collapse to the one configured identity and the ROLE is what keeps
 *   them apart: the same person shows up as `human` when they typed it, `agent`
 *   when their agent did it, and `system` when the daemon did it by itself.
 *
 * THE CAVEAT IS THE POINT, and it is the engineer's own: a person who
 * configured automation is not the person who performed each automated act.
 * That is why the role says `system` on every one of these rows, and why
 * nothing here is inferred. There are exactly two sources, and where neither
 * answers, the answer is NOBODY — never a name assembled from a label, a token
 * or the last human to touch the task. In Teams a project with no service
 * credential has its automations disabled with their existing stated reason
 * (NO_SERVICE_CREDENTIAL_MARKER, src/daemon/turn-credentials.ts), so the
 * question does not arise there; a store written by an earlier daemon, or a
 * control plane that has not upgraded, is the case this returns null for.
 */

import { isManagedMode } from '../config/managed';
import { getServiceCredential } from '../daemon/user-credentials';
import { logger } from '../utils/logger';
import type { ActorInput, TurnOwner } from '../types';
import { resolveGitIdentity } from './git-identity';

/**
 * The identity to record for work nobody asked for, or null when this install
 * has not configured one.
 *
 * Cheap to call per row: managed mode reads the daemon's own credential file
 * (cached in process), and the git path is the same ~60 s cached resolution
 * every other identity surface uses.
 */
export async function resolveSystemIdentity(projectRoot: string): Promise<TurnOwner | null> {
  if (isManagedMode()) return serviceCredentialOwner(projectRoot);

  const resolution = await resolveGitIdentity(projectRoot);
  if (!resolution.configured) return null;
  const { email, name } = resolution.identity;
  return { email, ...(name ? { name } : {}) };
}

/**
 * The actor to stamp on a row the daemon writes for itself.
 *
 * Returns the bare role when no identity is configured — byte-identical to what
 * every one of these call sites passed before, so an install that has told the
 * daemon nothing keeps exactly the rows it had.
 *
 * A MISSING PROJECT ROOT is the same answer for the same reason. Several
 * reconciler helpers take the root optionally (every caller in the daemon
 * passes it; the parameter is older than they are), and a row with no root to
 * resolve against names nobody rather than guessing at one — the same rule
 * those helpers already follow when they hand `parkTaskPaused` no projectRoot.
 */
export async function systemActor(
  projectRoot: string | undefined,
  role: 'system' | 'supervisor' = 'system',
): Promise<ActorInput> {
  if (!projectRoot) return role;
  const identity = await resolveSystemIdentity(projectRoot);
  if (!identity) return role;
  return { role, email: identity.email, ...(identity.name ? { name: identity.name } : {}) };
}

/**
 * The service credential's owner, as the control plane pushed it.
 *
 * A read failure names NOBODY rather than propagating: these call sites are
 * writing a row for a turn that is already happening, and the choice they face
 * is between an unattributed row and no row at all. The first is the
 * pre-identity shape and reads as "we do not know"; the second loses the record
 * of the work itself.
 */
async function serviceCredentialOwner(projectRoot: string): Promise<TurnOwner | null> {
  try {
    const record = await getServiceCredential(projectRoot);
    if (!record?.ownerEmail) return null;
    return { email: record.ownerEmail, ...(record.ownerName ? { name: record.ownerName } : {}) };
  } catch (err) {
    logger.debug(
      `Could not resolve the system identity from the service credential: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
