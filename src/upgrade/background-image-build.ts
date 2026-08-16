/**
 * Background container-image rebuild for `lazy upgrade`.
 *
 * WHY THIS EXISTS
 *
 * An upgrade spends most of its wall-clock time NOT building: waiting for
 * working agents to block, and waiting for the human to answer "stop now / wait
 * / cancel". The image rebuild depends on neither — it reads the Dockerfile, not
 * the tasks — so serialising it behind them wasted minutes on every upgrade.
 * This starts the rebuild the moment the upgrade knows it will need one, and
 * the foreground flow collects the result at the point where it used to build.
 *
 * TWO PROPERTIES MAKE THAT SAFE
 *
 * 1. It cannot disturb anything running. The build writes a STAGING tag
 *    (`<repo>:<major.minor>-upgrade`), never the canonical one. Containers hold
 *    their image by ID at launch, and any container created while the build is
 *    in flight resolves the canonical tag — i.e. the current image. Nothing a
 *    running builder or agent sees changes until we promote.
 * 2. It is undoable. The canonical tags only move in `promote()`, which the
 *    upgrade calls after the human has committed to the upgrade. A cancel (or a
 *    crash) therefore leaves `lazy-runner:<major.minor>` exactly where it was; we
 *    drop the staging tag and the built layers remain in the runtime's build
 *    cache, so the next upgrade is warm rather than starting over.
 *
 * FAILURES ARE LOUD (CLAUDE.md: no silent fallbacks). A failed background build
 * fails the upgrade — it never falls back to "keep the old image and carry on",
 * which would silently produce an upgrade that upgraded nothing.
 */

import { IMAGE_TAG, buildProjectImageToTag, resolveImageBuildTags, tagImage, removeImageTag } from '../capture/claude';

/** Tag suffix for the not-yet-promoted build. Deliberately deterministic:
 * a leftover from a crashed upgrade is overwritten by the next one rather than
 * accumulating one orphan tag per attempt. */
export const STAGING_TAG_SUFFIX = '-upgrade';

export function stagingTagFor(imageTag: string = IMAGE_TAG): string {
  return `${imageTag}${STAGING_TAG_SUFFIX}`;
}

export type BackgroundBuildState = 'building' | 'succeeded' | 'failed' | 'cancelled';

/** Injection seam for tests — the real implementations hit the container runtime. */
export interface BackgroundImageBuildDeps {
  build: (tag: string, signal: AbortSignal) => Promise<string>;
  canonicalTags: () => Promise<string[]>;
  tag: (sourceRef: string, targetRefs: string[]) => Promise<void>;
  untag: (ref: string) => Promise<boolean>;
  now: () => number;
}

function defaultDeps(root: string, binary: string): BackgroundImageBuildDeps {
  return {
    // --no-cache for the same reason the foreground rebuild used it: the
    // Dockerfile TEXT is unchanged when a new Claude Code ships, so only busting
    // the cache actually re-fetches it.
    build: (tag, signal) => buildProjectImageToTag(root, tag, { binary, noCache: true, signal }),
    canonicalTags: () => resolveImageBuildTags(root),
    tag: (sourceRef, targetRefs) => tagImage(sourceRef, targetRefs, binary),
    untag: ref => removeImageTag(ref, binary),
    now: () => Date.now(),
  };
}

export class BackgroundImageBuild {
  private state: BackgroundBuildState = 'building';
  private failure: Error | null = null;
  private builtRef: string | null = null;
  private readonly controller = new AbortController();
  private readonly startedAt: number;
  private readonly settled: Promise<void>;
  private promoted = false;

  constructor(
    readonly stagingTag: string,
    private readonly deps: BackgroundImageBuildDeps,
  ) {
    this.startedAt = deps.now();
    // The promise is consumed by finish()/cancel(), but those may never be
    // reached (an early process.exit). Swallowing the rejection HERE — while
    // recording it — is what keeps a failed build from surfacing as an
    // unhandled rejection; `finish()` re-throws it with context.
    this.settled = this.deps
      .build(this.stagingTag, this.controller.signal)
      .then(ref => {
        this.builtRef = ref;
        this.state = this.controller.signal.aborted ? 'cancelled' : 'succeeded';
      })
      .catch(err => {
        this.failure = err instanceof Error ? err : new Error(String(err));
        this.state = this.controller.signal.aborted ? 'cancelled' : 'failed';
      });
  }

  /** Current state without blocking — lets the caller abort BEFORE it stops anything. */
  status(): BackgroundBuildState {
    return this.state;
  }

  error(): Error | null {
    return this.failure;
  }

  /** Seconds elapsed since the build started. */
  elapsedSeconds(): number {
    return Math.max(0, Math.round((this.deps.now() - this.startedAt) / 1000));
  }

  /**
   * Wait for the build to finish. Throws (loudly, with context) if it failed —
   * the upgrade must not continue onto a stale image.
   */
  async finish(): Promise<string> {
    await this.settled;
    if (this.state === 'succeeded' && this.builtRef) return this.builtRef;
    const detail = this.failure ? this.failure.message : 'the build did not complete';
    throw new Error(
      `Background container image rebuild failed: ${detail}\n` +
      `The image was built to the staging tag "${this.stagingTag}" and was NOT promoted, so ` +
      `your current image is untouched. Re-run \`lazy upgrade\` once the build problem is fixed.`
    );
  }

  /**
   * Move the canonical tag(s) onto the staged image and drop the staging tag.
   * Called only after the human has committed to the upgrade. Returns the
   * canonical refs now pointing at the new image.
   */
  async promote(): Promise<string[]> {
    const stagedRef = await this.finish();
    const canonical = await this.deps.canonicalTags();
    await this.deps.tag(stagedRef, canonical);
    this.promoted = true;
    // Cosmetic cleanup: the layers are now reachable through the canonical tag.
    await this.deps.untag(stagedRef);
    return canonical;
  }

  /**
   * Abandon the build (upgrade cancelled or aborted). Kills the build client,
   * waits for it to settle, and removes the staging tag if one was written.
   * Never throws — this runs on paths that are already unwinding.
   */
  async cancel(): Promise<void> {
    if (this.promoted) return;
    this.controller.abort();
    try {
      await this.settled;
    } catch {
      // settled never rejects (the constructor records failures instead), but
      // stay defensive: a cancel path must not throw over the real reason we
      // are unwinding.
    }
    if (this.state !== 'failed') this.state = 'cancelled';
    try {
      await this.deps.untag(await this.stagedRepoRef());
    } catch {
      // Removing a staging TAG is cosmetic — its layers live in the build cache
      // either way, and a runtime hiccup here must not mask the cancellation.
    }
  }

  private async stagedRepoRef(): Promise<string> {
    if (this.builtRef) return this.builtRef;
    // Build never got as far as reporting its ref — derive it from the
    // canonical repository so a partially-written tag is still cleaned up.
    const [canonical] = await this.deps.canonicalTags();
    const repository = canonical.split(':')[0];
    return `${repository}:${this.stagingTag}`;
  }
}

/**
 * Kick off the rebuild now and return a handle. The build runs while the caller
 * keeps doing foreground work (prompting, waiting on agents, stopping containers).
 */
export function startBackgroundImageBuild(
  root: string,
  binary: string,
  deps?: Partial<BackgroundImageBuildDeps>,
): BackgroundImageBuild {
  return new BackgroundImageBuild(stagingTagFor(), { ...defaultDeps(root, binary), ...deps });
}
