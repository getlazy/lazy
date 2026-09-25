/**
 * Interactive adoption prompt when `lazy upgrade` is run from a task worktree.
 *
 * Task worktrees never auto-govern the container image (see
 * src/docker/worktree-image.ts and resolveCustomDockerfile). Developers working
 * on lazy itself often want the *whole system* — image build AND the restarted
 * daemon — to run a release worktree's Dockerfile.lazy until the next binary
 * rebuild. This asks once, on a TTY, before any image build starts, and on yes
 * persists adoption in daemon runtime state (not an env var, not lazy.toml).
 *
 * Part 1's per-task pin lives in src/docker/worktree-image.ts and never touches
 * daemon state. The old env-override path is gone — adoption is the only way
 * a worktree Dockerfile reaches the daemon's image.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { isTTY, promptYesNo } from '../cli/editor';
import { theme } from '../render/theme';
import { consentedBuildIdentity, IMAGE_TAG } from '../capture/image-tag';
import {
  clearAdoptedImage,
  hashDockerfileContent,
  inspectAdoptedImage,
  writeAdoptedImage,
  type AdoptedImageState,
} from '../daemon/adopted-image';
import {
  lazyTaskWorktreeCwd,
  worktreeHead,
  WORKTREE_DOCKERFILE,
} from '../docker/worktree-image';
import { pathExists } from '../utils/fs';

// Re-export so existing imports keep working; the canonical home is
// src/docker/worktree-image.ts (shared with the per-task image prompt).
export { lazyTaskWorktreeCwd } from '../docker/worktree-image';

async function filesEqual(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([readFile(a), readFile(b)]);
    return left.equals(right);
  } catch {
    // Either file unreadable: treat as different so we still ask (safer than
    // silently skipping when we cannot confirm they match).
    return false;
  }
}

/**
 * Ask whether to keep a valid daemon adoption before this rebuild. TTY: prompt
 * (default yes). Non-TTY: keep and print — never silently drop or keep.
 */
async function promptKeepExistingAdoption(
  existing: AdoptedImageState,
): Promise<AdoptedImageState | null> {
  if (isTTY()) {
    console.log('');
    console.log(
      `  Currently adopted: ${theme.command(existing.imageName)} from ${existing.dockerfilePath}`,
    );
    console.log('');

    const keep = await promptYesNo(
      'Keep this adoption for the image build and the daemon?',
      true,
    );
    if (!keep) {
      console.log('  Clearing daemon adoption — the project root Dockerfile will be used.');
      console.log('');
      return null;
    }

    console.log(
      `  ${theme.success('Keeping')} ${existing.imageName} until you decline at a future upgrade.`,
    );
    console.log('');
    return existing;
  }

  // Non-TTY: explicit keep — scripts and CI must not silently lose adoption.
  console.log('');
  console.log(
    `  Keeping daemon-adopted image ${existing.imageName} from ${existing.dockerfilePath} ` +
      '(non-interactive upgrade; re-run from a TTY to change adoption).',
  );
  console.log('');
  return existing;
}

/**
 * Every upgrade that rebuilds re-decides adoption: announce any existing valid
 * adoption (keep or clear), then optionally offer a NEW worktree Dockerfile when
 * cwd is inside that worktree. Call BEFORE any container image build so
 * resolveCustomDockerfile / the build see the final state.
 *
 * SECURITY: a NEW worktree Dockerfile is offered only when cwd is genuinely
 * inside that worktree — never when upgrade runs from the project root alone.
 *
 * Returns the adoption in effect after prompts, or null when none.
 */
export async function maybePromptWorktreeDockerfileAdoption(
  projectRoot: string,
): Promise<AdoptedImageState | null> {
  const inspection = await inspectAdoptedImage(projectRoot);

  // Expired / drifted / missing adoption cannot wedge a rebuild — clear without
  // a keep prompt (inspectAdoptedImage already classifies why).
  if (
    inspection.status === 'expired' ||
    inspection.status === 'missing-dockerfile' ||
    inspection.status === 'content-drifted'
  ) {
    await clearAdoptedImage(projectRoot);
  }

  let currentAdoption =
    inspection.status === 'valid' ? inspection.state : null;

  if (currentAdoption) {
    const kept = await promptKeepExistingAdoption(currentAdoption);
    if (!kept) {
      await clearAdoptedImage(projectRoot);
      currentAdoption = null;
    }
  }

  // New worktree adoption is TTY-only — same security posture as Part 1 pins.
  if (!isTTY()) {
    return currentAdoption;
  }

  const worktreeRoot = await lazyTaskWorktreeCwd(projectRoot);
  if (!worktreeRoot) return currentAdoption;

  const worktreeDockerfile = join(worktreeRoot, WORKTREE_DOCKERFILE);
  if (!(await pathExists(worktreeDockerfile))) return currentAdoption;

  const rootDockerfile = join(projectRoot, WORKTREE_DOCKERFILE);
  if ((await pathExists(rootDockerfile)) && await filesEqual(worktreeDockerfile, rootDockerfile)) {
    return currentAdoption;
  }

  const content = await readFile(worktreeDockerfile, 'utf-8');
  const contentHash = hashDockerfileContent(content);

  // Already adopted this exact content FROM THIS SAME worktree — no need to
  // re-prompt. The path matters as much as the bytes: the image identity covers
  // the build context too, so a byte-identical Dockerfile in another worktree is
  // a different image and must still be offered.
  if (
    currentAdoption?.contentHash === contentHash &&
    currentAdoption.dockerfilePath === worktreeDockerfile
  ) {
    return currentAdoption;
  }

  console.log('');
  console.log(theme.warning('Running `lazy upgrade` from a task worktree.'));
  console.log(`  Directory:  ${worktreeRoot}`);
  console.log(`  Default:    ${rootDockerfile}`);
  console.log(`  Here:       ${worktreeDockerfile}`);
  // Name the build context: adopting consents to a docker build over this whole
  // directory, not just to the Dockerfile on screen.
  console.log(`  Context:    ${worktreeRoot} (this worktree, as it is on disk)`);
  console.log('');
  console.log('  By default the image build uses the project root Dockerfile, not this');
  console.log("  worktree's copy. Adopting builds from the worktree AND keeps the daemon");
  console.log('  and all non-pinned task launches on that image until the next upgrade');
  console.log('  rebuild (binary rebuild + daemon restart) decides again.');
  console.log('');

  const useWorktree = await promptYesNo(
    "Adopt this worktree's Dockerfile.lazy for the image build and the daemon?",
    false,
  );
  if (!useWorktree) {
    console.log('  Using the project root Dockerfile (no new adoption).');
    console.log('');
    return currentAdoption;
  }

  // The image name covers the Dockerfile bytes AND the directory they build
  // against, so the same Dockerfile in two worktrees cannot share one image.
  // contentHash stays a pure content hash: drift detection compares the live
  // worktree file against it.
  const shortHash = consentedBuildIdentity(contentHash, worktreeRoot).substring(0, 12);
  const imageName = `lazy-custom-${shortHash}:${IMAGE_TAG}`;

  // Snapshot the consented bytes at prompt time (adopted-Dockerfile) so the
  // later upgrade build cannot re-read a post-consent agent edit of the
  // worktree file. contextCommit is provenance only — the build reads the
  // worktree live.
  const head = await worktreeHead(worktreeRoot);
  const state = await writeAdoptedImage(
    projectRoot,
    {
      dockerfilePath: worktreeDockerfile,
      contentHash,
      imageName,
      ...(head ? { contextCommit: head } : {}),
    },
    { content },
  );

  console.log(
    `  ${theme.success('Adopted')} ${state.imageName} from ${worktreeDockerfile}` +
      `${head ? ` (HEAD ${head.slice(0, 12)})` : ''}`,
  );
  console.log(
    `  Daemon + launches will use it until the next \`lazy upgrade\` rebuild ` +
      `decides again, or lazy moves off ${IMAGE_TAG} (adopted on lazy ${state.lazyVersion}).`,
  );
  console.log('');

  return state;
}
