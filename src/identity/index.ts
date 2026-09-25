/**
 * The identity question, answered once, for every surface that asks it.
 *
 * Two installs answer it from two places and NEITHER of them is a request
 * field:
 *   - single-person (a laptop): the daemon's own git config (./git-identity.ts)
 *   - teams (managed mode): the caller's own actor token
 *
 * A THIRD question, asked when there is no caller at all — who is acting when
 * the daemon starts work by itself — is answered by ./system-identity.ts, from
 * the same two environments and with the same rule that nothing is inferred.
 *
 * Which one applies is `isManagedMode()`, and no surface decides it for itself
 * — the CLI preflight, `lazy doctor` and the daemon's own refusal all render
 * {@link describeIdentity}'s answer, so they cannot disagree about whether a
 * write will be accepted.
 */

import { isManagedMode } from '../config/managed';
import { resolveGitIdentity } from './git-identity';

export type IdentityMode = 'single-person' | 'teams';

/** What the `identity` RPC returns, and what every surface renders. */
export interface IdentityAnswer {
  mode: IdentityMode;
  /** Can a write be attributed right now? False only in single-person mode. */
  configured: boolean;
  /** The person, when this install knows one without being told. */
  email?: string;
  name?: string;
  /** The text to show a human when `configured` is false. */
  refusal?: string;
}

/**
 * Answer "who does this daemon think is acting, and will a write be accepted".
 *
 * In managed mode the answer is always `configured: true` with no person: every
 * request carries its own identity on its token, so there is nothing about the
 * environment to configure and nothing to refuse up front. A request presenting
 * no user token is refused by the auth layer, which is a different question
 * from this one.
 */
export async function describeIdentity(projectRoot: string): Promise<IdentityAnswer> {
  if (isManagedMode()) return { mode: 'teams', configured: true };

  const resolution = await resolveGitIdentity(projectRoot);
  if (!resolution.configured) {
    return { mode: 'single-person', configured: false, refusal: resolution.refusal };
  }
  const { email, name } = resolution.identity;
  return {
    mode: 'single-person',
    configured: true,
    email,
    ...(name ? { name } : {}),
  };
}

export { resolveSystemIdentity, systemActor } from './system-identity';

export {
  resolveGitIdentity,
  clearGitIdentityCache,
  IDENTITY_REFUSAL,
  IDENTITY_TTL_MS,
  type GitIdentity,
  type IdentityFailure,
  type IdentityResolution,
} from './git-identity';
