/**
 * The dashboard's view of the project's own runner image, which the daemon
 * builds when it starts (src/daemon/runner-image.ts), and of a task that runs
 * on lazy's default image instead (src/daemon/runner-image-choice.ts).
 *
 * Every sentence and rule is the daemon's — the dashboard runs inside the
 * daemon and reads the same state the launch gate reads, so this line and the
 * refusal cannot disagree.
 */
import { escapeHtml } from './escape';
import type { Task } from '../types';
import { describeRunnerImage, runnerImageStatus } from '../daemon/runner-image';
import { launchNeedsImageConfirmation, taskRunnerImageView } from '../daemon/runner-image-choice';

/** The dashboard line: building (with the newest build line) or failed (with the reason and a retry). */
export function dashboardRunnerImageHtml(): string {
  const s = runnerImageStatus();
  if (s.state === 'none' || s.state === 'ready') return '';
  // A Rebuild that is replacing a ready image (or failed to) leaves that image
  // in use: nothing falls back to the default image, so do not say it does.
  const fallback = s.state !== 'checking' && s.replacing
    ? ''
    : `Everything except running an agent keeps working. Builders start on lazy's default runner image (${escapeHtml(s.defaultImage)}) meanwhile; a task's agent runs on it only once someone confirms that on the task.`;
  if (s.state === 'failed') {
    return `<div class="rv-warn" id="runner-image-status"><span class="tag tag-warning">runner image</span> ${escapeHtml(describeRunnerImage(s))} ${fallback}
      <form method="post" action="/runner-image/retry" class="usage-pause-allow"><button type="submit" class="btn btn-sm">Build it again</button></form></div>`;
  }
  const progress = s.state === 'building' && s.progress ? `<div class="mono">${escapeHtml(s.progress)}</div>` : '';
  return `<div class="rv-note" id="runner-image-status"><span class="tag">runner image</span> ${escapeHtml(describeRunnerImage(s))} ${fallback}${progress}</div>`;
}

/** The task page's line: the confirmation is needed, or the task runs on the default image. */
export function taskRunnerImageHtml(task: Task, taskPathPrefix: string): string {
  const view = taskRunnerImageView(task, task.status === 'working');
  if (view.needsConfirmation) {
    return `<div class="rv-warn" id="task-runner-image"><span class="tag tag-warning">runner image</span> ${escapeHtml(view.projectDescription)} Launching the agent now needs your confirmation to run it on lazy's default runner image instead — or wait until the project's image is ready.</div>`;
  }
  if (!view.banner) return '';
  const button = view.banner.action === 'use_custom_image'
    ? `<form method="post" action="${escapeHtml(taskPathPrefix)}/runner-image/use-project" class="usage-pause-allow"><button type="submit" class="btn btn-sm">Restart with the project's image</button></form>`
    : '';
  return `<div class="${view.banner.action ? 'rv-note' : 'rv-warn'}" id="task-runner-image"><span class="tag">default image</span> ${escapeHtml(view.banner.text)} ${button}</div>`;
}

/**
 * The Start / Resume / Unblock dialogs' confirmation. Required: while the
 * project's image is not ready the launch is refused without it, and ticking it
 * is the person's choice to run on lazy's default image.
 */
export function runnerImageConfirmCheckboxHtml(task: Task): string {
  if (!launchNeedsImageConfirmation(task)) return '';
  return `<label class="edit-check"><input type="checkbox" name="use_default_image" value="1" required> Run on lazy's default runner image — the project's image is not ready</label>`;
}

/**
 * The Sync dialogs' option. NOT required: a clean merge needs no agent, and a
 * conflict is only known once the merge runs. Ticked, a conflict is resolved
 * on lazy's default image; unticked, a conflicting sync is refused until the
 * project's image is ready.
 */
export function runnerImageSyncCheckboxHtml(task: Task): string {
  if (!launchNeedsImageConfirmation(task)) return '';
  return `<label class="edit-check"><input type="checkbox" name="use_default_image" value="1"> If the merge conflicts, resolve it on lazy's default runner image — the project's image is not ready</label>`;
}
