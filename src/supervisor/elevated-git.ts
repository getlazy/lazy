/**
 * Ref-writing git operations, executed on the host.
 *
 * The supervisor runs inside the agent container, where the repository's git
 * common dir is mounted read-only (see `src/capture/git-mounts.ts`): refs,
 * packed-refs, config and hooks cannot be written from in there, by anyone —
 * that is the whole point of the split mount, and it applies to the supervisor
 * just as much as to a rogue agent.
 *
 * The supervisor's sync phase legitimately needs to move refs, so those few
 * operations are forwarded to the daemon over the MCP channel the container
 * already authenticates to, and the daemon runs them host-side after validating
 * them (`src/mcp/internal-git.ts`).
 *
 * Whether to elevate is decided by the repository itself, not by an env var: if
 * this worktree's git common dir is WRITABLE, the operation runs locally exactly
 * as before (host-process runner, unit tests, any repo that is not behind the
 * split mount). Only a read-only common dir — the container case — goes to the
 * daemon, and there a missing daemon config is a hard error, not a silent
 * fallback to a local git write the kernel would reject anyway.
 *
 * Probing the actual mount rather than reading `LAZY_DAEMON_CONFIG` matters
 * because that variable is inherited by any process the supervisor's environment
 * spawns, including test processes operating on a completely different, writable
 * repository. The question "can I move this ref myself?" only has one honest
 * answer, and it is per-repository.
 */

import { access, constants } from 'fs/promises';
import { runGit, type GitResult } from '../utils/git';
import { readDaemonMcpConfig, createDaemonProxyHandler } from '../daemon/mcp-proxy';
import { INTERNAL_GIT_TOOL_NAME } from '../mcp/types';
import { log, logWarn } from './log';

interface InternalGitReply {
  exit_code: number;
  stdout: string;
  stderr: string;
  head: string;
}

/** Cached per process — the config file does not change under a running turn. */
let cachedCall: ((args: Record<string, unknown>) => Promise<unknown>) | null | undefined;

/** Cached per worktree — a mount does not change under a running turn. */
const commonDirWritable = new Map<string, boolean>();

/**
 * Can this process move a ref in `cwd`'s repository by itself?
 *
 * The split mount makes the whole common dir read-only, so a write probe on it
 * answers the question exactly: no permission-bit guesswork, and root inside a
 * container gets the same EROFS everyone else does.
 */
async function canWriteRefsLocally(cwd: string): Promise<boolean> {
  const cached = commonDirWritable.get(cwd);
  if (cached !== undefined) return cached;

  const resolved = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (resolved.exitCode !== 0) {
    throw new Error(
      `Failed to resolve the git common dir for ${cwd}: ${resolved.stderr || 'git rev-parse failed'}`,
    );
  }

  let writable: boolean;
  try {
    await access(resolved.stdout.trim(), constants.W_OK);
    writable = true;
  } catch {
    // Any failure to write here — EROFS from the read-only mount, EACCES from a
    // permission bit — means the same thing for us: this operation has to be
    // asked of the daemon instead.
    writable = false;
  }

  commonDirWritable.set(cwd, writable);
  return writable;
}

function daemonCall(): (args: Record<string, unknown>) => Promise<unknown> {
  if (cachedCall !== undefined && cachedCall !== null) return cachedCall;

  const configPath = process.env.LAZY_DAEMON_CONFIG;
  if (!configPath) {
    throw new Error(
      'This repository\'s git directory is read-only and LAZY_DAEMON_CONFIG is not set, so there ' +
      'is no way to perform a ref-writing git operation. A lazy agent container always receives ' +
      'the daemon MCP config; if you are seeing this, the container was launched without it.',
    );
  }

  try {
    const config = readDaemonMcpConfig(configPath);
    cachedCall = createDaemonProxyHandler(config, INTERNAL_GIT_TOOL_NAME, {
      log: (m) => logWarn(`[git] ${m}`),
    });
  } catch (err) {
    // A daemon config that exists but cannot be read is a real failure: the
    // container has no other way to move a ref. Surface it rather than falling
    // back to a local git write the kernel will reject with a worse message.
    throw new Error(
      `Failed to read daemon MCP config at ${configPath}, needed for host-side git operations: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return cachedCall;
}

/** Test seam: forget the memoized channel and mount probes. */
export function resetElevatedGitChannel(): void {
  cachedCall = undefined;
  commonDirWritable.clear();
}

async function elevate(
  cwd: string,
  args: Record<string, unknown>,
  localOperation: () => Promise<GitResult>,
): Promise<GitResult> {
  if (await canWriteRefsLocally(cwd)) return localOperation();

  const reply = (await daemonCall()(args)) as InternalGitReply;
  return {
    stdout: reply.stdout ?? '',
    stderr: reply.stderr ?? '',
    exitCode: reply.exit_code ?? 1,
  };
}

/**
 * Merge `target` into the current branch, host-side.
 *
 * The daemon re-validates the target against this task's own upstreams, so a
 * tampered protocol dir cannot turn a sync into a sibling-branch merge.
 */
export async function elevatedMerge(
  cwd: string,
  target: string,
  message: string,
): Promise<GitResult> {
  log(`[git] Merging ${target}`);
  return elevate(
    cwd,
    { op: 'merge', target, message },
    () => runGit(['merge', target, '--no-ff', '-m', message], { cwd }),
  );
}

/** Abort an in-progress merge, host-side. */
export async function elevatedMergeAbort(cwd: string): Promise<GitResult> {
  return elevate(cwd, { op: 'merge_abort' }, () => runGit(['merge', '--abort'], { cwd }));
}

/**
 * Conclude an in-progress merge whose conflicts are already resolved, host-side.
 *
 * The daemon refuses unless MERGE_HEAD exists and no unmerged paths remain, so
 * this can only ever finish a merge that was already validated when it started.
 * It exists so a complete resolution is never thrown away just because the agent
 * could not create the merge commit itself.
 */
export async function elevatedMergeCommit(cwd: string): Promise<GitResult> {
  log('[git] Committing resolved merge');
  return elevate(
    cwd,
    { op: 'merge_commit' },
    () => runGit(['commit', '-a', '--no-edit', '--no-verify'], { cwd }),
  );
}

/** `git reset --hard HEAD` — discards worktree state only, never moves a ref. */
export async function elevatedResetHardHead(cwd: string): Promise<GitResult> {
  return elevate(cwd, { op: 'reset_hard_head' }, () => runGit(['reset', '--hard', 'HEAD'], { cwd }));
}

/** Force-write a `turn/<taskid8>/<phase>/<sha>` tag, host-side. */
export async function elevatedTag(cwd: string, name: string): Promise<GitResult> {
  return elevate(cwd, { op: 'tag', name }, () => runGit(['tag', '-f', name], { cwd }));
}
