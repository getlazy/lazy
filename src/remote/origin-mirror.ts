/**
 * Whether the LOCAL driver mirrors task branches to `origin`.
 *
 * A project Lazy Teams runs (managed mode) whose repository is not on GitHub or
 * GitLab — above all one the install hosts itself — gets the `local` driver from
 * `lazy init`, because no forge detector claims its URL. The local driver used
 * to push nothing, so members cloning the team's repository saw `main` and no
 * task branches at all, and commits a member pushed to a task branch never
 * reached sync's step 1.
 *
 * In managed mode the daemon's clone is nobody's personal checkout: its origin
 * IS the team's shared repository, and Teams seeds that clone with push
 * credentials. So there the local driver behaves like a forge driver for TASK
 * BRANCHES — the after-turn push (`src/daemon/push.ts`) and the task-branch
 * fetch sync's step 1 makes — and for the ACCEPT TARGET: once an accept's local
 * merge lands, its follow-through `push-parent` step pushes the target branch
 * (plain push, never force), so a member's `git fetch` sees accepted work on
 * `main` exactly as on a forge (`acceptPushesTargetToMirror`). Merges still
 * land locally and no PR/MR exists.
 *
 * Outside managed mode a local-driver project keeps pushing nothing: a solo
 * user who chose `local` did not ask lazy to write to their remote.
 */

import type { ResolvedConfig } from '../config/types';
import { isManagedMode } from '../config/managed-mode';
import { runGit } from '../utils/git';
import { withRemoteRetry } from '../utils/retry';

export function localDriverMirrorsOrigin(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return config.remote.driver === 'local' && isManagedMode(env);
}

/**
 * Whether an accept's follow-through must push its target branch to the
 * mirrored origin: the driver mirrors origin AND that remote exists (a managed
 * project with no `origin` has nowhere to push, and a step owed there would
 * fail on every retry forever). Decided once, when the follow-through record is
 * written; the push itself is the existing `push-parent` step — never a push
 * before the merge, never a second path.
 */
export async function acceptPushesTargetToMirror(
  driver: { originMirror?: { remoteName: string } | null },
  projectRoot: string,
): Promise<boolean> {
  const mirror = driver.originMirror;
  if (!mirror) return false;
  return (await runGit(['remote', 'get-url', mirror.remoteName], projectRoot)).exitCode === 0;
}

/** True when git refused a push because the remote branch moved (non-fast-forward). */
export function isNonFastForwardRejection(message: string): boolean {
  return /\[rejected\]|non-fast-forward|fetch first/i.test(message);
}

/** Thrown when the mirrored remote's target and the local target have diverged. */
export class MirrorTargetDivergedError extends Error {}

/**
 * Bring local `<target>` up to the mirrored remote's before an accept merges
 * into it — the counterpart of the forge drivers' fast-forward, run in the
 * PRE-merge band so the post-merge push is a fast-forward. Someone may have
 * pushed to the install's `main` directly (e.g. from a `lazy shell --local`
 * checkout).
 *
 * - remote equal to or behind local: nothing to do;
 * - remote strictly ahead: fast-forward local (never a merge);
 * - diverged: throw `MirrorTargetDivergedError` — never merge or overwrite;
 * - fetch failure: retried, then thrown (fail hard on remote failures).
 */
export async function fastForwardTargetFromMirror(
  remoteName: string,
  target: string,
  projectRoot: string,
): Promise<'up-to-date' | 'fast-forwarded'> {
  const remoteRef = `refs/remotes/${remoteName}/${target}`;
  // A target the install does not have yet has nothing to bring in; the
  // post-merge push creates it. ls-remote --exit-code answers 2 for "no such ref".
  const exists = await withRemoteRetry(
    async () => {
      const r = await runGit(['ls-remote', '--exit-code', '--heads', remoteName, `refs/heads/${target}`], projectRoot);
      if (r.exitCode === 0) return true;
      if (r.exitCode === 2) return false;
      throw new Error(`Failed to ask ${remoteName} for ${target}: ${r.stderr.trim() || 'unknown error'}`);
    },
    `look up ${target} on ${remoteName}`,
  );
  if (!exists) return 'up-to-date';
  await withRemoteRetry(
    async () => {
      const r = await runGit(['fetch', remoteName, `+refs/heads/${target}:${remoteRef}`], projectRoot);
      if (r.exitCode !== 0) {
        throw new Error(`Failed to fetch ${target} from ${remoteName}: ${r.stderr.trim() || 'unknown error'}`);
      }
    },
    `fetch ${target} from ${remoteName}`,
  );
  const sha = async (ref: string): Promise<string> => {
    const r = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], projectRoot);
    if (r.exitCode !== 0) throw new Error(`could not resolve ${ref}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  const local = await sha(`refs/heads/${target}`);
  const remote = await sha(remoteRef);
  if (local === remote) return 'up-to-date';
  const isAncestor = async (a: string, b: string): Promise<boolean> => {
    const r = await runGit(['merge-base', '--is-ancestor', a, b], projectRoot);
    if (r.exitCode === 0) return true;
    if (r.exitCode === 1) return false;
    throw new Error(`git merge-base --is-ancestor ${a} ${b} failed: ${r.stderr.trim()}`);
  };
  if (await isAncestor(remote, local)) return 'up-to-date';
  if (!(await isAncestor(local, remote))) {
    const counts = await runGit(['rev-list', '--left-right', '--count', `refs/heads/${target}...${remoteRef}`], projectRoot);
    const [localOnly, remoteOnly] = counts.exitCode === 0 ? counts.stdout.trim().split(/\s+/) : ['?', '?'];
    throw new MirrorTargetDivergedError(
      `${remoteName}/${target} and local ${target} have diverged: local has ${localOnly} commit(s) ${remoteName} lacks ` +
      `(accepted work not yet pushed), and ${remoteName} has ${remoteOnly} commit(s) local lacks (pushed there directly). ` +
      `Lazy never merges or overwrites ${target} on its own, so this accept was refused before merging anything; nothing changed. ` +
      `Every accept into ${target} stays refused until the two are reconciled.`,
    );
  }
  const head = await runGit(['symbolic-ref', '--quiet', 'HEAD'], projectRoot);
  if (head.exitCode === 0 && head.stdout.trim() === `refs/heads/${target}`) {
    const ff = await runGit(['merge', '--ff-only', remote], projectRoot);
    if (ff.exitCode !== 0) {
      throw new Error(`could not fast-forward ${target} to ${remoteName}/${target}: ${ff.stderr.trim() || ff.stdout.trim()}`);
    }
  } else {
    const wt = await runGit(['worktree', 'list', '--porcelain'], projectRoot);
    if (wt.exitCode === 0 && wt.stdout.split('\n').includes(`branch refs/heads/${target}`)) {
      throw new Error(`could not fast-forward ${target} to ${remoteName}/${target}: it is checked out in another worktree`);
    }
    // Compare-and-swap: refuses if local moved since it was read.
    const upd = await runGit(['update-ref', `refs/heads/${target}`, remote, local], projectRoot);
    if (upd.exitCode !== 0) {
      throw new Error(`could not fast-forward ${target} to ${remoteName}/${target}: ${upd.stderr.trim()}`);
    }
  }
  return 'fast-forwarded';
}
