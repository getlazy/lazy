/**
 * Submit preflight — one forge question, every client uses the answer.
 *
 * Returns whether a PR would go into a protected branch, or `'unknown'` with
 * the reason when the forge cannot be asked. Unknown is treated as unprotected
 * for confirmation strength (fail toward the stronger prompt). A forge failure
 * never silently passes as "protected".
 */

import { join } from 'path';
import { getOrCreateStorage } from './rpc-handlers';
import { RpcError } from './rpc-error';
import { loadConfig } from '../config/loader';
import { createDriver } from '../remote';
import { isOfflineMode } from '../utils/offline';
import { displayId } from '../task/identity';
import { logger } from '../utils/logger';
import type { ActorInput } from '../types';
import {
  resolveSubmitTarget,
  mayOpenIntermediateReview,
  intermediateSubmitRefusal,
  baseNotOnRemoteRefusal,
  findUnrecordedReview,
  reviewBaseMismatch,
  reviewComparisonBranch,
  recordedReviewBase,
  recordedBaseUnreadableRefusal,
  linkedReviewBaseRefusal,
  mismatchedReviewRefusal,
} from './submit-target';
import { escapeMergingForOperation } from './stranded-merge';
import { isLinkedTask } from '../task/linked';
import {
  LAZY_CLOSED_REVIEW_KEY,
  markedRecordState,
  unconfirmedCloseRefusal,
  withoutReviewRecord,
} from './lazy-closed-review';
import { getActor } from '../constants';
import {
  submitTierFromPreflight,
  type SubmitPreflight,
} from '../submit-confirmation';

export async function submitTaskPreflight(
  projectRoot: string,
  taskId: string,
  /** Who would submit: decides whether an intermediate target is honoured. */
  actorInput?: ActorInput,
): Promise<SubmitPreflight> {
  const actor = actorInput ?? getActor();
  const storage = await getOrCreateStorage();
  const resolved = await storage.resolveTask(taskId);
  if (!resolved.task) {
    throw new RpcError(404, `Task not found: ${taskId}`);
  }
  // `let`: a stranded `merging` task is recovered below, which replaces this.
  let task = resolved.task;
  const config = await loadConfig(projectRoot);
  const forgeName = config.remote.driver === 'gitlab' ? 'GitLab' : 'GitHub';

  const empty = (refusal: string, targetBranch = ''): SubmitPreflight => ({
    canSubmit: false,
    refusal,
    targetBranch,
    taskCode: task.code ?? null,
    targetIsProtected: 'unknown',
    confirmationTier: 'none',
    forgeName,
  });

  if (await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline)) {
    return empty('Cannot submit while in offline mode. Run `lazy system online` first.');
  }

  // Same escape `submitTask` uses: a dead accept leaves `merging` on the
  // record, and the CLI now asks this preflight before it ever calls submit.
  // Recover here so a stranded task is unwedged even when the next check
  // refuses (local driver, no commits). A live accept still 409s — we never
  // interrupt a merge in progress. MCP's first `lazy_submit` is a confirmation
  // preview; unwedging wreckage is not a submit.
  if (task.status === 'merging') {
    try {
      task = await escapeMergingForOperation(storage, task, actor, 'submit', projectRoot);
    } catch (err) {
      if (err instanceof RpcError) return empty(err.message);
      throw err;
    }
    if (task.status === 'submitted') {
      return empty(
        `Task ${displayId(task)} was stranded in merging by an accept that is no longer running. ` +
        `It was already submitted before that accept, so submit will restore it to submitted — its existing PR still stands.`,
      );
    }
  }

  if (task.status !== 'blocked' && task.status !== 'conflict') {
    return empty(
      `Task ${displayId(task)} is ${task.status}. Only blocked or conflict tasks can be submitted.`,
    );
  }

  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) {
    return empty(`Task ${displayId(task)} has no session.`);
  }
  const commits = await storage.getSessionCommits(sess.id);
  if (commits.length === 0) {
    return empty(`Task ${displayId(task)} has no commits. Nothing to submit for review.`);
  }

  let driver;
  try {
    driver = createDriver(config);
  } catch {
    return empty('No remote driver configured. Set [remote] driver in lazy.toml to use submit.');
  }
  if (!driver.needsSync) {
    return empty('Submit requires a remote driver (e.g., github). Local driver has no remote to create PRs on.');
  }

  // INVARIANT (./submit-target.ts): an intermediate target is refused to
  // agents and the builder, and honoured for a person. Same rule, same words,
  // as submitTask — this preflight is what every client shows before its prompt.
  const submitTarget = await resolveSubmitTarget(task, storage);
  const { targetBranch, intermediate } = submitTarget;
  if (intermediate && !mayOpenIntermediateReview(actor)) {
    return empty(intermediateSubmitRefusal(task, targetBranch), targetBranch);
  }

  // A PR lazy closed itself (./lazy-closed-review.ts): the answer submit will
  // act on. Unreadable → submit refuses, so the preflight does too. Closed →
  // submit drops the dead record and opens a new PR, so the questions below
  // are asked of the task as it will read then. Read-only: nothing is dropped
  // here.
  const marked = await markedRecordState(driver, task);
  if (marked === 'unknown') {
    return empty(unconfirmedCloseRefusal(displayId(task), task.metadata?.[LAZY_CLOSED_REVIEW_KEY] ?? ''), targetBranch);
  }
  const recordTask = marked === 'closed' ? withoutReviewRecord(task) : task;

  // The same recorded-base check submitTask makes (./submit-target.ts): an
  // unreadable base refuses; a base that is not the current target is moved
  // by submit, which needs the target on the remote — checked below.
  const recorded = await recordedReviewBase(driver, recordTask, submitTarget, projectRoot, config.remote.git_remote);
  if (recorded.kind === 'unreadable') {
    return empty(recordedBaseUnreadableRefusal(task, recorded.comparison, recorded.reason), targetBranch);
  }
  // A linked task's PR is never moved (submitTask refuses), so say so here.
  if (recorded.kind === 'mismatch' && isLinkedTask(task)) {
    return empty(linkedReviewBaseRefusal(task, recorded.base, recorded.comparison), targetBranch);
  }
  const retargetNeeded = recorded.kind === 'mismatch';

  let existingPrUrl: string | null = null;
  if (driver.hasRemoteRef(recordTask)) {
    try {
      existingPrUrl = await driver.getTaskUrl(recordTask);
    } catch {
      // Forge lookup failed — treat as no existing PR so confirmation
      // escalates to the strong tier rather than silently staying plain.
      existingPrUrl = null;
    }
  } else if (sess.git_branch) {
    // A PR/MR a person opened by hand: submit adopts it, so say so up front —
    // or refuse now if its base is not this task's target.
    try {
      const found = await findUnrecordedReview(driver, recordTask, sess.git_branch);
      if (found?.baseBranch) {
        const comparison = await reviewComparisonBranch(submitTarget, projectRoot, config.remote.git_remote);
        if (reviewBaseMismatch(found, comparison)) {
          return empty(mismatchedReviewRefusal(task, found, comparison), targetBranch);
        }
      }
      existingPrUrl = found?.url ?? null;
    } catch (err) {
      // Could not ask: submit asks again and fails loudly there. Fall toward
      // the stronger confirmation meanwhile.
      logger.debug(`submitTaskPreflight: open PR/MR lookup for ${sess.git_branch} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  let targetIsProtected: boolean | 'unknown' = 'unknown';
  let unknownReason: string | undefined;
  if (intermediate) {
    // A task branch is never protected — no network question to ask. But a
    // NEW PR/MR needs its base on the remote, and submit never pushes it —
    // and so does moving an existing one onto it.
    targetIsProtected = false;
    if (!existingPrUrl || retargetNeeded) {
      try {
        if (!await driver.remoteBranchHead(targetBranch)) {
          return empty(baseNotOnRemoteRefusal(task, targetBranch, config.remote.git_remote), targetBranch);
        }
      } catch (err) {
        return empty(
          `Could not check whether \`${targetBranch}\` is on ${config.remote.git_remote}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
          targetBranch,
        );
      }
    }
  } else {
    try {
      targetIsProtected = await driver.isTargetBranchProtected(targetBranch);
    } catch (err) {
      targetIsProtected = 'unknown';
      unknownReason = err instanceof Error ? err.message : String(err);
    }
  }

  const base = {
    canSubmit: true,
    targetBranch,
    taskCode: task.code ?? null,
    targetIsProtected,
    unknownReason,
    existingPrUrl,
    forgeName,
    intermediate,
  };
  return {
    ...base,
    confirmationTier: submitTierFromPreflight(base),
  };
}
