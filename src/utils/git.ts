/**
 * Shared git utilities for repository operations.
 */

import { existsSync } from 'node:fs';
import { logger } from './logger';
import { spawn } from './spawn';
import { annotateDubiousOwnership } from './git-ownership';
import { refuseTamperedWorktreeGit, taskWorktreeOf } from '../git/worktree-pointers';
import { resolveGitAuthorForArgs } from '../identity/git-author';
import { isManagedMode } from '../config/managed-mode';
import { deliveredExcludeFileFor, withDeliveredFilesGitConfig } from '../git/delivered-files-exclude';

/**
 * Config every git lazy runs in a task worktree carries, as `GIT_CONFIG_*`
 * env — command-scope, so it outranks any repository config and a child git
 * inherits it. A task can plant a nested repository and stage it as a gitlink;
 * git then asks it whether it is dirty by running `git status` INSIDE it, under
 * that repository's config (core.fsmonitor, filter drivers). `dirty` stops
 * that question for status, diff and commit, and `core.fsmonitor=false` stops
 * the hook even where git still asks (`git add` does — lazy_commit refuses to
 * stage while a nested repository is present, see ../git/nested-git.ts).
 */
export const TASK_WORKTREE_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['diff.ignoreSubmodules', 'dirty'],
  ['core.fsmonitor', 'false'],
];

/** `GIT_CONFIG_*` env carrying {@link TASK_WORKTREE_GIT_CONFIG}, appended after any the caller already set. */
export function taskWorktreeGitEnv(base: Record<string, string | undefined>): Record<string, string> {
  const n = Number.parseInt(base.GIT_CONFIG_COUNT ?? '0', 10);
  const start = Number.isFinite(n) && n > 0 ? n : 0;
  const env: Record<string, string> = {};
  TASK_WORKTREE_GIT_CONFIG.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = k;
    env[`GIT_CONFIG_VALUE_${start + i}`] = v;
  });
  env.GIT_CONFIG_COUNT = String(start + TASK_WORKTREE_GIT_CONFIG.length);
  return env;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Raw stdout, set only when the caller asked for `binaryStdout`. */
  stdoutBytes?: Uint8Array;
}

export interface RunGitOptions {
  cwd?: string;
  stdout?: 'pipe' | 'ignore';
  stderr?: 'pipe' | 'ignore';
  stdin?: Uint8Array;
  timeout?: number;
  /**
   * Extra environment for this invocation, MERGED over the current process
   * env (Bun's `env` option replaces it wholesale, which would strip PATH,
   * HOME and the git config discovery vars).
   *
   * Exists for the handful of git behaviours that have no command-line form —
   * `GIT_INDEX_FILE` in particular, which is how `src/git/lfs.ts` reads
   * attributes at an arbitrary ref on git versions predating
   * `check-attr --source`.
   */
  env?: Record<string, string>;
  /**
   * Called with each stderr chunk AS IT ARRIVES (the full text is still
   * returned in `stderr`). For long commands whose progress lines are the only
   * sign of life — a checkout running LFS filters can take minutes.
   */
  onStderr?: (chunk: string) => void;
  /**
   * Return stdout VERBATIM, with no `.trim()`. Default is to trim, because
   * almost every caller wants one value off a command that prints a trailing
   * newline.
   *
   * Set it when the output is a PATCH, or anything else whose whitespace is
   * content. `git diff` writes an empty context line as a single space, so a
   * section ending on a blank line ends `" \n"` — and trimming takes both the
   * space and the newline, leaving a hunk body one line shorter than its `@@`
   * header promises. `git apply` answers `corrupt patch at line N` and rejects
   * the ENTIRE patch, not just that file, so one blank line at the wrong place
   * costs every other file's edits too. It cannot be repaired afterwards
   * either: the capture concatenates sections, so a blank line lost at the end
   * of the staged section is gone in the middle of the patch, where no
   * end-of-string fixup can reach it.
   */
  trim?: boolean;
  /**
   * Also return stdout as raw bytes (`stdoutBytes`), undecoded — for a blob
   * that is not text, such as an image. `stdout` is then empty.
   */
  binaryStdout?: boolean;
}

/**
 * Lazy's own git never runs repository hooks — ANY hook, for ANY command.
 * A root checkout whose `core.hooksPath` points into the tracked tree (husky's
 * `.husky/`, a `githooks/` dir) would otherwise run hooks a TASK BRANCH wrote,
 * on the host: pre-commit/post-merge on accept's squash, post-index-change on
 * `git add`, reference-transaction on every ref update, post-checkout on
 * `worktree add`, pre-push on accept's parent push. `-c core.hooksPath=/dev/null`
 * names no directory, so git finds no hook at all, whatever the config or
 * `.git/hooks` say. git-lfs uploads objects from its pre-push hook, so a push
 * in a repository with LFS configured runs `git lfs push` explicitly first
 * (see runGit). Exported for its test.
 */
export function withHooksDisabled(args: string[]): string[] {
  return ['-c', 'core.hooksPath=/dev/null', ...args];
}

/** The subcommand of a git argv (skipping leading `-c k=v` / `-C dir` pairs and flags). */
function gitSubcommand(args: string[]): { sub: string; index: number } | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-C') { i++; continue; }
    if (args[i]!.startsWith('-')) continue;
    return { sub: args[i]!, index: i };
  }
  return null;
}

/**
 * With hooks disabled, LFS's pre-push upload no longer runs: push the LFS
 * objects for the same remote and refs explicitly — only when a pushed ref
 * actually tracks files with LFS (a `filter=lfs` line in a `.gitattributes`
 * at that ref; `git lfs install` commonly sets the filter config globally, so
 * the config alone says nothing about this repository). The caller's leading
 * `-C dir` / `-c k=v` pairs are carried to both probes, so they run in the
 * repository the push runs in. Returns a failure to report, or null to go on.
 */
async function lfsPushBeforePush(args: string[], options: RunGitOptions): Promise<GitResult | null> {
  const parsed = gitSubcommand(args);
  if (!parsed || parsed.sub !== 'push') return null;
  const prefix = args.slice(0, parsed.index);
  const positional = args.slice(parsed.index + 1).filter(a => !a.startsWith('-'));
  const [remote, ...refspecs] = positional;
  if (!remote || refspecs.length === 0) return null;
  // `git lfs push` takes source refs, not `src:dst` refspecs; a deletion
  // (`:dst`) pushes no objects.
  const refs = refspecs.map(r => r.replace(/^\+/, '').split(':')[0]!).filter(Boolean);
  if (refs.length === 0) return null;
  const probeOpts = { cwd: options.cwd, env: options.env, timeout: options.timeout };
  let usesLfs = false;
  for (const ref of refs) {
    const grep = await runGit([...prefix, 'grep', '-l', '--fixed-strings', 'filter=lfs', ref, '--', '*.gitattributes'], probeOpts);
    if (grep.exitCode === 0 && grep.stdout.trim()) { usesLfs = true; break; }
  }
  if (!usesLfs) return null;
  const pushed = await runGit([...prefix, 'lfs', 'push', remote, ...refs], probeOpts);
  return pushed.exitCode === 0 ? null : { ...pushed, stderr: `git lfs push failed before pushing: ${pushed.stderr}` };
}

/** Read a stderr stream to the end, handing each chunk to `onChunk` as it arrives. */
async function streamStderr(stream: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const bytes of stream as unknown as AsyncIterable<Uint8Array>) {
    const chunk = decoder.decode(bytes, { stream: true });
    text += chunk;
    try {
      onChunk(chunk);
    } catch (err) {
      // A progress observer must never fail the git command it is watching.
      logger.warn(`runGit: stderr observer threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return text + decoder.decode();
}

/**
 * Kill-timer setting for git commands that write a working tree: NONE.
 * spawn()'s default 60s backstop killed checkouts and merges still running
 * Git LFS smudge filters on large repositories, leaving a task's checkout
 * half-updated mid-sync or mid-accept. Such a command is bounded by the
 * repository's size and git-lfs's own transfer timeouts, not by a guess here.
 * A caller that passes an explicit `timeout` still gets it.
 */
export const CHECKOUT_TIMEOUT = 0;

/** Subcommands that check files out into a working tree (and so can run LFS smudging). */
const WORKTREE_WRITING_SUBCOMMANDS = new Set([
  'checkout', 'switch', 'restore', 'merge', 'pull', 'reset', 'read-tree', 'stash',
  'cherry-pick', 'revert', 'rebase', 'am', 'worktree',
]);

/** Global options before the subcommand that consume the following argument. */
const GIT_GLOBAL_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/**
 * True when `args` runs a git subcommand that may write a working tree.
 * `worktree` counts only for `add` (its other actions never check out).
 */
export function writesWorkingTree(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    i += GIT_GLOBAL_OPTS_WITH_VALUE.has(args[i]) ? 2 : 1;
  }
  const sub = args[i];
  if (!sub || !WORKTREE_WRITING_SUBCOMMANDS.has(sub)) return false;
  if (sub === 'worktree') return args[i + 1] === 'add';
  return true;
}

/**
 * Execute a git command asynchronously and return the result.
 * All git operations should use this to avoid blocking the event loop.
 * Can be overridden for testing via dependency injection.
 */
export async function runGit(args: string[], opts?: RunGitOptions | string): Promise<GitResult> {
  // Support legacy signature: runGit(args, cwd)
  const options: RunGitOptions = typeof opts === 'string' ? { cwd: opts } : (opts ?? {});

  const stdoutMode = options.stdout ?? 'pipe';
  const stderrMode = options.stderr ?? 'pipe';

  if (options.cwd && !existsSync(options.cwd)) {
    logger.warn(`runGit: working directory '${options.cwd}' does not exist, args: ${args.join(' ')}`);
    return {
      stdout: '',
      stderr: `git: working directory '${options.cwd}' does not exist`,
      exitCode: 1,
    };
  }

  // Second line of the git-pointer boundary (../git/worktree-pointers.ts): in
  // a lazy task worktree, never run git until its three pointer files are
  // what lazy created — a task that redirected them would have THIS git (the
  // daemon's commit, sync, accept) execute its code. Three small reads.
  if (options.cwd) {
    const refusal = await refuseTamperedWorktreeGit(options.cwd);
    if (refusal) {
      logger.error(refusal);
      return { stdout: '', stderr: refusal, exitCode: 128 };
    }
  }
  const spawnOpts: Record<string, unknown> = {
    stdout: stdoutMode,
    stderr: stderrMode,
  };
  if (options.cwd) spawnOpts.cwd = options.cwd;
  if (options.stdin) spawnOpts.stdin = options.stdin;
  if (options.env) spawnOpts.env = { ...process.env, ...options.env };
  const worktree = options.cwd ? taskWorktreeOf(options.cwd) : null;
  if (worktree) {
    const base = (spawnOpts.env as Record<string, string | undefined> | undefined) ?? process.env;
    let env: Record<string, string | undefined> = { ...base, ...taskWorktreeGitEnv(base) };
    // A task with delivered secret files (src/daemon/task-files.ts): point
    // core.excludesFile at its own exclude list, so lazy's `git add -A` (and
    // every status/dirty check) treats them as ignored. See
    // src/git/delivered-files-exclude.ts for why this is env, not a file.
    const excludeFile = await deliveredExcludeFileFor(worktree.worktreePath);
    if (excludeFile) {
      const { set, unset } = withDeliveredFilesGitConfig(env, excludeFile);
      env = { ...env, ...set };
      for (const key of unset) delete env[key];
    }
    spawnOpts.env = env;
  }
  if (options.timeout !== undefined) spawnOpts.timeout = options.timeout;
  else if (writesWorkingTree(args)) spawnOpts.timeout = CHECKOUT_TIMEOUT;

  // A commit the daemon makes names its author explicitly — never git's
  // auto-detect, which on a managed host has no config and refuses
  // (../identity/git-author.ts). Only commit-creating calls resolve anything,
  // and a caller that set the author env itself keeps it. On a laptop so does
  // a daemon whose own environment exports one (a per-project identity); on a
  // managed host a process-wide value would name one account for every
  // member, so it is overridden there.
  const ambientAuthor = !isManagedMode() && !!process.env.GIT_AUTHOR_EMAIL;
  if (!options.env?.GIT_AUTHOR_EMAIL && !ambientAuthor) {
    const authorship = await resolveGitAuthorForArgs(args);
    if (authorship && 'refusal' in authorship) {
      logger.error(authorship.refusal);
      return { stdout: '', stderr: authorship.refusal, exitCode: 128 };
    }
    if (authorship) {
      const base = (spawnOpts.env as Record<string, string | undefined> | undefined) ?? process.env;
      spawnOpts.env = { ...base, ...authorship.env };
    }
  }

  const lfsFailure = await lfsPushBeforePush(args, options);
  if (lfsFailure) return lfsFailure;

  try {
    const proc = spawn(['git', ...withHooksDisabled(args)], spawnOpts) as any;
    const stderrText = stderrMode === 'pipe' && options.onStderr
      ? streamStderr(proc.stderr, options.onStderr)
      : null;
    const result = await proc.exited;
    const stdoutBytes = stdoutMode === 'pipe' && options.binaryStdout
      ? new Uint8Array(await Bun.readableStreamToArrayBuffer(proc.stdout))
      : undefined;
    const rawStdout = stdoutMode === 'pipe' && !options.binaryStdout ? await Bun.readableStreamToText(proc.stdout) : '';
    // Trimmed unless the caller says its output is content (see `trim` above).
    // stderr is always trimmed: it is a message, never a payload.
    const stdout = options.trim === false ? rawStdout : rawStdout.trim();
    let stderr = '';
    if (stderrMode === 'pipe') {
      stderr = (stderrText ? await stderrText : await Bun.readableStreamToText(proc.stderr)).trim();
    }
    const exitCode = proc.exitCode ?? result;

    // git's "dubious ownership" refusal tells the human to add a global
    // safe.directory exception. For a lazy-managed worktree that advice is wrong
    // — and useless when this git is running in the agent container, where a
    // host-side git config is never read. Annotate here, the one chokepoint every
    // git command lazy runs passes through, so the whole blast radius is covered
    // rather than just the merge path where it was first observed.
    if (exitCode !== 0 && stderr) {
      stderr = await annotateDubiousOwnership(stderr, options.cwd);
    }

    return stdoutBytes ? { stdout, stderr, exitCode, stdoutBytes } : { stdout, stderr, exitCode };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`runGit: git command failed with exception: ${message}, args: ${args.join(' ')}`);
    return {
      stdout: '',
      stderr: `git: command failed (${message})`,
      exitCode: 1,
    };
  }
}

/**
 * Finds the worktree path where the given branch is checked out.
 * Returns null if the branch is not checked out in any worktree.
 */
export async function findWorktreeForBranch(
  branch: string,
  root: string,
  git: (args: string[], cwd?: string) => Promise<GitResult> = runGit,
): Promise<string | null> {
  const listResult = await git(['worktree', 'list', '--porcelain'], root);
  if (listResult.exitCode !== 0) {
    return null;
  }

  // Parse worktree list output
  // Format:
  // worktree /path/to/worktree
  // HEAD <sha>
  // branch refs/heads/branchname
  // ...
  const lines = listResult.stdout.split('\n');
  let currentWorktreePath: string | null = null;
  const found: string[] = [];

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      currentWorktreePath = line.substring('worktree '.length);
    } else if (line.startsWith('branch ')) {
      const branchRef = line.substring('branch '.length);
      if (branchRef === `refs/heads/${branch}` && currentWorktreePath) found.push(currentWorktreePath);
    } else if (line === '') {
      // Empty line marks end of worktree entry
      currentWorktreePath = null;
    }
  }

  // Two worktrees on one branch is a redirected task HEAD, never git's doing
  // (see assertSingleWorktreeForBranch in src/git/operations.ts).
  if (found.length > 1) {
    throw new Error(
      `Refusing to act on ${branch}: ${found.length} worktrees have HEAD on it (${found.join(', ')}). ` +
      `A task pointed its HEAD at a branch it does not own; see \`lazy doctor\`.`,
    );
  }
  return found[0] ?? null;
}

/**
 * Attempts to fast-forward a branch checked out in a worktree.
 * Returns { success: true } if the merge succeeds or if it's already up to date.
 * Returns { success: true, warning } if the merge fails (non-blocking — remote merge succeeded).
 */
export async function tryFastForwardInWorktree(
  targetBranch: string,
  worktreePath: string,
  remoteRef: string,
  remoteName: string,
  root: string,
  git: (args: string[], cwd?: string) => Promise<GitResult> = runGit,
): Promise<{ success: boolean; warning?: string }> {
  logger.debug(`fastForwardLocal: ${targetBranch} is checked out at ${worktreePath}, attempting ff-only merge`);

  // First fetch in the worktree to ensure we have the latest remote ref
  const fetchResult = await git(['fetch', remoteName, targetBranch], worktreePath);
  if (fetchResult.exitCode !== 0) {
    // INVARIANT: Fetch failure is a real failure — no silent fallback to success.
    // The caller must handle this (retry, inform user, etc.).
    const warning = `Branch ${targetBranch} is checked out in worktree at ${worktreePath}, but fetch failed: ${fetchResult.stderr.trim() || 'unknown error'}. Run \`git -C ${worktreePath} fetch && git -C ${worktreePath} pull\` to update manually.`;
    logger.warn(`fastForwardLocal: ${warning}`);
    return { success: false, warning };
  }

  const mergeResult = await git(['merge', '--ff-only', remoteRef], worktreePath);
  if (mergeResult.exitCode === 0) {
    logger.debug(`fastForwardLocal: ${targetBranch} fast-forwarded in worktree at ${worktreePath}`);
    return { success: true };
  }

  // Check if already up to date
  const stderr = mergeResult.stderr;
  if (stderr.includes('Already up to date') || mergeResult.stdout.includes('Already up to date')) {
    logger.debug(`fastForwardLocal: ${targetBranch} already up to date in worktree`);
    return { success: true };
  }

  // INVARIANT: A failed merge is a failure — never return success:true with a warning
  // to paper over it. The caller decides how to handle (retry, inform user, etc.).
  const warning = `Branch ${targetBranch} is checked out in worktree at ${worktreePath} and could not be fast-forwarded: ${mergeResult.stderr.trim() || 'unknown error'}. Run \`git -C ${worktreePath} pull\` to update manually.`;
  logger.warn(`fastForwardLocal: ${warning}`);
  return { success: false, warning };
}

/**
 * Fast-forward a local branch to match its remote counterpart.
 * Handles cases where the branch is checked out in the current repo or in a worktree.
 */
export async function fastForwardLocal(
  targetBranch: string,
  remoteName: string,
  root: string,
  git: (args: string[], cwd?: string) => Promise<GitResult> = runGit,
  shouldSkipWorktree?: (worktreePath: string) => boolean,
): Promise<{ success: boolean; warning?: string }> {
  // Detect whether targetBranch is currently checked out in the root repo.
  // `git fetch <remote> main:main` fails with "refusing to fetch into branch
  // checked out at ..." when main is the current branch. The accept command
  // typically runs from the user's main repo which is on main.
  const headResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const currentBranch = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
  const remoteRef = `${remoteName}/${targetBranch}`;

  if (currentBranch === targetBranch) {
    // Target branch IS checked out — fetch then ff-only merge.
    const fetchResult = await git(['fetch', remoteName, targetBranch], root);
    if (fetchResult.exitCode !== 0) {
      const warning = `Local ${targetBranch} has diverged from ${remoteRef}. Run \`git pull\` to reconcile.`;
      logger.warn(`fastForwardLocal: fetch failed: ${fetchResult.stderr}`);
      return { success: false, warning };
    }

    const mergeResult = await git(['merge', '--ff-only', remoteRef], root);
    if (mergeResult.exitCode === 0) {
      logger.debug(`fastForwardLocal: ${targetBranch} fast-forwarded to ${remoteRef}`);
      return { success: true };
    }

    // ff-only failed — local has diverged or is already up to date
    const stderr = mergeResult.stderr;
    if (stderr.includes('Already up to date') || mergeResult.stdout.includes('Already up to date')) {
      logger.debug(`fastForwardLocal: ${targetBranch} already up to date`);
      return { success: true };
    }

    const warning = `Local ${targetBranch} has diverged from ${remoteRef}. Run \`git pull\` to reconcile.`;
    logger.warn(`fastForwardLocal: ${warning}`);
    return { success: false, warning };
  }

  // Target branch is NOT checked out — use refspec fetch to advance the local ref.
  const result = await git(['fetch', remoteName, `${targetBranch}:${targetBranch}`], root);
  if (result.exitCode === 0) {
    logger.debug(`fastForwardLocal: ${targetBranch} fast-forwarded to ${remoteRef}`);
    return { success: true };
  }

  // Refspec fetch failed — check if it's because the branch is checked out in a worktree
  if (result.stderr.includes('checked out at') || result.stderr.includes('refusing to fetch')) {
    const worktreePath = await findWorktreeForBranch(targetBranch, root, git);
    if (worktreePath) {
      if (shouldSkipWorktree?.(worktreePath)) {
        const warning = `Skipped fast-forward of ${targetBranch}: worktree at ${worktreePath} belongs to an active task.`;
        logger.warn(`fastForwardLocal: ${warning}`);
        return { success: true, warning };
      }
      return await tryFastForwardInWorktree(targetBranch, worktreePath, remoteRef, remoteName, root, git);
    }
  }

  // Fetch failed — check if local is just behind (can fast-forward) vs truly diverged
  // First, ensure we have the latest remote ref
  const fetchRemoteResult = await git(['fetch', remoteName, targetBranch], root);
  if (fetchRemoteResult.exitCode !== 0) {
    const warning = `Failed to fetch ${remoteRef}. Run \`git fetch\` to update.`;
    logger.warn(`fastForwardLocal: ${warning}`);
    return { success: false, warning };
  }

  // Get local and remote SHAs
  const localShaResult = await git(['rev-parse', targetBranch], root);
  const remoteShaResult = await git(['rev-parse', remoteRef], root);

  if (localShaResult.exitCode !== 0 || remoteShaResult.exitCode !== 0) {
    const warning = `Failed to get SHA for ${targetBranch} or ${remoteRef}.`;
    logger.warn(`fastForwardLocal: ${warning}`);
    return { success: false, warning };
  }

  const localSha = localShaResult.stdout.trim();
  const remoteSha = remoteShaResult.stdout.trim();

  // Check if they're already the same (shouldn't happen after fetch failure, but check anyway)
  if (localSha === remoteSha) {
    logger.debug(`fastForwardLocal: ${targetBranch} already up to date`);
    return { success: true };
  }

  // Check if local is an ancestor of remote (i.e., local is behind, can fast-forward)
  const isAncestorResult = await git(['merge-base', '--is-ancestor', localSha, remoteSha], root);
  if (isAncestorResult.exitCode === 0) {
    // Local is behind — force-update the local ref to match remote
    logger.debug(`fastForwardLocal: ${targetBranch} is behind ${remoteRef}, force-updating local ref`);
    const updateResult = await git(['branch', '-f', targetBranch, remoteRef], root);
    if (updateResult.exitCode === 0) {
      logger.debug(`fastForwardLocal: ${targetBranch} fast-forwarded to ${remoteRef}`);
      return { success: true };
    }

    // git branch -f failed — check if it's because the branch is checked out in a worktree
    if (updateResult.stderr.includes('checked out at') || updateResult.stderr.includes('cannot force update')) {
      const worktreePath = await findWorktreeForBranch(targetBranch, root, git);
      if (worktreePath) {
        if (shouldSkipWorktree?.(worktreePath)) {
          const warning = `Skipped fast-forward of ${targetBranch}: worktree at ${worktreePath} belongs to an active task.`;
          logger.warn(`fastForwardLocal: ${warning}`);
          return { success: true, warning };
        }
        return await tryFastForwardInWorktree(targetBranch, worktreePath, remoteRef, remoteName, root, git);
      }
    }

    const warning = `Failed to update ${targetBranch} to ${remoteRef}: ${updateResult.stderr}`;
    logger.warn(`fastForwardLocal: ${warning}`);
    return { success: false, warning };
  }

  // Local has truly diverged (both have commits the other doesn't)
  const warning = `Local ${targetBranch} has diverged from ${remoteRef}. Run \`git pull\` to reconcile.`;
  logger.warn(`fastForwardLocal: ${warning}`);
  return { success: false, warning };
}

/**
 * Pre-flight check: validate that a local branch is in sync with the driver's
 * configured remote before performing an irreversible remote merge.
 *
 * "In sync" means local is equal to, behind, or ahead of the remote — any
 * linear relationship is fine. True divergence (both sides have commits the
 * other doesn't) is the failure case — it means fastForwardLocal will fail
 * after the remote merge, leaving things half-merged.
 *
 * Only checks the single remote that the driver uses — not all git remotes.
 * Users may have other remotes (heroku, personal forks) that are irrelevant.
 */
export async function validateBranchInSyncWithRemote(
  branch: string,
  remote: string,
  root: string,
  git: (args: string[], cwd?: string) => Promise<GitResult> = runGit,
): Promise<{ inSync: boolean; error?: string }> {
  // Fetch the branch from the driver's remote
  const fetchResult = await git(['fetch', remote, branch], root);
  if (fetchResult.exitCode !== 0) {
    // INVARIANT: Fetch failure is a real failure — no silent fallback.
    // If we can't verify sync, we must not proceed with an irreversible
    // remote merge that could leave local and remote diverged.
    return {
      inSync: false,
      error: `Failed to fetch ${branch} from ${remote}: ${fetchResult.stderr.trim() || 'unknown error'}. Check your network connection and retry.`,
    };
  }

  const remoteRef = `${remote}/${branch}`;

  // Get local and remote SHAs
  const localShaResult = await git(['rev-parse', branch], root);
  const remoteShaResult = await git(['rev-parse', remoteRef], root);

  if (localShaResult.exitCode !== 0 || remoteShaResult.exitCode !== 0) {
    // Can't resolve refs — fail rather than silently proceeding
    return {
      inSync: false,
      error: `Failed to resolve refs for ${branch} or ${remoteRef}. Ensure both branches exist.`,
    };
  }

  const localSha = localShaResult.stdout.trim();
  const remoteSha = remoteShaResult.stdout.trim();

  if (localSha === remoteSha) {
    return { inSync: true };
  }

  // Check if local is an ancestor of remote (local is behind — can fast-forward, OK)
  const localBehind = await git(['merge-base', '--is-ancestor', localSha, remoteSha], root);
  if (localBehind.exitCode === 0) {
    return { inSync: true };
  }

  // Check if remote is an ancestor of local (local is ahead — has unpushed commits, OK)
  // This is fine because local has everything remote has plus more. The post-merge
  // fast-forward will succeed since local can only be further ahead after merging.
  const localAhead = await git(['merge-base', '--is-ancestor', remoteSha, localSha], root);
  if (localAhead.exitCode === 0) {
    return { inSync: true };
  }

  // True divergence: both sides have commits the other doesn't
  return {
    inSync: false,
    error: `Local ${branch} has diverged from ${remoteRef} (both have commits the other doesn't). Reconcile with \`git pull\` or \`git push\` before accepting.`,
  };
}
