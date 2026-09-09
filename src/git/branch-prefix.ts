/**
 * `[git] default_branch_prefix` — THE ONE PLACE a task branch's namespace comes
 * from. Every `lazy/`-shaped string in the codebase is either built from
 * {@link taskBranchPrefix} or tested with {@link looksLikeTaskBranch}; a `'lazy/'`
 * literal on a branch-naming path is a bug (it is the bug this module exists to
 * fix — the key was documented, defaulted and schema-validated, but no
 * branch-naming code ever read it, so a configured prefix was silently ignored).
 *
 * PROCESS-GLOBAL, INSTALLED BY loadConfig. Branch names are needed from deeply
 * nested SYNCHRONOUS helpers — about twenty direct call sites across the CLI,
 * the daemon, the drivers and the TUI, and threading a config into any of them
 * cascades to THEIR callers in turn (`getBranchName(task)` is itself sync, with
 * a dozen of its own) — none of which has a config in hand or can become async
 * without rewriting all of them. Rather than thread a
 * string through every one, `loadConfig` installs the resolved prefix here on
 * every load — exactly the pattern {@link setDocsBaseUrl} already uses for the
 * other config value read from deep sync code. Before any config load the
 * built-in default applies, which is the historical `lazy` behaviour, so a code
 * path that somehow runs first can only ever see the old value, never garbage.
 *
 * ALWAYS FROM THE PROJECT ROOT'S lazy.toml. `loadConfig` resolves most settings
 * from the nearest lazy.toml walking up from its `cwd`, and the daemon uses that
 * on purpose — several call sites load a task's config with `cwd` set to the
 * task worktree. lazy.toml is tracked in git, so every task worktree carries a
 * copy on an agent-writable branch. Installing THIS value from the file a
 * particular call happened to resolve would let one task's committed lazy.toml
 * re-point branch naming for every other task in the same long-lived daemon,
 * and re-point {@link looksLikeTaskBranch}, which decides whether `lazy accept`
 * merges locally or through the forge. A per-worktree branch namespace is
 * incoherent anyway: all worktrees share one git directory, so a project has
 * exactly one task-branch namespace. See `projectBranchPrefix` in
 * src/config/loader.ts.
 *
 * CHANGING THE PREFIX ON AN EXISTING PROJECT RENAMES NOTHING. Branches already
 * created keep their names, and a task's real branch is recorded on its session
 * (`session.git_branch`) — that stored value always wins where it is available.
 * The prefix decides the name of branches created from now on, and how
 * {@link looksLikeTaskBranch} classifies a branch for protection and target
 * resolution.
 * Switching mid-project therefore orphans in-flight tasks whose parent branch
 * is re-derived rather than read from a session; do it between releases.
 */

/** The built-in prefix, used until (and unless) a config load installs another. */
export const DEFAULT_BRANCH_PREFIX = 'lazy';

let branchPrefix = DEFAULT_BRANCH_PREFIX;

/**
 * Trim and drop any trailing slashes the user wrote — `"wip/"` and `"wip"` name
 * the same namespace, and the slash is added back by {@link taskBranchPrefix}.
 */
function cleanBranchPrefix(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

/**
 * Why a configured prefix is unusable, or null when it is fine.
 *
 * The prefix becomes the leading path segment(s) of a real git branch name, so
 * it has to survive `git check-ref-format`. It is checked HERE, at the config
 * boundary, so a bad value is a load-time error naming the file and the key —
 * not a `git branch` failure halfway through starting a task, by which point
 * the worktree exists and the task is half-created. Deliberately conservative:
 * it rejects a few names git would technically accept and never accepts one git
 * would reject.
 *
 * An EMPTY value is not an error: throughout lazy.toml an empty string means
 * "unset, use the default" (`[storage] external_path`, `[docker] dockerfile`,
 * `[docs] url`), so a user writing `default_branch_prefix = ""` gets the
 * built-in `lazy` — not a daemon that refuses to start. It is the one value
 * {@link normalizeBranchPrefix} can substitute for without guessing, because
 * there is nothing to guess AT: a branch cannot live in an empty namespace, so
 * "" cannot have been meant literally.
 *
 * Not checked, because it cannot be: whether the prefix shadows a namespace the
 * project already uses for real integration branches. Every branch under the
 * prefix is treated as a lazy task branch — see {@link looksLikeTaskBranch} —
 * so a project with protected `release/*` branches must not set the prefix to
 * `release`. That is documented with the setting.
 */
export function branchPrefixError(raw: string | null | undefined): string | null {
  const cleaned = cleanBranchPrefix(raw);
  if (cleaned === '') return null;
  if (cleaned.startsWith('/')) return 'must not start with "/"';
  // Control characters, space, and the characters git forbids in a ref name.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(cleaned)) {
    return 'must not contain whitespace or any of: ~ ^ : ? * [ \\';
  }
  if (cleaned.includes('//')) return 'must not contain an empty path segment ("//")';
  if (cleaned.includes('..')) return 'must not contain ".."';
  if (cleaned.includes('@{')) return 'must not contain "@{"';
  if (cleaned.endsWith('.')) return 'must not end with "."';
  for (const segment of cleaned.split('/')) {
    if (segment.startsWith('.')) return 'no path segment may start with "."';
    if (segment.endsWith('.lock')) return 'no path segment may end with ".lock"';
  }
  return null;
}

/**
 * Normalize a configured prefix for installation. Total by construction — an
 * empty value falls back to the default rather than throwing, because this runs
 * on every install and the loud rejection belongs at the config boundary
 * ({@link branchPrefixError}, called by `loadConfig`).
 */
export function normalizeBranchPrefix(raw: string | null | undefined): string {
  const cleaned = cleanBranchPrefix(raw);
  return cleaned === '' ? DEFAULT_BRANCH_PREFIX : cleaned;
}

/**
 * Install the task-branch prefix for this process. Called by `loadConfig` on
 * every load. Idempotent — the last install wins.
 */
export function setBranchPrefix(prefix: string | null | undefined): void {
  branchPrefix = normalizeBranchPrefix(prefix);
}

/** Restore the built-in default. For tests and for daemon re-init. */
export function resetBranchPrefix(): void {
  branchPrefix = DEFAULT_BRANCH_PREFIX;
}

/** The installed prefix, without a trailing slash (`"lazy"`). */
export function getBranchPrefix(): string {
  return branchPrefix;
}

/** The installed prefix as a branch-name prefix, with its slash (`"lazy/"`). */
export function taskBranchPrefix(): string {
  return `${branchPrefix}/`;
}

/** The task branch name for a task ref (`"lazy/my-task"`). */
export function taskBranchFor(ref: string): string {
  return `${taskBranchPrefix()}${ref}`;
}

/**
 * Whether a branch name is a lazy task branch rather than a real integration
 * branch — in the configured namespace OR the built-in `lazy/` one.
 *
 * THE ONLY classification predicate, deliberately. Every caller is asking the
 * same question ("is this NOT a real integration branch?"): accept's
 * local-vs-forge routing, the PR/MR refusal guards, `lazy submit`'s refusal,
 * `branchTarget` validation, stale-sentinel healing, doctor's task-branch
 * listing. A narrower "configured prefix only" twin was tried and deleted — it
 * had no caller that wanted it, and its only effect would have been to let a
 * future call site pick the wrong one.
 *
 * Both namespaces are accepted because a project that switched `[git]
 * default_branch_prefix` still has `lazy/...` branches and stored refs from
 * before the switch. Misclassifying one of those as an integration branch is
 * the dangerous direction: it would route a merge through the forge, offer a
 * task branch as a protection target, or use a stale ref as a merge target.
 * Accepting both is a strict superset of the old `startsWith('lazy/')`
 * behaviour, so no project that worked before changes.
 */
export function looksLikeTaskBranch(branch: string): boolean {
  return branch.startsWith(taskBranchPrefix()) || branch.startsWith(`${DEFAULT_BRANCH_PREFIX}/`);
}

/**
 * The task ref inside a task branch name — the inverse of {@link taskBranchFor}.
 *
 * Strips the configured prefix, or the built-in `lazy/` one for a branch created
 * before the prefix was changed, and returns the name unchanged when it carries
 * neither (callers use the result as a worktree directory name, where a
 * pass-through is the same behaviour the old `.replace('lazy/', '')` had).
 */
export function taskRefFromBranch(branch: string): string {
  const configured = taskBranchPrefix();
  if (branch.startsWith(configured)) return branch.slice(configured.length);
  const builtin = `${DEFAULT_BRANCH_PREFIX}/`;
  if (branch.startsWith(builtin)) return branch.slice(builtin.length);
  return branch;
}
