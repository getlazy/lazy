/**
 * Helpers for blocking CLI prompts that may follow long subprocess output.
 *
 * `lazy upgrade` starts a container image rebuild in the background while it
 * still asks the human to choose how to proceed or to confirm builder pre-stop.
 * Docker build progress streams to stdout and scrolls those prompts away — the
 * human ends up staring at "#14 DONE" with no visible instruction to press Enter.
 */

import type { BackgroundImageBuild } from './background-image-build';

/** User-visible reminder printed immediately before a blocking read. */
export const POST_BUILD_ENTER_PROMPT =
  'Image build finished. Press Enter when ready to continue the upgrade (ctrl-c to cancel)';

/** Reminder before a working-task choice when a background build may have streamed. */
export const POST_BUILD_CHOICE_PROMPT =
  'Image build finished. How would you like to proceed?';

/**
 * Wait for a background image build to finish streaming output. No-op when
 * there is no build or it has already settled.
 *
 * Call this immediately before any blocking stdin prompt that can run while the
 * build is still printing — then print the prompt once, below the build noise.
 */
export async function waitForInterveningBuildOutput(
  imageBuild: BackgroundImageBuild | null | undefined,
): Promise<void> {
  if (!imageBuild || imageBuild.status() !== 'building') return;
  await imageBuild.awaitSettled();
}
