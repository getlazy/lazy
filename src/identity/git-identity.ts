/**
 * WHO IS ACTING, on an install that has no control plane to ask.
 *
 * Lazy records a person on every attributed row (`actor_email` / `actor_name`,
 * see src/actor-ref.ts). In Teams that person comes from the caller's token. On
 * a laptop there is no token and no directory of people — so the identity comes
 * from the one place a developer has already put it, and the one place their
 * commits already take it from:
 *
 *     git -C <projectRoot> config --get user.email
 *     git -C <projectRoot> config --get user.name
 *
 * `git config --get` resolves git's own precedence chain — repo-local
 * `.git/config` over `~/.gitconfig` over system — so a per-repository address
 * wins exactly where it wins for `git commit`. There is deliberately NO
 * lazy-side reimplementation of that chain, no reading of config files, and no
 * lazy-level override: someone who wants lazy to record a different address
 * changes their git config, which is the same act in the same one place.
 *
 * THE ENVIRONMENT THAT COUNTS IS THE DAEMON'S. Every surface answers this
 * question by asking the daemon (the `identity` RPC), never by resolving it
 * locally — a CLI invoked from a different shell, a container, or a cron job
 * may legitimately see different config than the process that performs the
 * write, and the writer's answer is the one that lands in the store.
 *
 * Caching: a SUCCESS is cached per project root for {@link IDENTITY_TTL_MS}, a
 * FAILURE never. A subprocess per store-writing RPC is real cost inside the
 * daemon's event loop and 60 seconds is imperceptible against someone editing
 * their git config — but a person who has just been refused and fixed their
 * config must be believed immediately, without restarting a daemon.
 *
 * Rationale in full: docs/design/actor-identity-and-remote-clients.md §3.4–3.5.
 */

import { isPersonEmail } from '../actor-ref';
import { runGit } from '../utils/git';

/** The person a laptop install acts as. */
export interface GitIdentity {
  email: string;
  /** Git's `user.name`, when it is set. A person is reachable without one. */
  name?: string;
}

/** Why the git identity could not be used. */
export type IdentityFailure =
  /** `user.email` is not set at any level. */
  | { reason: 'unset' }
  /** `user.email` is set to something that is not an address. */
  | { reason: 'not-an-address'; value: string };

export type IdentityResolution =
  | { configured: true; identity: GitIdentity }
  | { configured: false; failure: IdentityFailure; refusal: string };

/** How long a SUCCESSFUL resolution is reused. Failures are never cached. */
export const IDENTITY_TTL_MS = 60_000;

/**
 * Git's own words, because this is git's own problem.
 *
 * A developer has read this text before — it is what `git commit` prints when
 * it cannot figure out who is committing — and recognising it is most of the
 * remedy. The last line is the only part that is ours: it says why lazy cares.
 */
export const IDENTITY_REFUSAL = [
  'Actor identity unknown.',
  '',
  '*** Please tell me who you are.',
  '',
  'Run',
  '',
  '  git config --global user.email "you@example.com"',
  '  git config --global user.name "Your Name"',
  '',
  "to set your account's default identity.",
  'Omit --global to set the identity only in this repository.',
  '',
  'lazy records who performed every action, and takes that identity from git.',
].join('\n');

/**
 * The refusal, with the extra sentence a MISCONFIGURED value needs.
 *
 * "Not set" and "set to `ivan`" are different problems with different fixes,
 * and the second one is invisible unless we say it: the value is there, git is
 * happy with it, and only lazy — which promises that `actor_email` names a
 * person you can mail — refuses it.
 */
function refusalFor(failure: IdentityFailure): string {
  if (failure.reason === 'unset') return IDENTITY_REFUSAL;
  return (
    `${IDENTITY_REFUSAL}\n\n` +
    `Git's user.email is currently "${failure.value}", which is not an email address. ` +
    'lazy stores the address itself, so it must be one.'
  );
}

interface CacheEntry {
  at: number;
  identity: GitIdentity;
}

const cache = new Map<string, CacheEntry>();

/** Drop every cached resolution. For tests, and for a daemon re-init. */
export function clearGitIdentityCache(): void {
  cache.clear();
}

/** One `git config --get <key>`, or null when the key is unset. */
async function gitConfigValue(projectRoot: string, key: string): Promise<string | null> {
  // `--get` exits 1 with no output when the key is unset; anything else is a
  // git that could not run at all, which is the same answer to this question
  // (we do not know who you are) and is reported the same way.
  const result = await runGit(['config', '--get', key], {
    cwd: projectRoot,
    stderr: 'ignore',
    // A config read is a local file read. A slow one means something is very
    // wrong (a hung credential helper, an unreachable mount) and the caller is
    // waiting inside an RPC, so fail fast rather than hold the event loop.
    timeout: 10_000,
  });
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

/**
 * Resolve the identity the daemon should stamp on writes for this project.
 *
 * Never throws: an unresolvable identity is an ANSWER (`configured: false`)
 * carrying the text to show the human, not an exception for each caller to
 * translate into its own wording.
 */
export async function resolveGitIdentity(projectRoot: string): Promise<IdentityResolution> {
  const cached = cache.get(projectRoot);
  if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) {
    return { configured: true, identity: cached.identity };
  }

  let email: string | null = null;
  let name: string | null = null;
  try {
    [email, name] = await Promise.all([
      gitConfigValue(projectRoot, 'user.email'),
      gitConfigValue(projectRoot, 'user.name'),
    ]);
  } catch {
    // runGit only throws when git itself could not be spawned. Same answer as
    // an unset key — we cannot name the person — and doctor's "Git installed"
    // check is where a missing git is diagnosed, not here.
    email = null;
    name = null;
  }

  if (!email) {
    const failure: IdentityFailure = { reason: 'unset' };
    return { configured: false, failure, refusal: refusalFor(failure) };
  }
  if (!isPersonEmail(email)) {
    const failure: IdentityFailure = { reason: 'not-an-address', value: email };
    return { configured: false, failure, refusal: refusalFor(failure) };
  }

  const identity: GitIdentity = { email, ...(name ? { name } : {}) };
  // SUCCESS ONLY. A failure left in here would outlive the fix by up to a
  // minute, and the person fixing it has no way to tell that they succeeded.
  cache.set(projectRoot, { at: Date.now(), identity });
  return { configured: true, identity };
}
