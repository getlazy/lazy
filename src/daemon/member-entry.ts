/**
 * A member entering a task's environment on a shared daemon.
 *
 * A member's terminals run in a container of their own
 * (./member-container.ts), never in the task's, so nothing of a turn — its
 * processes, its placeholder, its MCP token — is ever within their reach, and
 * nothing of theirs within a turn's. What the two share is the worktree's
 * files, and they share them AT THE SAME TIME (engineer, 2026-10-21): a member
 * inside a task never holds off a turn, and a running turn never keeps a
 * member out — exactly like `lazy shell <task>` on a laptop, which neither
 * blocks the agent nor is refused while it works. Pairing keeps its own lock
 * (`lazy pair`, a web Pair or Chat — ../server/shell-pair.ts).
 *
 * What still waits for a member is what would REMOVE or REWRITE the worktree
 * underneath their sessions (docs/design/task-sessions-and-ssh.md §1):
 *
 *   - reject, close and redo refuse while a member is inside, naming them
 *     (`beginWorktreeTeardown`), unless the caller confirmed ending their
 *     sessions first;
 *   - an accept of the task itself merges and marks it complete, then ends
 *     member sessions in retryable follow-through before worktree cleanup;
 *   - a child's accept into this task only warns (a comment on the task).
 *
 * The task's OWN container is left running while members are inside: it is
 * where the task's SHARED services run (Start services, ./serve-run.ts).
 *
 * The threat model that makes this acceptable: everything in a task's
 * container is suspect and contained. The worst a process a turn left running
 * there can do to a member is plant code in the shared worktree that the
 * member's terminal then runs — code execution INSIDE the member's container,
 * whose one credential is a revocable placeholder — and running the task's
 * own scripts or services already allows exactly that. The boundary that
 * matters is container → daemon/host, and it is enforced elsewhere: git config
 * and hooks are mounted read-only, and the git pointers are validated before
 * the member's launch and before the daemon's own git (./member-git-layout.ts,
 * src/git/container-pointers.ts).
 */

import type { Storage } from '../storage';
import { withTaskLifecycleLock } from './task-lifecycle-lock';
import { getTaskSessionBinding, type SessionCredentialBinding } from './session-credentials';
import { endMemberSessions, joinNames, markMemberTerminalEntered, membersInsideTask, memberInsideTeardownMessage } from '../server/member-terminals';
import { RpcError } from './rpc-error';
import { isTerminalStatus } from '../task-state-machine';
import { logger } from '../utils/logger';
import { memberInventoryPending } from './member-recovery';

/**
 * Tasks whose worktree is about to be removed — a reject, close or redo
 * tearing it down — with how many such claims are open. A member's entry is
 * refused while a task has one, so nothing can get in between the claim's
 * member check and the removal. Counted, because two claims can overlap and
 * the first to finish must not let members back in under the other.
 */
const worktreeClaims = new Map<string, number>();

/**
 * Claim a task's worktree for a removal a member must not be working under:
 * refuse (409, naming them) while a member has sessions open in it — or, when
 * the caller CONFIRMED it (`endSessions`), end those sessions first — and
 * otherwise keep members out until `release` is called (once; later calls do
 * nothing). Under the task's lifecycle lock, like the entry it excludes. Never
 * consulted by a turn.
 *
 * Used by reject, close and redo on the task itself. An accept needs none of
 * this: its merge never waits for a member, and its follow-through ends member
 * sessions before cleaning up the worktree; a child's accept into this task only warns.
 */
export async function beginWorktreeTeardown(taskId: string, opts: { endSessions?: boolean } = {}): Promise<() => void> {
  return withTaskLifecycleLock(taskId, async () => {
    const holders = membersInsideTask(taskId);
    if (holders.length > 0 && !opts.endSessions) throw new RpcError(409, memberInsideTeardownMessage(holders));
    if (holders.length > 0) {
      const who = joinNames(holders);
      try {
        await endMemberSessions(taskId);
      } catch (err) {
        throw new RpcError(503, `Could not end the sessions of ${who} in this task: ${err instanceof Error ? err.message : String(err)}. Nothing was removed; it is being retried — try again in a moment.`);
      }
      logger.info(`[${taskId.substring(0, 8)}] Ended the sessions of ${who} before removing the task's worktree (confirmed by the caller).`);
    }
    worktreeClaims.set(taskId, (worktreeClaims.get(taskId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (worktreeClaims.get(taskId) ?? 1) - 1;
      if (left > 0) worktreeClaims.set(taskId, left);
      else worktreeClaims.delete(taskId);
    };
  });
}

/**
 * Is a turn running on this task — its status is `working`, or its credential
 * binding is live (a launch has bound it, whether or not the status has
 * flipped yet)?
 */
export async function taskTurnRunning(
  projectRoot: string,
  storage: Pick<Storage, 'getTask'>,
  taskId: string,
  bindingFor: (taskId: string) => Promise<Pick<SessionCredentialBinding, 'revokedAt'> | null> = (id) => getTaskSessionBinding(projectRoot, id),
): Promise<boolean> {
  const task = await storage.getTask(taskId);
  if (task?.status === 'working') return true;
  const binding = await bindingFor(taskId);
  return !!binding && binding.revokedAt === null;
}

export interface EnterTaskDeps {
  /** Seam for tests; defaults to marking the in-memory hold. */
  markEntered?: (taskId: string, email: string) => void;
}

/**
 * Let a member in, under the task's lifecycle lock, or say why not. The caller
 * has already CLAIMED the task for this member (../server/member-terminals.ts).
 * Nothing about turns is checked: a member and the agent may work the same
 * worktree at once. Refused only when the task has no environment to open yet
 * (never started, no turn), or its worktree is about to be merged away or
 * removed (`merging`, finished, or claimed by a reject/close in flight).
 */
export async function enterTaskAsMember(opts: {
  projectRoot: string;
  storage: Pick<Storage, 'getTask' | 'getSessionByTaskId' | 'getSessionTurns'>;
  taskId: string;
  email: string;
  deps?: EnterTaskDeps;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const { storage, taskId, email } = opts;
  const deps = opts.deps ?? {};
  return withTaskLifecycleLock(taskId, async () => {
    if (memberInventoryPending(opts.projectRoot)) {
      return { ok: false, status: 503, message: 'Your terminal environment is still being recovered after the project restart. Try again shortly.' };
    }
    const task = await storage.getTask(taskId);
    if (!task || task.status === 'backlog') {
      return { ok: false, status: 409, message: `This task has not started yet. Start it, then open the terminal.` };
    }
    // A task being accepted (`merging`), finished, or being torn down by a
    // reject or close: its worktree is about to be merged or removed.
    if (task.status === 'merging' || isTerminalStatus(task.status) || worktreeClaims.has(taskId)) {
      return { ok: false, status: 409, message: `This task is being merged or closed, so its files cannot be opened now.` };
    }
    // A LINKED task sits `blocked` with a session before its first start.
    const session = await storage.getSessionByTaskId(taskId);
    if (!session || (await storage.getSessionTurns(session.id)).length === 0) {
      return { ok: false, status: 409, message: `This task has not run a turn yet. Start it, then open the terminal.` };
    }
    (deps.markEntered ?? markMemberTerminalEntered)(taskId, email);
    return { ok: true };
  });
}
