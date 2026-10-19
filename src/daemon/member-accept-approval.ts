/**
 * Whether an accept is a signed-in Lazy Teams member's own Accept — the act
 * that satisfies branch protection on a managed host instead of the approval
 * passphrase (which has no surface in Teams, and which a team would otherwise
 * have to pass around between people).
 *
 * All four conditions, decided here from what the daemon AUTHENTICATED:
 *
 *   1. Managed mode. Outside it the passphrase stays the mechanism, unchanged.
 *   2. A USER-kind token — a member. Task agents, the builder and every MCP
 *      caller arrive on task/builder tokens, and the Teams app's background
 *      calls on the control token; none of them names a person.
 *   3. The `human` channel.
 *   4. {@link MEMBER_ACCEPT_PARAM} = true, which only the Teams app's own
 *      browser Accept sends. A member's token ALSO carries a bound clone's
 *      `lazy accept` through the Teams CLI proxy — and on that laptop any
 *      process the member runs (a builder, an agent on the host runner, a
 *      script) can drive that CLI. The proxy REFUSES this key for `acceptTask`
 *      (lazy-teams/app/models/cli_rpc_command.rb, BODY_KEYS), so a bound clone
 *      can never assert it. The passphrase is not a route on a managed daemon
 *      either (enforceEdgeGate ignores it there), so a bound clone cannot
 *      complete a protected accept at all — its CLI says to press Accept.
 *
 * Only the Teams app holds member tokens, the same trust the usage-pause
 * override's `usagePauseOverrideEligible` rests on (src/daemon/usage-pause.ts).
 */

import { isManagedMode } from '../config/managed-mode';
import { actorRole } from '../actor-ref';
import type { ActorInput } from '../types';
import type { MemberApproval } from '../protection/edge-gate';
import type { ActorIdentity } from './actor-tokens';

/** The acceptTask body key the Teams app sets on its own browser Accept. */
export const MEMBER_ACCEPT_PARAM = 'memberAccept';

export function memberAcceptApprover(
  params: Record<string, unknown>,
  caller: ActorIdentity,
): MemberApproval | undefined {
  if (!isManagedMode()) return undefined;
  if (caller.kind !== 'user') return undefined;
  if (params[MEMBER_ACCEPT_PARAM] !== true) return undefined;
  if (actorRole(params.actor as ActorInput | undefined) !== 'human') return undefined;
  return { email: caller.email, ...(caller.name ? { name: caller.name } : {}) };
}
