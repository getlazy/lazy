/**
 * The WRITE boundary for a walkthrough: validate it, and resolve its
 * directory/glob file items against the task's own diff range.
 *
 * Why here and not in the tool handler or in storage. A pattern claims the
 * paths THIS task changed, so resolving it needs the diff range — git — which
 * storage (a store, possibly not FileStorage) cannot reach, and which the MCP
 * handler must not decide for itself: matching a pattern to a partition is a
 * business rule, and the daemon owns those. So `lazy_report` calls this the
 * same way `lazy_regions` calls the regions RPC, and the answer it gets back
 * is the walkthrough as it will be stored.
 *
 * The range is the one `presentedRegions` partitions (`fullBranch: true`,
 * §6.3): a group whose glob matched nothing but files an accepted child
 * brought would otherwise be refused on a release hub, where those files are
 * exactly what the walkthrough is about.
 *
 * Git is touched ONLY when a pattern is present. A walkthrough of literal
 * paths — every one written before this existed — keeps the old code path,
 * so a task whose worktree cannot be resolved can still file its report.
 */

import { listReviewPaths, resolveSha } from '../regions';
import {
  PresentationCapError,
  expandPresentationPatterns,
  isPathPattern,
  normalizeReviewPresentation,
} from '../storage/presentation';
import type { PresentationCapRefusal, ReviewPresentation } from '../types';
import { RpcError } from './rpc-error';
import { getOrCreateStorage } from './rpc-handlers';
import { resolveTaskDiffContext } from './task-diff-context';

export interface ExpandPresentationResult {
  /** The walkthrough as it will be stored — patterns resolved. */
  presentation?: ReviewPresentation;
  /**
   * Set instead of `presentation` when a cap refused the walkthrough. Returned
   * rather than thrown because the caller has something to do with it first:
   * record it against the task, so the CAP is visible to the reviewer and not
   * only to the agent that worked around it.
   */
  refused?: PresentationCapRefusal;
}

/**
 * Whether any group carries a directory/glob item — the only reason to read git.
 *
 * Safe to short-circuit on because normalization (default, un-`resolved`) has
 * already DROPPED any `matched` the caller sent: a walkthrough of literal
 * paths reaching the early return carries no claims but its own paths.
 */
function hasPatternItem(presentation: ReviewPresentation): boolean {
  return presentation.groups.some((g) =>
    g.items.some((item) => item.kind === 'file' && isPathPattern(item.file)),
  );
}

/**
 * `expandPresentation` RPC — normalize a walkthrough and resolve its patterns.
 *
 * Validation errors (a malformed item, a pattern matching nothing) throw a 400
 * naming what to fix, because the agent can still fix them. A CAP is different:
 * it is a limit of ours, not a mistake of theirs, so it comes back as data.
 */
export async function handleExpandPresentation(
  projectRoot: string,
  params: Record<string, unknown>,
): Promise<ExpandPresentationResult> {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }

  let presentation: ReviewPresentation | undefined;
  try {
    presentation = normalizeReviewPresentation(params.presentation);
  } catch (err) {
    if (err instanceof PresentationCapError) return { refused: err.refusal };
    throw new RpcError(400, err instanceof Error ? err.message : String(err));
  }
  if (!presentation) return {};
  if (!hasPatternItem(presentation)) return { presentation };

  const storage = await getOrCreateStorage();
  const { task } = await storage.resolveTask(params.taskId);
  if (!task) throw new RpcError(404, `Task not found: ${params.taskId}`);

  let diffPaths: string[];
  try {
    const ctx = await resolveTaskDiffContext(storage, projectRoot, params.taskId, {
      fullBranch: true,
    });
    const headSha = (await resolveSha(ctx.worktreePath, 'HEAD')) ?? '';
    const baseSha = (await resolveSha(ctx.worktreePath, ctx.fromRef)) ?? ctx.fromRef;
    diffPaths = headSha ? (await listReviewPaths(ctx.worktreePath, baseSha, headSha)).paths : [];
  } catch (err) {
    // The range is what a pattern is resolved against, so without it there is
    // no honest answer — refusing here is what stops a group from being stored
    // claiming nothing. Says what failed, so the agent can fall back to
    // literal paths rather than guess at a broken tool.
    throw new RpcError(
      400,
      `Could not read this task's diff range to resolve the walkthrough's directory/glob items: ` +
        `${err instanceof Error ? err.message : err}. List the files individually instead.`,
    );
  }

  try {
    return { presentation: { ...presentation, groups: expandPresentationPatterns(presentation.groups, diffPaths) } };
  } catch (err) {
    throw new RpcError(400, err instanceof Error ? err.message : String(err));
  }
}
