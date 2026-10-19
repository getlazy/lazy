/**
 * The per-TASK half of the boot-built runner image (src/daemon/runner-image.ts):
 * the explicit confirmation to run on lazy's default image while the project's
 * custom image is not ready, the record of which image each launch actually
 * ran on, the banner every surface renders from that record, and the
 * "restart with the custom image" action.
 *
 * Rules, all deliberate:
 *
 * - **Never silent.** A person-driven launch (start, unblock, resume) on a task
 *   that would use the custom image while it is not ready is REFUSED unless the
 *   caller passed `useDefaultImage` — the CLI's prompt / `--yes`, MCP's
 *   confirmation_code, Teams' confirm button. The confirmation is stored on the
 *   task (`runner_image_choice = default`), so the daemon's own later turns
 *   (auto-resume, auto-deliver) keep the image the person chose.
 * - **Nothing switches back on its own.** Once the custom image is ready the
 *   banner turns into an action; only that action clears the choice. A turn in
 *   flight is never killed for it: the switch takes effect at the task's next
 *   launch, and the banner says so.
 * - **Derived, not guessed.** Each launch records the image it resolved
 *   (`runner_image_last`), and the banner is computed from that record and the
 *   daemon's current image state.
 * - A task with a consented image pin (`custom_image`) is outside all of this:
 *   it runs on its pin, exactly as before.
 */
import type { Storage } from '../storage/interface';
import type { Task } from '../types';
import type { BuilderSession } from '../storage/types';
import { RpcError } from './rpc-error';
import { pinnedCustomImage, launchImagePin, RUNNER_IMAGE_CHOICE_META_KEY } from '../docker/worktree-image';
import { READONLY_DEFAULT_RUNNER_IMAGE_PIN } from '../capture/custom-image-gate';
import { customImageReady, describeRunnerImage, runnerImageStatus, syncRunnerImageTarget, type RunnerImageState } from './runner-image';
import type { LaunchImageKind } from '../capture/custom-image-gate';
import {
  RUNNER_IMAGE_LAST_META_KEY, RUNNER_IMAGE_RUNS_META_KEY, readLastLaunchImage, readRunImages, isWorkRunName,
  type RunImage,
} from '../task/turn-run-image';
export {
  RUNNER_IMAGE_LAST_META_KEY, RUNNER_IMAGE_RUNS_META_KEY, readLastLaunchImage, readRunImages, isWorkRunName, turnRunImage,
} from '../task/turn-run-image';
/** The record of one launch's image (see src/task/turn-run-image.ts). */
export type LastLaunchImage = RunImage;

/** Marker phrase of the refusal — clients (Teams) match on it. */
export const RUNNER_IMAGE_NOT_READY_MARKER = "the project's runner image is not ready";

export function chosenDefaultImage(task: Task): boolean {
  return task.metadata?.[RUNNER_IMAGE_CHOICE_META_KEY] === 'default';
}

/** Turn the launch-side kind into what is recorded. Exported for tests. */
export function classifyLaunchImage(kind: LaunchImageKind, imageName: string, state: RunnerImageState): LastLaunchImage['kind'] {
  if (kind === 'pinned') return 'pinned';
  if (kind === 'default') return 'fallback';
  if (kind === 'readonly-default') return 'readonly';
  return state.state !== 'none' && state.imageName === imageName ? 'custom' : 'standard';
}

export async function recordTaskLaunchImage(
  storage: Storage,
  taskId: string,
  imageName: string,
  kind: LaunchImageKind,
  containerName: string,
): Promise<void> {
  const record: LastLaunchImage = {
    image: imageName,
    kind: classifyLaunchImage(kind, imageName, runnerImageStatus()),
    at: new Date().toISOString(),
  };
  const task = await storage.getTask(taskId);
  const runs = task ? readRunImages(task) : {};
  runs[containerName] = record;
  await storage.updateTaskMetadata(taskId, RUNNER_IMAGE_RUNS_META_KEY, JSON.stringify(runs));
  // The task-level record (banner, recreate rule) follows the WORK container
  // only: a reviewer or the accept gate on another image says nothing about
  // what the task's own turns run on.
  if (isWorkRunName(containerName)) {
    await storage.updateTaskMetadata(taskId, RUNNER_IMAGE_LAST_META_KEY, JSON.stringify(record));
  }
}

/**
 * The image a READ-ONLY turn (ask, review) launches on. Read-only turns never
 * wait and never ask: while the project's image is not ready (and the task
 * has no pin and no recorded default-image choice), they run on lazy's default
 * image for this launch only — the task's choice is NOT written, so nothing
 * pins its future WORK turns to the default image.
 */
export async function readOnlyLaunchPin(task: Task): Promise<string | undefined> {
  const pin = launchImagePin(task);
  if (pin) return pin;
  return (await runnerImageHold(task)) ? READONLY_DEFAULT_RUNNER_IMAGE_PIN : undefined;
}

/** Does a launch of this task need the project's custom image right now, and is it missing? */
export function launchNeedsImageConfirmation(task: Task): boolean {
  if (pinnedCustomImage(task)) return false;
  if (chosenDefaultImage(task)) return false;
  return !customImageReady();
}

/**
 * Called by start / unblock / resume BEFORE anything else happens. Refuses
 * with a marker-bearing 409 when confirmation is needed and was not given;
 * records the confirmation when it was.
 */
export async function confirmRunnerImageForLaunch(storage: Storage, task: Task, useDefaultImage: boolean | undefined): Promise<void> {
  await syncRunnerImageTarget();
  if (!launchNeedsImageConfirmation(task)) return;
  if (useDefaultImage) {
    await storage.updateTaskMetadata(task.id, RUNNER_IMAGE_CHOICE_META_KEY, 'default');
    // The caller launches from THIS object, read before the write: storage
    // persists the choice on its own copy, so without updating the snapshot
    // the very launch that was confirmed still resolves the project's image
    // and is refused by the gate.
    task.metadata = { ...(task.metadata ?? {}), [RUNNER_IMAGE_CHOICE_META_KEY]: 'default' };
    return;
  }
  const s = runnerImageStatus();
  const defaultImage = s.state === 'none' ? "lazy's default image" : s.defaultImage;
  throw new RpcError(
    409,
    `Not launched: ${RUNNER_IMAGE_NOT_READY_MARKER}. ${describeRunnerImage(s)}\n` +
    `Run it now on lazy's default runner image (${defaultImage}) instead, or wait until the project's image is ready. ` +
    `It stays on the default image until you switch it back.`,
    'runner_image_not_ready',
  );
}

export interface TaskRunnerImageView {
  /** The image the newest launch ran on, when recorded. */
  last: LastLaunchImage | null;
  /** Whether a person chose lazy's default image for this task. */
  choseDefault: boolean;
  /** Whether a launch now would need the confirmation. */
  needsConfirmation: boolean;
  /** The daemon's project image state. */
  project: RunnerImageState;
  /** That state in one sentence, for the confirmation. */
  projectDescription: string;
  /** What to show at the top of the task, or null for nothing. */
  banner: null | {
    text: string;
    /** `use_custom_image` → offer "Restart with the custom image". */
    action: 'use_custom_image' | 'restart_builder' | null;
  };
}

/** The banner and the facts behind it — the ANSWER, so no client re-derives it. */
export function taskRunnerImageView(task: Task, running: boolean): TaskRunnerImageView {
  const project = runnerImageStatus();
  const last = readLastLaunchImage(task);
  const choseDefault = chosenDefaultImage(task) && !pinnedCustomImage(task);
  const needsConfirmation = launchNeedsImageConfirmation(task);
  let banner: TaskRunnerImageView['banner'] = null;
  // A finished task launches nothing again: no banner, and no switch to offer.
  const finished = task.status === 'complete' || task.status === 'abandoned';
  if (!finished && (choseDefault || last?.kind === 'fallback')) {
    const runsOnDefault = last?.kind === 'fallback';
    const what = runsOnDefault
      ? `This task runs on lazy's default runner image (${last!.image}), not the project's own image.`
      : `This task's next turn runs on lazy's default runner image, not the project's own image.`;
    if (customImageReady() && choseDefault) {
      banner = {
        text: `${what} The project's image is ready now.` +
          (running ? ' Switching takes effect when the next turn starts; the turn in progress is not interrupted.' : ''),
        action: 'use_custom_image',
      };
    } else if (customImageReady()) {
      // Switched back already; the newest launch predates it.
      banner = { text: `${what} Its next turn uses the project's image.`, action: null };
    } else {
      banner = { text: `${what} ${describeRunnerImage(project)}`, action: null };
    }
  }
  return { last, choseDefault, needsConfirmation, project, projectDescription: describeRunnerImage(project), banner };
}

/**
 * "Restart with the custom image": clear the choice so the task's NEXT launch
 * runs on the project's image. A turn in flight is left alone — killing work
 * to change its environment is not this action's call — and a parked task has
 * no container to restart: every turn launches its own.
 */
export async function useCustomRunnerImage(storage: Storage, task: Task): Promise<{ switched: boolean; message: string }> {
  if (!chosenDefaultImage(task)) {
    return { switched: false, message: 'This task is not on lazy\'s default runner image; nothing to switch.' };
  }
  if (!customImageReady()) {
    throw new RpcError(409, `Cannot switch yet: ${describeRunnerImage()}`);
  }
  await storage.updateTaskMetadata(task.id, RUNNER_IMAGE_CHOICE_META_KEY, '');
  // Same reason as the confirmation: the caller's snapshot must agree.
  task.metadata = { ...(task.metadata ?? {}), [RUNNER_IMAGE_CHOICE_META_KEY]: '' };
  return {
    switched: true,
    message: task.status === 'working'
      ? 'The project\'s image will be used from the next turn; the turn in progress continues on the default image.'
      : 'The project\'s image will be used from the next turn.',
  };
}

/**
 * For the daemon's OWN launches (auto-resume, auto-delivery, auto-react): a
 * task that would need the custom image while it is not ready, and whose
 * person never chose the default image, is HELD — retried on a later pass —
 * rather than launched on an image nobody agreed to or failed. Returns why, or
 * null to go ahead.
 */
export async function runnerImageHold(task: Task): Promise<string | null> {
  await syncRunnerImageTarget();
  const hold = launchNeedsImageConfirmation(task) ? describeRunnerImage() : null;
  if (!hold) releaseImageHoldLog(task.id);
  return hold;
}

/** What each (path, task) last logged as its image hold, so a held task is not re-announced every tick. */
const loggedImageHolds = new Map<string, string>();

/**
 * True when this hold should be logged: the first time a path holds the task,
 * and again only when the reason changed. A release (runnerImageHold returning
 * null) forgets the task, so a later hold is announced afresh.
 */
export function shouldLogImageHold(scope: string, task: Pick<Task, 'id'>, reason: string): boolean {
  const key = `${scope}\u0000${task.id}`;
  if (loggedImageHolds.get(key) === reason) return false;
  loggedImageHolds.set(key, reason);
  return true;
}

function releaseImageHoldLog(taskId: string): void {
  for (const key of [...loggedImageHolds.keys()]) {
    if (key.endsWith(`\u0000${taskId}`)) loggedImageHolds.delete(key);
  }
}

export function resetImageHoldLogForTests(): void {
  loggedImageHolds.clear();
}

/**
 * A builder run's banner. A builder needs no confirmation — it starts on the
 * default image while the project's is not ready — but it is never silent, and
 * it never switches back on its own: once the project's image is ready the
 * banner offers a restart, which resumes the same conversation in a new
 * container (stop, then start).
 */
export function builderRunnerImageBanner(session: Pick<BuilderSession, 'runnerImage' | 'state'>): TaskRunnerImageView['banner'] {
  const ri = session.runnerImage;
  if (!ri || ri.kind !== 'fallback') return null;
  const what = `This builder runs on lazy's default runner image (${ri.image}), not the project's own image.`;
  if (customImageReady()) {
    return {
      text: `${what} The project's image is ready now — restart the builder to use it. The conversation is kept.`,
      action: session.state === 'running' || session.state === 'starting' ? 'restart_builder' : null,
    };
  }
  return { text: `${what} ${describeRunnerImage()}`, action: null };
}

/**
 * Whether a still-running container of this task was launched on a different
 * image than its next launch will use — the default image after the person
 * switched back to the project's (or the reverse). Such a container must be
 * recreated: reusing it would keep the task on the old image while the banner
 * says otherwise. Every launch path's reuse check asks this beside its own
 * credential / agent / env reasons.
 */
export function mustRecreateForRunnerImage(task: Task): boolean {
  const last = readLastLaunchImage(task);
  if (!last || last.kind === 'pinned') return false;
  const nextOnDefault = !pinnedCustomImage(task) && chosenDefaultImage(task);
  if (last.kind === 'fallback') return !nextOnDefault;
  // A work container an ask or review started on the default image (nobody's
  // choice): a WORK turn never inherits it unless the person chose the default.
  if (last.kind === 'readonly') return !nextOnDefault;
  if (last.kind === 'custom') return nextOnDefault;
  return false;
}
