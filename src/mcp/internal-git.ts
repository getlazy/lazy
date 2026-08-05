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
import type { McpToolContext } from './tools';
import { runGit } from '../utils/git';
import { requireStorage } from '../cli/helpers';
import type { Storage } from '../storage';
import { loadConfig } from '../config/loader';
import { resolveParentBranchWithFallback } from '../daemon/task-lifecycle';

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
        enum: ['merge', 'merge_abort', 'reset_hard_head', 'tag'],
        description: 'The operation to perform',
      },
      target: { type: 'string', description: 'merge: ref or SHA to merge' },
      message: { type: 'string', description: 'merge: commit message' },
      name: { type: 'string', description: 'tag: tag name' },
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
  return ctx.storage ?? (await requireStorage());
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
  const config = await loadConfig(projectRoot, { cwd: worktreePath });
  const remote = config.remote.git_remote;

  const refs: string[] = [];

  const parent = await resolveParentBranchWithFallback(task, storage, projectRoot);
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
  const expected = new RegExp(`^turn/${taskId.substring(0, 8)}/[a-z0-9-]+/[0-9a-f]{7,40}$`);
  if (!expected.test(name)) {
    throw new Error(
      `Refusing to write tag "${name}": supervisor tags must be of the form ` +
      `turn/${taskId.substring(0, 8)}/<phase>/<sha>.`,
    );
  }
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
    const op = args.op as string;

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
