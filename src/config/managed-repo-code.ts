/**
 * Every path by which code from the project's MAIN CHECKOUT can run, and what
 * managed (Teams) mode does with it.
 *
 * On a managed host the daemon process holds every member's delivered
 * credentials and the control token, and any member can land a file on the
 * project's main branch (accept a task, push over hosted git). So no code from
 * the repository may run IN the daemon process there. Code that runs inside a
 * task container is contained by the container, exactly as an agent's own
 * commands are; code the daemon itself imports is not. And in EVERY mode, code a
 * task branch can influence never runs on the daemon's host at all.
 *
 * This list is the classification, and it is enforced mechanically:
 * `test/unit/managed-repo-code.test.ts` scans `src/` for every dynamic
 * `import()` / `require()` of a computed specifier, and fails unless the file
 * is listed here as an in-process importer (`inProcessImport: true`). A new
 * path has to classify itself before it ships, the way every lazy.toml key has
 * to in `MANAGED_POLICY`.
 */

export type ManagedRepoCodeDisposition =
  /** Never run. */
  | 'not-run'
  /** Runs, but only inside a task container (or a build that is itself gated). */
  | 'contained';
// There is deliberately no "runs on the daemon's host" disposition: code a task
// branch can influence must not run there (engineer, 2026-10-10). A new path
// that cannot be contained is a decision for the engineer, not a
// classification.

export interface RepoCodePath {
  /** What the repository ships. */
  what: string;
  /** The `src/` file that runs or imports it. */
  sourceFile: string;
  managed: ManagedRepoCodeDisposition;
  reason: string;
  /** True when `sourceFile` imports repository code into the running process. */
  inProcessImport?: boolean;
}

export const REPOSITORY_CODE_PATHS: readonly RepoCodePath[] = [
  {
    what: '.lazy/plugins/* (proxy request plugins)',
    sourceFile: 'src/proxy/plugins/loader.ts',
    managed: 'not-run',
    inProcessImport: true,
    reason:
      'Would be imported into the daemon process itself, unsandboxed, on the host. Not loaded in ANY ' +
      'mode until a contained design exists (engineer, 2026-10-10).',
  },
  {
    what: 'Dockerfile.lazy / [docker] dockerfile',
    sourceFile: 'src/capture/claude.ts',
    managed: 'contained',
    reason:
      'Built by docker, never imported; a root Dockerfile.lazy is auto-built only where the project has its own VM (autoBuildsRootDockerfile).',
  },
  {
    what: '[automation] pre_turn / post_turn, [checks] post_turn',
    sourceFile: 'src/supervisor/post-turn-check.ts',
    managed: 'contained',
    reason:
      'Run by the supervisor inside the task container; managed mode pins the runner to a container runtime.',
  },
  {
    what: '[automation.pre_accept] commands',
    sourceFile: 'src/daemon/task-lifecycle.ts',
    managed: 'contained',
    reason: 'Run in their own ephemeral container built from the task\'s image.',
  },
  {
    what: '[serve] start_services_cmd',
    sourceFile: 'src/daemon/serve-run.ts',
    managed: 'contained',
    reason: 'Run by the daemon inside the task\'s own container.',
  },
  {
    what: '[automation] accept_check (and the worktree scripts it resolves)',
    sourceFile: 'src/protection/accept-check.ts',
    managed: 'contained',
    reason:
      'Run in the acceptance-gate container, in every mode; the module has no way to spawn a process itself.',
  },
  {
    what: 'Agent-writable git config in a task worktree (core.hooksPath, core.fsmonitor, core.sshCommand)',
    sourceFile: 'src/git/worktree-pointers.ts',
    managed: 'not-run',
    reason:
      'Every git lazy runs in a task worktree first checks its pointers and refuses on tampering; ' +
      'containers get read-only copies, so a turn cannot redirect git to a config it controls.',
  },
  {
    what: 'Git hooks the root checkout resolves (core.hooksPath into the tracked tree, .husky/, .git/hooks)',
    sourceFile: 'src/utils/git.ts',
    managed: 'not-run',
    reason:
      'Every git command lazy runs through runGit passes -c core.hooksPath=/dev/null (add, commit, merge, ' +
      'ref updates, worktree add, push), so no hook runs; LFS objects are pushed explicitly with git lfs push.',
  },
];

/**
 * True when repository plugins must not be loaded into this process — in every
 * mode (engineer, 2026-10-10: no repository code runs on the host, "accept or
 * no accept"). The one-line flip if solo plugins ever come back.
 */
export function repositoryPluginsDisabled(): boolean {
  return true;
}

/** The one sentence every surface uses to say so. */
export const REPOSITORY_PLUGINS_NOT_RUN =
  'Repository plugins (.lazy/plugins) are not run: lazy never runs code from the repository inside its own process on the host';
