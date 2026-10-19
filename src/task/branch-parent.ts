/**
 * Is `name` a branch a task may be pointed at — the check `createTask` and
 * `reparentTask` share when a `parent` is not a task?
 *
 * A branch that exists in the project root is accepted as it always was. In
 * managed mode (a Lazy Teams project) the daemon's clone is nobody's checkout:
 * its origin IS the team's shared repository, and a member's branch arrives
 * there by `git push` from their own clone. Such a branch is on origin and NOT
 * yet a local branch of the daemon's clone, so a plain `rev-parse` refused it
 * on both surfaces — the browser's "Move under another task" and a bound
 * clone's `lazy create --parent`. There, a branch missing locally is looked up
 * on origin and, when it exists, fetched into a local branch of the same name:
 * the ref the task's base is cut from and its accept merges into
 * (`resolveUpstreamMergeRef`, which reads the local branch for the local driver).
 *
 * Outside managed mode nothing is fetched: a solo user's repository is theirs,
 * and creating a local branch there is a side effect they did not ask for.
 */

import { loadConfig } from '../config/loader';
import { isManagedMode } from '../config/managed-mode';
import { DEFAULT_BRANCH_PREFIX, getBranchPrefix } from '../git/branch-prefix';
import { runGit } from '../utils/git';
import { withRemoteRetry } from '../utils/retry';

export type BranchParentResolution =
  | { ok: true; fetched: boolean }
  | { ok: false; reason: 'not-found' | 'task-branch' | 'invalid-name' | 'case-collision' };

export async function resolveBranchParent(
  projectRoot: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BranchParentResolution> {
  if (name.startsWith('-')) return { ok: false, reason: 'invalid-name' };
  // A BRANCH, not any revision: `HEAD`, a SHA, `main~3` or a tag would resolve
  // as a revision and then be stored as a branch target nothing can integrate
  // into. `check-ref-format --branch` refuses the expressions; the lookup is
  // under refs/heads/ only.
  const format = await runGit(['check-ref-format', '--branch', name], { cwd: projectRoot });
  if (format.exitCode !== 0 || format.stdout.trim() !== name) return { ok: false, reason: 'invalid-name' };
  if (isTaskBranchNamespace(name)) return { ok: false, reason: 'task-branch' };
  // The branch must exist under EXACTLY this name. Asked of the ref listing,
  // never by resolving the name: a case-insensitive filesystem (the daemon
  // clone on a macOS host) folds letter case in every PATH PART of a loose ref,
  // folders included. So `refs/heads/Main` resolves to a loose `main` (an
  // alias), fetching `Main` over a packed `main` writes a file git then reads
  // AS `main` (moving it), `MAIN/x` makes a folder that blocks every later
  // update of `main`, and `Release/2.0` lands in `release/` and later stops
  // resolving under the name stored. Any case-only disagreement with an
  // existing branch is refused, on every filesystem, before anything is fetched.
  const heads = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads/'], { cwd: projectRoot });
  if (heads.exitCode !== 0) {
    throw new Error(`git for-each-ref refs/heads/ failed in ${projectRoot}: ${heads.stderr.trim() || `exit ${heads.exitCode}`}`);
  }
  const wanted = `refs/heads/${name}`;
  const existing = heads.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (existing.includes(wanted)) return { ok: true, fetched: false };
  if (existing.some((ref) => differsOnlyByCase(ref.slice('refs/heads/'.length), name))) {
    return { ok: false, reason: 'case-collision' };
  }
  if (!isManagedMode(env)) return { ok: false, reason: 'not-found' };

  const remote = (await loadConfig(projectRoot)).remote.git_remote;
  if ((await runGit(['remote', 'get-url', remote], { cwd: projectRoot })).exitCode !== 0) {
    return { ok: false, reason: 'not-found' };
  }
  // `--exit-code` answers 2 for "no such ref" — a definite no, never retried.
  // Anything else non-zero is the remote failing to answer, which is retried
  // and then thrown: "the branch does not exist" must never be said of a
  // remote that could not be asked.
  const listed = await withRemoteRetry(async () => {
    const r = await runGit(['ls-remote', '--exit-code', remote, `refs/heads/${name}`], { cwd: projectRoot });
    if (r.exitCode !== 0 && r.exitCode !== 2) {
      throw new Error(`git ls-remote ${remote} refs/heads/${name} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    }
    return r.exitCode === 0;
  }, `look up branch ${name} on ${remote}`);
  if (!listed) return { ok: false, reason: 'not-found' };

  // `--refmap=` (empty) makes the explicit refspec the ONLY ref this fetch
  // writes. Without it git also force-updates `refs/remotes/<remote>/<name>`
  // through the configured `+refs/heads/*:refs/remotes/<remote>/*` mapping, and
  // the letter-case guard above checks `refs/heads/` only. On a
  // case-insensitive clone a pushed `Release/1.0` would move
  // `<remote>/release/1.0` (which `resolveUpstreamMergeRef` prefers), and
  // `Release/1.0/x` would leave a folder blocking every later update of it.
  // What keeps this fetch off an existing branch is the checks above, not the
  // refspec: a non-forced refspec still FAST-FORWARDS an existing branch. The
  // exact-name `for-each-ref` check returns before fetching when the branch
  // exists, and the case-collision refusal stops every name a case-insensitive
  // filesystem would store as an existing branch or its folder.
  await withRemoteRetry(async () => {
    const r = await runGit(
      ['fetch', '--quiet', '--no-tags', '--refmap=', remote, `refs/heads/${name}:refs/heads/${name}`],
      { cwd: projectRoot },
    );
    if (r.exitCode !== 0) {
      throw new Error(`git fetch ${remote} ${name} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    }
  }, `fetch branch ${name} from ${remote}`);
  return { ok: true, fetched: true };
}

/**
 * Does `name` touch the task-branch namespace — the configured prefix or the
 * built-in `lazy`? It does when the two, split into path parts and compared
 * ignoring letter case, are part-prefixes of each other EITHER WAY ROUND:
 * - inside it (`LAZY/x`, which a case-insensitive filesystem stores among the
 *   task branches);
 * - the prefix itself (`lazy`, a branch that would block the folder every
 *   task branch lives in);
 * - an ANCESTOR folder of a multi-part prefix (`team` for `team/lazy`, which
 *   makes every later `team/lazy/<x>` fail with "refs/heads/team exists").
 * A sibling (`team/other`) shares only a folder and is fine.
 */
function isTaskBranchNamespace(name: string): boolean {
  const parts = name.toLowerCase().split('/');
  return [getBranchPrefix(), DEFAULT_BRANCH_PREFIX].some((prefix) => {
    const prefixParts = prefix.toLowerCase().split('/');
    const shared = Math.min(parts.length, prefixParts.length);
    return parts.slice(0, shared).every((part, i) => part === prefixParts[i]);
  });
}

/**
 * Do two branch names share a leading run of path parts that are equal
 * ignoring case but not exactly? That is every way a case-insensitive
 * filesystem can confuse them: the same branch (`Main`/`main`), a folder and a
 * branch (`MAIN/x`/`main`), or two folders (`Release/2.0`/`release/1.0`).
 */
export function differsOnlyByCase(a: string, b: string): boolean {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i]!.toLowerCase() !== right[i]!.toLowerCase()) return false;
    if (left[i] !== right[i]) return true;
  }
  return false;
}
