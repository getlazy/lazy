/**
 * Discovery for branch protection.
 *
 * Protection is opt-in (see src/protection/edge-gate.ts). Opt-in features are
 * invisible features, and the first version of this one shipped ON by default
 * precisely to avoid that — which turned a new user's first `lazy accept` into
 * a refusal about a gate they had never heard of. Zero surprise won; discovery
 * is bought back here instead, with a single line printed after an accept has
 * ALREADY succeeded, where it costs nothing and blocks nothing.
 *
 * When the hint is shown:
 *   - the accept merged into the repo's DEFAULT branch (the thing worth
 *     gating — a `lazy/*` parent branch is not);
 *   - protection is off (nothing to advertise when it is already on);
 *   - the human has never expressed an opinion: `[protection] enabled` is
 *     absent from lazy.toml. An explicit `enabled = false` means they know
 *     the feature and said no — never nag them.
 *
 * Frequency is deliberately "every qualifying accept": one short line the user
 * can act on or ignore, with no per-session state to keep. If it turns out to
 * be too chatty, the natural dial is here.
 */

import type { ResolvedConfig } from '../config';
import { runGit } from '../utils/git';

/**
 * Resolve the repo default branch WITHOUT the "could not resolve" warning
 * `getRemoteDefaultBranch` logs, and without its literal-`main` fallback.
 *
 * That warning is right for the accept/gate path (a gate believed armed but
 * pointing at the wrong branch is dangerous) and wrong here: a project with no
 * remote HEAD would get a scary line every accept in service of an optional
 * tip. No answer simply means no hint.
 */
async function resolveDefaultBranchQuietly(
  projectRoot: string,
  remoteName: string,
): Promise<string | null> {
  const remoteHead = await runGit(['symbolic-ref', `refs/remotes/${remoteName}/HEAD`], { cwd: projectRoot });
  if (remoteHead.exitCode === 0) {
    const prefix = `refs/remotes/${remoteName}/`;
    const ref = remoteHead.stdout.trim();
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }

  // No remote HEAD: a `local`-driver project, or a repo where nobody ran
  // `git remote set-head`. Fall back to the branch the main checkout is on,
  // which is the integration branch in every normal lazy layout (task work
  // happens in worktrees). Unlike the gate, being wrong here costs nothing:
  // the tip suggests `lazy protect <branch> on`, which writes an explicit
  // entry and does not depend on default-branch resolution at all. Worst case
  // is a missed tip, never a false claim about what is protected.
  const localHead = await runGit(['symbolic-ref', '--short', 'HEAD'], { cwd: projectRoot });
  if (localHead.exitCode !== 0) return null;
  return localHead.stdout.trim() || null;
}

/**
 * The one-line hint to print after a successful accept, or null when this
 * accept does not qualify.
 *
 * `rawConfig` is the parsed lazy.toml as the human wrote it (from
 * `loadRawConfig`) — the resolved config cannot distinguish "never mentioned
 * protection" from "explicitly opted out", and that distinction is the whole
 * suppression rule.
 */
export async function protectionHintForAccept(opts: {
  config: ResolvedConfig;
  rawConfig: Record<string, unknown> | null;
  projectRoot: string;
  /** Branch the task was merged INTO. */
  targetBranch: string | undefined;
}): Promise<string | null> {
  const { config, rawConfig, projectRoot, targetBranch } = opts;

  // Already protecting something — there is nothing to introduce.
  if (config.protection.enabled) return null;

  // An explicit opinion, either way, ends the conversation.
  const section = rawConfig?.protection as Record<string, unknown> | undefined;
  if (section && 'enabled' in section) return null;

  if (!targetBranch) return null;

  // Task branches are never the repo default branch — skip the git call, the
  // same shortcut resolveEdgeGateDecision takes.
  if (targetBranch.startsWith(`${config.git.default_branch_prefix}/`)) return null;

  const defaultBranch = await resolveDefaultBranchQuietly(projectRoot, config.remote.git_remote);
  if (!defaultBranch || defaultBranch !== targetBranch) return null;

  return (
    `Tip: gate future accepts into \`${targetBranch}\` behind a human approval — ` +
    `lazy protect ${targetBranch} on`
  );
}
