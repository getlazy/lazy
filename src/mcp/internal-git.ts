/**
 * Internal, daemon-executed git operations for the supervisor.
 *
 * The agent container mounts the repository's git common dir read-only (see
 * `src/capture/git-mounts.ts`), so nothing inside the container can move a ref.
 * That is deliberate — it is what stops a rogue agent from rewriting history or
 * merging a sibling branch. But the SUPERVISOR also runs inside that container,
 * and its sync phase legitimately needs to move refs: merge upstream, abort a
 * failed merge, reset a wedged worktree, tag HEAD after a turn.
 *
 * Those operations move here, to the host side of the daemon MCP channel, where
 * the daemon owns the repository. The supervisor asks; the daemon decides.
 *
 * This tool is registered in `createAllHandlers` but deliberately NOT in
 * `allTools`: it is never advertised to an agent and never pre-approved as an
 * agent-callable tool. It is reachable only over the daemon MCP route the
 * supervisor already authenticates to with its per-container bearer token.
 *
 * SECURITY: the daemon never trusts the requested merge target. The supervisor
 * reads it from the protocol dir, which is writable inside the container, so a
 * compromised container could name any ref. Every merge target must be
 * reachable from this task's own legitimate upstream (its parent branch, or its
 * own branch on the remote) — which makes "merge a sibling task's branch"
 * impossible even with a valid token.
 */

import { dirname } from 'path';
import type { McpTool, McpToolHandler } from './types';
import { INTERNAL_GIT_TOOL_NAME } from './types';
import { type McpToolContext, mcpActor } from './tools';
import { runGit } from '../utils/git';
import { resolveStorage } from '../preconditions';
import { assertWorktreeUsable } from './turn-identity';
import { assertTaskWorktreeHead, taskWorktreeOf } from '../git/worktree-pointers';
import type { Storage } from '../storage';
import { loadConfig } from '../config/loader';
import { resolveParentBranchWithFallback } from '../daemon/task-lifecycle';
import { resolveOutstandingViolations } from '../protection/outstanding-resolver';
import { applyProtectedRestores, planRejectedRestores } from '../protection/rejected-restore';
import type { ProtectedRestore } from '../protocol/types';

export { INTERNAL_GIT_TOOL_NAME };

/**
 * Not exported through `allTools` on purpose — see the module comment. The
 * schema exists so the daemon route can validate shape, not so an agent can
 * discover it.
 */
export const internalGitTool: McpTool = {
  name: INTERNAL_GIT_TOOL_NAME,
  description:
    'Internal: run a ref-writing git operation host-side on behalf of the supervisor. ' +
    'Not an agent-facing tool.',
  inputSchema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['merge', 'merge_abort', 'merge_commit', 'reset_hard_head', 'tag', 'restore_rejected'],
        description: 'The operation to perform',
      },
      target: { type: 'string', description: 'merge: ref or SHA to merge' },
      message: { type: 'string', description: 'merge: commit message' },
      name: { type: 'string', description: 'tag: tag name' },
      files: {
        type: 'array',
        description: 'restore_rejected: the rejected protected files to restore ({ file, base_sha })',
        items: { type: 'object' },
      },
    },
    required: ['op'],
  },
};

export interface InternalGitResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  /** HEAD after the operation, so the supervisor never has to trust its own view. */
  head: string;
}

async function getStorage(ctx: McpToolContext): Promise<Storage> {
  return ctx.storage ?? (await resolveStorage());
}

/**
 * Derive the project root from the worktree itself.
 *
 * The git common dir is `<root>/.git` for every lazy worktree, and asking git
 * is exact — it does not assume a `.lazy/worktrees/<ref>` layout that a future
 * data-dir change could invalidate.
 */
async function projectRootOf(worktreePath: string): Promise<string> {
  const result = await runGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: worktreePath },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to resolve the repository for ${worktreePath}: ${result.stderr || 'git rev-parse failed'}`,
    );
  }
  return dirname(result.stdout.trim());
}

/**
 * The refs this task is allowed to merge from: its parent/target branch (local
 * and remote form) and its OWN branch on the remote. Anything else — notably a
 * sibling task's branch — is rejected.
 */
async function allowedMergeRefs(
  ctx: McpToolContext,
  worktreePath: string,
): Promise<string[]> {
  const storage = await getStorage(ctx);
  const task = await storage.getTask(ctx.taskId);
  if (!task) {
    throw new Error(`Task ${ctx.taskId} not found`);
  }

  const projectRoot = await projectRootOf(worktreePath);
  const config = await loadConfig(projectRoot);
  const remote = config.remote.git_remote;

  const refs: string[] = [];

  // This runs in the AGENT's own MCP process, so any re-parent comment the
  // resolution leaves behind is that agent's, not a human's.
  const parent = await resolveParentBranchWithFallback(task, storage, projectRoot, mcpActor(ctx));
  if (parent.branch) {
    refs.push(parent.branch, `${remote}/${parent.branch}`);
  }

  // The task's own branch on the remote — what a sync-with-remote merges.
  const session = await storage.getSessionByTaskId(ctx.taskId);
  const ownBranch = session?.git_branch;
  if (ownBranch) {
    refs.push(`${remote}/${ownBranch}`);
  }

  return refs;
}

/**
 * Reject any merge target that is not already contained in one of this task's
 * legitimate upstreams.
 *
 * Reachability (not string equality) is the right test: sync merges a SHA the
 * daemon resolved earlier, and that SHA is by construction an ancestor-or-equal
 * of the upstream ref. A sibling branch's tip is not reachable from either
 * allowed ref, so it fails.
 */
async function assertMergeTargetAllowed(
  ctx: McpToolContext,
  worktreePath: string,
  target: string,
): Promise<string> {
  const resolved = await runGit(
    ['rev-parse', '--verify', `${target}^{commit}`],
    { cwd: worktreePath },
  );
  if (resolved.exitCode !== 0) {
    throw new Error(`Merge target ${target} does not resolve to a commit: ${resolved.stderr}`);
  }
  const targetSha = resolved.stdout.trim();

  const allowed = await allowedMergeRefs(ctx, worktreePath);
  for (const ref of allowed) {
    const exists = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: worktreePath });
    if (exists.exitCode !== 0) continue;
    const contained = await runGit(
      ['merge-base', '--is-ancestor', targetSha, exists.stdout.trim()],
      { cwd: worktreePath },
    );
    if (contained.exitCode === 0) return targetSha;
  }

  throw new Error(
    `Refusing to merge ${target} (${targetSha.substring(0, 8)}) into task ${ctx.taskId.substring(0, 8)}: ` +
    `it is not contained in any upstream this task may merge from ` +
    `(${allowed.join(', ') || 'none resolvable'}). Merging arbitrary branches from inside an ` +
    `agent container is not permitted.`,
  );
}

/** `turn/<taskid8>/<phase>/<sha>` — the only tag names the supervisor may write. */
function assertTagNameAllowed(taskId: string, name: string): void {
  const shortId = taskId.substring(0, 8);

  // Structural comparison, not a RegExp built from `taskId`. This is a security
  // check — it gates which tags the supervisor may write — and a task id
  // carrying a regex metacharacter would silently weaken or break it rather
  // than simply failing to match. Splitting on '/' gives the same guarantee
  // with only static patterns, and states the four segments outright.
  const parts = name.split('/');
  const allowed =
    parts.length === 4 &&
    parts[0] === 'turn' &&
    parts[1] === shortId &&
    /^[a-z0-9-]+$/.test(parts[2]) &&
    /^[0-9a-f]{7,40}$/.test(parts[3]);

  if (!allowed) {
    throw new Error(
      `Refusing to write tag "${name}": supervisor tags must be of the form ` +
      `turn/${shortId}/<phase>/<sha>.`,
    );
  }
}


/**
 * The daemon's own answer to "which rejected files would I restore now", and
 * the requested plan must be a subset of it, entry for entry. Returns the
 * daemon's entries, never the caller's objects.
 */
async function assertRestorePlanAllowed(
  ctx: McpToolContext,
  worktreePath: string,
  requested: unknown[],
): Promise<ProtectedRestore[]> {
  const storage = await getStorage(ctx);
  const task = await storage.getTask(ctx.taskId);
  const session = await storage.getSessionByTaskId(ctx.taskId);
  if (!task || !session) throw new Error(`Task ${ctx.taskId} has no task record or session.`);
  const projectRoot = await projectRootOf(worktreePath);
  const allowed = planRejectedRestores((await resolveOutstandingViolations(
    projectRoot, task, session, await storage.getSessionTurns(session.id), storage,
  )).outstanding);
  const plan: ProtectedRestore[] = [];
  for (const entry of requested) {
    const e = entry as Partial<ProtectedRestore> | null;
    const match = allowed.find((a) => a.file === e?.file && a.base_sha === e?.base_sha);
    if (!match) {
      throw new Error(
        `Refusing to restore ${JSON.stringify(entry)} for task ${ctx.taskId.substring(0, 8)}: it is not ` +
        `a rejected protected file this task still owes a restore ` +
        `(${allowed.map((a) => a.file).join(', ') || 'none'}).`,
      );
    }
    plan.push(match);
  }
  return plan;
}
async function headOf(cwd: string): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd });
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

export function createInternalGitHandler(ctx: McpToolContext): McpToolHandler {
  return async (args: Record<string, unknown>): Promise<InternalGitResult> => {
    if (!ctx.taskId) {
      throw new Error(`${INTERNAL_GIT_TOOL_NAME} requires a task context.`);
    }
    const cwd = ctx.worktreePath;
    // Same guard the agent-facing tools use: every op below runs git in this
    // directory, and if it has gone missing the supervisor should be told which
    // worktree and why rather than reading git's "cannot change to ...".
    await assertWorktreeUsable(INTERNAL_GIT_TOOL_NAME, cwd, ctx.taskId);
    const op = args.op as string;

    // Every op but merge_abort writes a commit or ref through HEAD: in a task
    // worktree HEAD must be the task's own branch (src/git/worktree-pointers.ts),
    // or a task that redirected it gets this host-side git to move another.
    if (op !== 'merge_abort' && taskWorktreeOf(cwd)) {
      const storage = await getStorage(ctx);
      const branch = (await storage.getSessionByTaskId(ctx.taskId))?.git_branch;
      if (!branch) throw new Error(`${INTERNAL_GIT_TOOL_NAME}: task ${ctx.taskId} has no session branch.`);
      await assertTaskWorktreeHead(cwd, branch);
    }

    let result: { exitCode: number; stdout: string; stderr: string };

    switch (op) {
      case 'merge': {
        const target = args.target as string;
        const message = args.message as string;
        if (!target || !message) {
          throw new Error(`${INTERNAL_GIT_TOOL_NAME} merge requires both "target" and "message".`);
        }
        const targetSha = await assertMergeTargetAllowed(ctx, cwd, target);
        // Merge the resolved SHA, not the ref the caller named: the ref could
        // move between validation and merge.
        result = await runGit(['merge', targetSha, '--no-ff', '-m', message], { cwd });
        break;
      }
      case 'merge_abort':
        result = await runGit(['merge', '--abort'], { cwd });
        break;
      case 'merge_commit': {
        // Conclude a merge whose conflicts are already resolved. The merge
        // itself was validated when it was STARTED (the `merge` case above), so
        // no new target is being introduced here — the only thing this adds is
        // the commit the container cannot create for itself.
        //
        // Both guards are refusals, not conveniences: without MERGE_HEAD this
        // would commit arbitrary worktree changes as if they were a merge, and
        // with unmerged paths it would commit conflict markers.
        const mergeHead = await runGit(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd });
        if (mergeHead.exitCode !== 0) {
          throw new Error(
            `${INTERNAL_GIT_TOOL_NAME} merge_commit: no merge is in progress in ${cwd} ` +
            `(MERGE_HEAD does not exist). Refusing to commit worktree changes as a merge.`,
          );
        }
        const unmerged = await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd });
        if (unmerged.exitCode === 0 && unmerged.stdout.trim()) {
          throw new Error(
            `${INTERNAL_GIT_TOOL_NAME} merge_commit: refusing to commit a merge with unresolved ` +
            `conflicts in ${cwd}:\n${unmerged.stdout.trim()}`,
          );
        }
        result = await runGit(['commit', '-a', '--no-edit', '--no-verify'], { cwd });
        break;
      }
      case 'reset_hard_head':
        result = await runGit(['reset', '--hard', 'HEAD'], { cwd });
        break;
      case 'tag': {
        const name = args.name as string;
        if (!name) throw new Error(`${INTERNAL_GIT_TOOL_NAME} tag requires "name".`);
        assertTagNameAllowed(ctx.taskId, name);
        result = await runGit(['tag', '-f', name], { cwd });
        break;
      }
      case 'restore_rejected': {
        // Put rejected protected files back to their base and commit that as
        // lazy's own commit (src/protection/rejected-restore.ts). The plan
        // came through the protocol dir, which the container can write, so it
        // is honoured only where it matches EXACTLY what the daemon itself
        // would restore: a rejected file still outstanding, at the same base.
        const requested = args.files;
        if (!Array.isArray(requested) || requested.length === 0) {
          throw new Error(`${INTERNAL_GIT_TOOL_NAME} restore_rejected requires a non-empty "files" list.`);
        }
        const plan = await assertRestorePlanAllowed(ctx, cwd, requested);
        try {
          const sha = await applyProtectedRestores(cwd, plan);
          result = { exitCode: 0, stdout: sha ?? '', stderr: '' };
        } catch (err) {
          result = { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
        }
        break;
      }
      default:
        throw new Error(`${INTERNAL_GIT_TOOL_NAME}: unknown op "${op}"`);
    }

    return {
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      head: await headOf(cwd),
    };
  };
}
