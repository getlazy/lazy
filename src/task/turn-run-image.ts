/**
 * Which runner image a task's containers were LAUNCHED from, and therefore
 * which image a turn actually ran on (src/daemon/runner-image-choice.ts writes
 * these records; storage stamps every agent turn from them).
 *
 * Zero-import on purpose: storage reads it at turn write, and the daemon's
 * runner-image rules read it for banners and the recreate decision.
 */
import type { Task } from '../types';

/** Task metadata key: JSON {@link RunImage} of the newest WORK-container launch. */
export const RUNNER_IMAGE_LAST_META_KEY = 'runner_image_last';

/**
 * Task metadata key: JSON map of container (run) name → the image that run was
 * launched from. The work container, the review container and the accept gate
 * each keep their own entry, so a turn is stamped with the image of the
 * container that ran it — including a reused one, which keeps its launch image.
 */
export const RUNNER_IMAGE_RUNS_META_KEY = 'runner_image_runs';

export interface RunImage {
  image: string;
  /**
   * `custom` the project's image; `fallback` lazy's default image because a
   * person chose it; `readonly` lazy's default image for a read-only turn (ask,
   * review) while the project's image was not ready — nobody's choice;
   * `pinned` a consented per-task pin; `standard` lazy's default image in a
   * project that configures no custom one.
   */
  kind: 'custom' | 'fallback' | 'pinned' | 'standard' | 'readonly';
  at: string;
}

function parse<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A hand-damaged value is "no record": a turn then carries no image, which
    // renders as unknown — never as a guess.
    return null;
  }
}

export function readLastLaunchImage(task: Task): RunImage | null {
  const parsed = parse<RunImage>(task.metadata?.[RUNNER_IMAGE_LAST_META_KEY]);
  return parsed && typeof parsed.image === 'string' && typeof parsed.kind === 'string' ? parsed : null;
}

export function readRunImages(task: Task): Record<string, RunImage> {
  const parsed = parse<Record<string, RunImage>>(task.metadata?.[RUNNER_IMAGE_RUNS_META_KEY]);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/** Whether a run name is the task's WORK container (not its reviewer or accept gate). */
export function isWorkRunName(containerName: string): boolean {
  return !containerName.startsWith('lazy-review-') && !containerName.startsWith('lazy-gate-');
}

/**
 * The image a turn about to be recorded ran on: the newest recorded launch of
 * the container that runs that turn type — a review in its own container,
 * every other type (work, ask, sync, nudge, fix) in the work container. Null
 * when nothing was recorded.
 */
export function turnRunImage(task: Task, turnType: string | undefined, reviewDispatch?: string): RunImage | null {
  const entries = Object.entries(readRunImages(task));
  const newest = (pred: (name: string) => boolean): RunImage | null =>
    entries.filter(([name]) => pred(name)).sort((a, b) => b[1].at.localeCompare(a[1].at))[0]?.[1] ?? null;
  // A SELF-review (the low-high loop's) runs inside the work turn, in the work
  // container; only a dispatched reviewer has a container of its own.
  if (turnType === 'review' && reviewDispatch !== 'self') return newest((n) => n.startsWith('lazy-review-'));
  return newest(isWorkRunName) ?? readLastLaunchImage(task);
}
