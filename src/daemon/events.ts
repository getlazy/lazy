/**
 * Daemon event routing — transient signals routed by task graph, delivered via SSE.
 *
 * Events are NOT stored. The daemon routes them in real-time based on the task
 * graph. Supervisors receive events via SSE connections.
 *
 * Design:
 * - In-memory routing table: taskId → SSE connection
 * - Events are fire-and-forget: if no connection exists, the event is dropped
 * - Heartbeat every 30s to detect dead connections
 * - Catchup on reconnect: derive current state from storage, push signals
 */

import type { Storage } from '../storage/interface';
import { logger } from '../utils/logger';
import { getCurrentSha, branchExists } from '../git/operations';
import { getWorktreePathForRef, taskRef } from '../cli/helpers';
import type { Task, TaskStatus } from '../types/index';

// --- Event Types ---

export type DaemonEventType =
  | 'upstream.updated'           // parent branch has new commits (flows down to children)
  | 'task.completed'             // child finished its turn and is blocked (flows up to parent)
  | 'task.accepted'              // child was merged into parent (flows up + laterally to siblings)
  | 'task.failed'                // child errored or got stuck (flows up to parent)
  | 'auto-react.ci_failure'      // CI failure detected, task auto-unblocked
  | 'auto-react.comment'         // PR comment detected, task auto-unblocked
  | 'auto-react.budget_exhausted'; // auto-react blocked by budget limits

export interface DaemonEvent {
  type: DaemonEventType;
  source_task_id: string;
  payload: Record<string, unknown>;
}

// --- SSE Connection ---

export interface SSEConnection {
  taskId: string;
  controller: ReadableStreamDefaultController;
  connectedAt: number;
  lastHeartbeat: number;
}

// --- Routing Table ---

/** In-memory map of active SSE connections. taskId → SSE connection. */
const connections = new Map<string, SSEConnection>();

/** Heartbeat interval handle */
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Register an SSE connection for a task.
 * If a connection already exists for this task, the old one is replaced.
 */
export function registerConnection(taskId: string, controller: ReadableStreamDefaultController): SSEConnection {
  // Close existing connection if any
  const existing = connections.get(taskId);
  if (existing) {
    try {
      existing.controller.close();
    } catch {
      // Already closed
    }
  }

  const conn: SSEConnection = {
    taskId,
    controller,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  connections.set(taskId, conn);

  logger.debug(`SSE: registered connection for task ${taskId.substring(0, 8)}`);

  // Start heartbeat loop if not already running
  if (!heartbeatInterval) {
    heartbeatInterval = setInterval(sendHeartbeats, HEARTBEAT_INTERVAL_MS);
  }

  return conn;
}

/**
 * Remove an SSE connection for a task.
 */
export function removeConnection(taskId: string): void {
  const conn = connections.get(taskId);
  if (conn) {
    try {
      conn.controller.close();
    } catch {
      // Already closed
    }
    connections.delete(taskId);
    logger.debug(`SSE: removed connection for task ${taskId.substring(0, 8)}`);
  }

  // Stop heartbeat loop if no connections remain
  if (connections.size === 0 && heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Get the number of active SSE connections (for monitoring/testing).
 */
export function getConnectionCount(): number {
  return connections.size;
}

/**
 * Check if a task has an active SSE connection.
 */
export function hasConnection(taskId: string): boolean {
  return connections.has(taskId);
}

/**
 * Send an event to a specific task's SSE connection.
 * Returns true if the event was delivered, false if no connection or delivery failed.
 */
export function sendEvent(taskId: string, event: DaemonEvent): boolean {
  const conn = connections.get(taskId);
  if (!conn) return false;

  try {
    const data = JSON.stringify(event);
    conn.controller.enqueue(`event: ${event.type}\ndata: ${data}\n\n`);
    logger.debug(`SSE: sent ${event.type} to task ${taskId.substring(0, 8)}`);
    return true;
  } catch (err) {
    // Connection is dead — remove it
    logger.debug(`SSE: failed to send to task ${taskId.substring(0, 8)}, removing connection`);
    removeConnection(taskId);
    return false;
  }
}

/**
 * Send heartbeat comments to all active connections.
 * Removes connections that fail to receive the heartbeat.
 */
function sendHeartbeats(): void {
  const now = Date.now();
  for (const [taskId, conn] of connections) {
    try {
      conn.controller.enqueue(`: heartbeat\n\n`);
      conn.lastHeartbeat = now;
    } catch {
      logger.debug(`SSE: heartbeat failed for task ${taskId.substring(0, 8)}, removing`);
      removeConnection(taskId);
    }
  }
}

// --- Event Routing Logic ---

/**
 * Route events based on task state changes detected during reconciliation.
 *
 * Called from the daemon reconcile loop after reconcileTasks() completes.
 * Compares "before" and "after" snapshots to detect transitions.
 */
export function routeStateChangeEvents(
  storage: Storage,
  stateChanges: StateChange[],
): void {
  for (const change of stateChanges) {
    routeStateChange(storage, change);
  }
}

export interface StateChange {
  taskId: string;
  previousStatus: TaskStatus;
  currentStatus: TaskStatus;
  parentTaskId: string | null;
}

/**
 * Route events for a single task state change.
 */
function routeStateChange(storage: Storage, change: StateChange): void {
  const { taskId, previousStatus, currentStatus, parentTaskId } = change;

  // task.completed: working → blocked (turn finished, notify parent)
  if (previousStatus === 'working' && currentStatus === 'blocked') {
    if (parentTaskId) {
      sendEvent(parentTaskId, {
        type: 'task.completed',
        source_task_id: taskId,
        payload: { status: currentStatus },
      });
    }
  }

  // task.completed: working → conflict (turn finished with violations)
  if (previousStatus === 'working' && currentStatus === 'conflict') {
    if (parentTaskId) {
      sendEvent(parentTaskId, {
        type: 'task.completed',
        source_task_id: taskId,
        payload: { status: currentStatus },
      });
    }
  }

  // task.failed: working → interrupted (agent crashed)
  if (previousStatus === 'working' && currentStatus === 'interrupted') {
    if (parentTaskId) {
      sendEvent(parentTaskId, {
        type: 'task.failed',
        source_task_id: taskId,
        payload: { status: currentStatus },
      });
    }
  }
}

/**
 * Route events when a task is accepted (merged into parent).
 *
 * Called by the reconcile loop when it detects a task transition to complete
 * or by accept handlers.
 *
 * Sends:
 * - task.accepted → parent supervisor
 * - upstream.updated → all active sibling supervisors
 */
export async function routeAcceptedEvents(
  storage: Storage,
  acceptedTaskId: string,
  parentTaskId: string,
): Promise<void> {
  // Notify parent
  sendEvent(parentTaskId, {
    type: 'task.accepted',
    source_task_id: acceptedTaskId,
    payload: {},
  });

  // Notify siblings (other children of the same parent) with upstream.updated
  try {
    const siblings = await storage.getChildTasks(parentTaskId);
    for (const sibling of siblings) {
      if (sibling.id === acceptedTaskId) continue;
      // Only notify siblings that have active SSE connections
      if (hasConnection(sibling.id)) {
        sendEvent(sibling.id, {
          type: 'upstream.updated',
          source_task_id: acceptedTaskId,
          payload: { reason: 'sibling_accepted' },
        });
      }
    }
  } catch (err) {
    logger.debug(`SSE: failed to notify siblings of accepted task: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Route upstream.updated events to all active children of a task.
 *
 * Called when the parent branch has new commits that children should know about.
 */
export async function routeUpstreamUpdated(
  storage: Storage,
  parentTaskId: string,
  reason: string,
): Promise<void> {
  try {
    const children = await storage.getChildTasks(parentTaskId);
    for (const child of children) {
      if (hasConnection(child.id)) {
        sendEvent(child.id, {
          type: 'upstream.updated',
          source_task_id: parentTaskId,
          payload: { reason },
        });
      }
    }
  } catch (err) {
    logger.debug(`SSE: failed to route upstream.updated: ${err instanceof Error ? err.message : err}`);
  }
}

// --- Catchup on Reconnect ---

/**
 * Perform state reconciliation when a supervisor connects (or reconnects).
 *
 * Checks current state and pushes any signals the supervisor might have missed:
 * - If parent branch has commits the task hasn't merged → upstream.updated
 * - If children completed while supervisor was disconnected → task.completed for each
 *
 * This is NOT event replay — it derives signals from current state.
 */
export async function sendCatchupEvents(
  storage: Storage,
  taskId: string,
  lazyRoot: string,
): Promise<void> {
  try {
    const task = await storage.getTask(taskId);
    if (!task) return;

    // Check if parent branch has new commits
    if (task.parent_task_id) {
      await checkParentBranchAdvanced(storage, task, lazyRoot);
    }

    // Check for completed children
    await checkCompletedChildren(storage, taskId);
  } catch (err) {
    logger.debug(`SSE: catchup failed for task ${taskId.substring(0, 8)}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Check whether a task's parent branch has commits that the task branch
 * hasn't merged yet. Returns the parent tip SHA if ahead, null otherwise.
 *
 * This is a stateless check — it compares the merge-base to the parent
 * branch tip using only git state. Safe to call repeatedly without risk
 * of duplicating actions (caller is responsible for dedup/delivery).
 */
export async function isParentBranchAhead(
  storage: Storage,
  task: Task,
  lazyRoot: string,
): Promise<{ ahead: boolean; parentTip: string | null }> {
  if (!task.parent_task_id) return { ahead: false, parentTip: null };

  const session = await storage.getSessionByTaskId(task.id);
  if (!session?.git_branch) return { ahead: false, parentTip: null };

  const parentTask = await storage.getTask(task.parent_task_id);
  if (!parentTask) return { ahead: false, parentTip: null };

  const parentRef = taskRef(parentTask);
  const parentBranch = `lazy/${parentRef}`;

  if (!await branchExists(parentBranch, lazyRoot) || !await branchExists(session.git_branch, lazyRoot)) {
    return { ahead: false, parentTip: null };
  }

  try {
    const { runGit } = await import('../utils/git');
    const mergeBase = await runGit(['merge-base', session.git_branch, parentBranch], { cwd: lazyRoot });
    if (mergeBase.exitCode !== 0) return { ahead: false, parentTip: null };

    const parentTip = await runGit(['rev-parse', parentBranch], { cwd: lazyRoot });
    if (parentTip.exitCode !== 0) return { ahead: false, parentTip: null };

    const tip = parentTip.stdout.trim();
    const ahead = mergeBase.stdout.trim() !== tip;
    return { ahead, parentTip: tip };
  } catch {
    return { ahead: false, parentTip: null };
  }
}

/**
 * Check if the parent branch has commits that the task branch hasn't merged.
 * If so, send an upstream.updated event via SSE.
 */
async function checkParentBranchAdvanced(
  storage: Storage,
  task: Task,
  lazyRoot: string,
): Promise<void> {
  const { ahead } = await isParentBranchAhead(storage, task, lazyRoot);
  if (ahead && task.parent_task_id) {
    sendEvent(task.id, {
      type: 'upstream.updated',
      source_task_id: task.parent_task_id,
      payload: { reason: 'catchup' },
    });
  }
}

/**
 * Check for children that completed while this supervisor was disconnected.
 * Send task.completed for each.
 */
async function checkCompletedChildren(
  storage: Storage,
  taskId: string,
): Promise<void> {
  const children = await storage.getChildTasks(taskId);
  for (const child of children) {
    if (child.status === 'blocked' || child.status === 'conflict') {
      // Child has completed a turn — notify
      sendEvent(taskId, {
        type: 'task.completed',
        source_task_id: child.id,
        payload: { status: child.status },
      });
    }
    if (child.status === 'interrupted') {
      sendEvent(taskId, {
        type: 'task.failed',
        source_task_id: child.id,
        payload: { status: child.status },
      });
    }
  }
}

// --- Cleanup ---

/**
 * Stop all SSE connections and clean up. Called on daemon shutdown.
 */
export function stopAllConnections(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  for (const [taskId, conn] of connections) {
    try {
      conn.controller.close();
    } catch {
      // Already closed
    }
  }
  connections.clear();

  logger.debug('SSE: all connections stopped');
}

/**
 * Reset all state. Used in tests.
 */
export function _resetEventState(): void {
  stopAllConnections();
}
