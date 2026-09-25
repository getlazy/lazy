/**
 * Task-edit service — the daemon-side implementation of the web edit form.
 *
 * It is a thin adapter on purpose: every rule, every validation and the prompt
 * VERSIONING all live in `editTask`, which is also what `lazy edit` and
 * `lazy_edit` call. The web form is a third caller of one implementation, not a
 * second one.
 *
 * See src/server/task-actions.ts for why the port is declared in src/server/.
 */

import { getOrCreateStorage } from './rpc-handlers';
import { editTask } from './edit-task';
import { createTask as daemonCreateTask } from './create-task';
import { launchTask } from './task-launcher';
import {
  stopTask as daemonStopTask,
  closeTask as daemonCloseTask,
  rejectTask as daemonRejectTask,
  resumeTask as daemonResumeTask,
  reopenTask as daemonReopenTask,
  syncTask as daemonSyncTask,
  reparentTask as daemonReparentTask,
  submitTask as daemonSubmitTask,
} from './task-lifecycle';
import { ensureTaskContainer } from './task-container';
import { getTaskUpstreamStatus, formatUpstreamStatusLine, formatUpstreamStatusHtmlLine } from './upstream-status';
import { cloneTask as daemonCloneTask, redoTask as daemonRedoTask, listReparentTargets } from './clone-redo';
import { linkTask as daemonLinkTask } from './link-task';
import { launchReviewTaskAwaited } from './task-lifecycle';
import { submitTaskPreflight } from './submit-preflight';
import type { ProgressEmitter } from './progress';
import type {
  TaskActions,
  TaskCreateInput,
  TaskCreateResult,
  TaskEditInput,
  TaskEditResult,
  TaskLifecycleResult,
  EnsureContainerResult,
  TaskUpstreamStatusView,
  TaskSyncResult,
  TaskReparentResult,
  TaskRedoResult,
  TaskLinkInput,
  TaskLinkResult,
  TaskReviewInput,
  TaskReviewResult,
  TaskCloneInput,
  TaskCloneResult,
  TaskSubmitPreflight,
  TaskSubmitResult,
  TaskReparentTargets,
} from '../server/task-actions';

export function createTaskEditActions(projectRoot: string): TaskActions {
  return {
    async createTask(input: TaskCreateInput): Promise<TaskCreateResult> {
      const storage = await getOrCreateStorage();
      return daemonCreateTask(storage, projectRoot, { ...input, actor: 'human' });
    },

    async editTask(taskId: string, input: TaskEditInput): Promise<TaskEditResult> {
      const storage = await getOrCreateStorage();
      // `actor: 'human'` for the same reason as the lifecycle verbs below: a
      // person in the dashboard is the same channel as a person at the CLI.
      const result = await editTask(storage, projectRoot, { taskId, ...input, actor: 'human' });
      return {
        changes: result.changes,
        ...(result.announcements ? { announcements: result.announcements } : {}),
      };
    },

    // Lifecycle verbs. Same adapter posture as editTask above: the daemon's
    // one implementation of each verb (the functions behind `lazy start` /
    // `stop` / `close` / `reject` / `resume`) does every check and every write;
    // this only narrows the result to what the page needs. `actor: 'human'` —
    // a person in the dashboard is the same channel as a person at the CLI.

    async startTask(taskId: string, onProgress?: ProgressEmitter): Promise<TaskLifecycleResult> {
      // A signed-in person: may use the one-shot usage-pause override.
      const result = await launchTask(projectRoot, { taskId, actor: 'human', usagePauseOverrideEligible: true, onProgress });
      return { warnings: result.warnings };
    },

    async stopTask(taskId: string, reason: string, onProgress?: ProgressEmitter): Promise<TaskLifecycleResult> {
      await daemonStopTask(projectRoot, { taskId, reason, actor: 'human', onProgress });
      return {};
    },

    async closeTask(taskId: string, reason: string, onProgress?: ProgressEmitter): Promise<TaskLifecycleResult> {
      const result = await daemonCloseTask(projectRoot, { taskId, reason, actor: 'human', onProgress });
      return { warnings: result.warnings };
    },

    async rejectTask(taskId: string, reason: string, onProgress?: ProgressEmitter): Promise<TaskLifecycleResult> {
      const result = await daemonRejectTask(projectRoot, { taskId, reason, actor: 'human', onProgress });
      return { warnings: result.warnings };
    },

    async resumeTask(taskId: string, onProgress?: ProgressEmitter): Promise<TaskLifecycleResult> {
      const result = await daemonResumeTask(projectRoot, { taskId, actor: 'human', usagePauseOverrideEligible: true, onProgress });
      return { warnings: result.warnings };
    },

    async reopenTask(taskId: string, reason?: string, _onProgress?: ProgressEmitter): Promise<TaskLifecycleResult> {
      const result = await daemonReopenTask(projectRoot, { taskId, reason, actor: 'human' });
      return {
        warnings: result.hadSession
          ? result.warnings
          : [...result.warnings, 'Task reopened in backlog — start it to begin work.'],
      };
    },

    async ensureContainer(
      taskId: string,
      onProgress?: (detail: string) => void,
    ): Promise<EnsureContainerResult> {
      const result = await ensureTaskContainer(projectRoot, {
        taskId,
        ...(onProgress ? { notify: onProgress } : {}),
      });
      return { containerName: result.containerName, alreadyRunning: result.alreadyRunning };
    },

    async getUpstreamStatus(taskId: string): Promise<TaskUpstreamStatusView> {
      const status = await getTaskUpstreamStatus(projectRoot, taskId);
      return {
        ...status,
        line: formatUpstreamStatusLine(status),
        htmlLine: formatUpstreamStatusHtmlLine(status),
      };
    },

    async syncTask(taskId: string, onProgress?: ProgressEmitter): Promise<TaskSyncResult> {
      const result = await daemonSyncTask(projectRoot, {
        taskId, actor: 'human', usagePauseOverrideEligible: true, onProgress, liftPin: true,
      });
      return { message: result.message, warnings: result.warnings };
    },

    async reparentTask(taskId: string, parent: string, onProgress?: ProgressEmitter): Promise<TaskReparentResult> {
      const result = await daemonReparentTask(projectRoot, { taskId, parent, actor: 'human', onProgress });
      return { message: result.message, warnings: result.warnings };
    },

    async linkTask(input: TaskLinkInput, onProgress?: ProgressEmitter): Promise<TaskLinkResult> {
      const result = await daemonLinkTask(projectRoot, { ...input, actor: 'human', onProgress });
      return {
        taskId: result.taskId,
        displayId: result.displayId,
        goal: result.goal,
        branch: result.branch,
        status: result.status,
        prUrl: result.prUrl,
        warnings: result.warnings,
      };
    },

    async reviewTask(
      taskId: string,
      input: TaskReviewInput,
      onProgress?: ProgressEmitter,
    ): Promise<TaskReviewResult> {
      const result = await launchReviewTaskAwaited(projectRoot, {
        taskId,
        autoFix: input.autoFix,
        actor: 'human',
        // The dashboard's signed-in person: may use the one-shot usage-pause override.
        usagePauseOverrideEligible: true,
        onProgress,
      });
      return { turnNumber: result.turnNumber, warnings: result.warnings };
    },

    async redoTask(taskId: string, reason: string): Promise<TaskRedoResult> {
      const result = await daemonRedoTask(projectRoot, { taskId, reason, actor: 'human' });
      return {
        newTaskId: result.taskId,
        newDisplayId: result.displayId,
        oldDisplayId: result.oldDisplayId,
        imagePinWarning: result.imagePinWarning,
      };
    },

    async cloneTask(taskId: string, input: TaskCloneInput): Promise<TaskCloneResult> {
      const result = await daemonCloneTask(projectRoot, { taskId, ...input, actor: 'human' });
      return {
        newTaskId: result.taskId,
        newDisplayId: result.displayId,
        imagePinWarning: result.imagePinWarning,
      };
    },

    async submitPreflight(taskId: string): Promise<TaskSubmitPreflight> {
      return submitTaskPreflight(projectRoot, taskId, 'human');
    },

    async submitTask(taskId: string): Promise<TaskSubmitResult> {
      const result = await daemonSubmitTask(projectRoot, { taskId, actor: 'human' });
      return { prUrl: result.prUrl, displayId: result.displayId, warnings: result.warnings };
    },

    async listReparentTargets(exceptTaskId?: string): Promise<TaskReparentTargets> {
      return listReparentTargets(projectRoot, exceptTaskId);
    },
  };
}
