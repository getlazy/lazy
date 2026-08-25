/**
 * git's "dubious ownership" refusal, translated for a lazy user.
 *
 * git refuses a repository whose directory owner differs from the uid running
 * git, and suggests the human run `git config --global --add safe.directory
 * <path>`. For a path LAZY created and manages that advice is wrong twice over:
 *
 *   1. It pushes a workaround for lazy's own misconfiguration onto the user.
 *   2. In the common case the git that refused is running INSIDE the agent
 *      container, against a bind-mounted worktree. A `--global` config change on
 *      the host is not read by that git at all, so following the suggestion
 *      changes nothing and the human is left with no working remedy.
 *
 * Lazy establishes trust for its own paths in the sandbox gitconfig instead
 * (see `setupSandbox` in src/utils/sandbox.ts). This module is what the human
 * sees when that still is not enough — every git command lazy runs goes through
 * `runGit`, so translating here covers the whole blast radius rather than just
 * the merge path where the failure happened to be first observed.
 */

import { isRunningInContainer } from './container';

/**
 * The substring git 2.35.2+ prints when `ensure_valid_ownership` rejects a repo.
 * Matched rather than parsed: git's exact wording around it has changed between
 * versions, but this clause has not.
 */
export const DUBIOUS_OWNERSHIP_MARKER = 'detected dubious ownership in repository at';

/** True when this git stderr is the ownership refusal (and not some other fatal). */
export function isDubiousOwnershipError(stderr: string): boolean {
  return stderr.includes(DUBIOUS_OWNERSHIP_MARKER);
}

/**
 * Lazy's own explanation, appended below git's original message.
 *
 * git's text is never replaced — it names the offending path and is what a
 * human would search for. This adds what lazy knows and git cannot: that lazy
 * owns the directory, and where the trust is actually configured.
 */
export function explainDubiousOwnership(cwd: string | undefined, inContainer: boolean): string {
  const where = cwd ? `\`${cwd}\`` : 'that path';

  if (inContainer) {
    return [
      "lazy: git refused this repository because the directory's owner does not match the",
      'user running git. This git ran inside lazy\'s agent container, so the suggestion above',
      'does NOT apply: a `git config --global` change on your host is not read in here, and',
      'the path belongs to a worktree lazy created and manages — it is not yours to vouch for.',
      '',
      'Lazy marks its own worktree and git dirs as trusted in the container gitconfig it',
      `generates at \`<worktree>/.lazy-task-sandbox/.gitconfig\`. Seeing this means that file did`,
      'not reach the container. Relaunch the task (`lazy stop <task>` then `lazy unblock',
      '<task>`) to regenerate it. If it persists, your container runtime is presenting the',
      `mounted worktree differently than lazy expects — report it with \`lazy doctor\` output.`,
    ].join('\n');
  }

  return [
    "lazy: git refused this repository because the directory's owner does not match the",
    `user running git. ${where} is a worktree lazy created and manages, so do not add a`,
    'global `safe.directory` exception for it — that would hide a real ownership problem',
    'rather than fix it. Check who owns the path (`ls -ld`): it should be the same user',
    'that runs lazy and its daemon.',
  ].join('\n');
}

/**
 * Append lazy's explanation to a git stderr that is the ownership refusal.
 * Returns the stderr unchanged for every other failure.
 */
export async function annotateDubiousOwnership(
  stderr: string,
  cwd: string | undefined,
): Promise<string> {
  if (!isDubiousOwnershipError(stderr)) return stderr;
  return `${stderr}\n\n${explainDubiousOwnership(cwd, await isRunningInContainer())}`;
}
