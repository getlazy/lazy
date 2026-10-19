/**
 * The seam through which the DAEMON tells `ensureImage` whether the project's
 * custom runner image may be used by a launch.
 *
 * The daemon builds the custom image at boot (src/daemon/runner-image.ts) and
 * owns its state. A launch must never start its own build of that image behind
 * the user's back — not while the boot build runs, and not after it failed — so
 * inside the daemon `ensureImage` asks this gate instead of inspecting and
 * building. Outside the daemon (the CLI's `lazy upgrade`, a local
 * `lazy builder`) nothing is registered and `ensureImage` behaves as it always
 * did.
 *
 * Kept in its own zero-import module so both claude.ts and the daemon can
 * reach it without a load-time cycle.
 */

export interface CustomImageVerdict {
  ready: boolean;
  /** Human-readable state, used as the refusal text when not ready. */
  message: string;
}

export interface CustomImageGate {
  /**
   * Whether `imageName` (the custom image a launch resolved) is ready. A name
   * the gate is not tracking — the Dockerfile changed since boot — must start
   * the daemon's own build and answer not-ready.
   */
  check(imageName: string): CustomImageVerdict;
  /** The image vanished from the runtime although the gate said ready. */
  invalidate(imageName: string): void;
  /** The ready image's inputs (`build_inputs`) changed: rebuild it in the background now. */
  stale(imageName: string): void;
  /** Whether the image the daemon tracks is ready, whatever its name. */
  ready(): boolean;
  /**
   * Re-resolve which custom image the project wants NOW (config + Dockerfile
   * content, no docker call) and, if it differs from the tracked one, start the
   * daemon's build of it — so a readiness question asked right after a
   * Dockerfile edit is answered about the new image, not the old one.
   */
  sync(): Promise<void>;
  /**
   * Rebuild `imageName` (the project's tracked image or lazy's default one)
   * through the daemon's own build, without the cache, after the damaged-image
   * repair removed it — so the build shows on the build page and can be
   * cancelled. Resolves when it succeeded, throws otherwise. Optional: a gate
   * registered after a failed boot has none, and the repair builds inline.
   */
  repair?(imageName: string): Promise<void>;
}

let gate: CustomImageGate | null = null;

export function registerCustomImageGate(g: CustomImageGate | null): void {
  gate = g;
}

export function customImageGate(): CustomImageGate | null {
  return gate;
}

/**
 * True when this process is the daemon and the project's custom image is not
 * ready: a BUILDER-role launch then runs on lazy's default image (builders
 * need no confirmation, but say so), instead of hitting the gate.
 */
export async function customImageNotReady(): Promise<boolean> {
  if (gate === null) return false;
  await gate.sync();
  return !gate.ready();
}

/**
 * A launch asked for the custom image while it is missing, building or failed,
 * and nobody chose the default image. Callers that hold a human turn (start,
 * unblock, resume) check first and ask for confirmation; this is the backstop.
 */
export class RunnerImageNotReadyError extends Error {
  readonly code = 'runner_image_not_ready';
  constructor(message: string) {
    super(message);
    this.name = 'RunnerImageNotReadyError';
  }
}

/**
 * What a launch passes as its `pinnedImage` when a person chose to run the
 * task on lazy's DEFAULT runner image while the project's custom image was not
 * ready (task metadata `runner_image_choice = default`). `ensureImage` reads it
 * as "use the default image"; it never names a real image.
 */
export const DEFAULT_RUNNER_IMAGE_PIN = 'lazy:default-runner-image';

/**
 * A READ-ONLY turn (ask, review) launched on lazy's default image because the
 * project's image is not ready. Resolves exactly like the default-image pin,
 * but is recorded as read-only: it is no choice anybody made, so it shows no
 * banner and pins nothing.
 */
export const READONLY_DEFAULT_RUNNER_IMAGE_PIN = 'lazy:default-runner-image:read-only';

/** Which image a task launch resolved, as recorded on the task. */
export type LaunchImageKind = 'pinned' | 'default' | 'readonly-default' | 'project';

type LaunchImageRecorder = (taskId: string, imageName: string, kind: LaunchImageKind, containerName: string) => Promise<void>;
let recorder: LaunchImageRecorder | null = null;

/** The daemon registers where a task launch's resolved image is recorded. */
export function registerLaunchImageRecorder(r: LaunchImageRecorder | null): void {
  recorder = r;
}

export async function recordLaunchImage(taskId: string | undefined, imageName: string, kind: LaunchImageKind, containerName: string): Promise<void> {
  if (!taskId || !recorder) return;
  await recorder(taskId, imageName, kind, containerName);
}
