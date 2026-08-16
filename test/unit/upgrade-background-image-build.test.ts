/**
 * `lazy upgrade` starts the container image rebuild in the background while the
 * human decides and working agents wind down. These tests pin the properties
 * that make that safe:
 *
 *   - the build writes a STAGING tag, never the canonical one;
 *   - the canonical tag moves ONLY on promote(), i.e. after the human committed;
 *   - a cancelled upgrade leaves the canonical tag untouched and drops the
 *     staging tag (layers stay in the runtime's build cache);
 *   - a failed build is loud — no silent fallback to the old image.
 */

import { describe, test, expect } from 'bun:test';
import {
  BackgroundImageBuild,
  stagingTagFor,
  STAGING_TAG_SUFFIX,
  type BackgroundImageBuildDeps,
} from '../../src/upgrade/background-image-build';

interface Recorder {
  deps: BackgroundImageBuildDeps;
  tagged: Array<{ source: string; targets: string[] }>;
  untagged: string[];
  builtTags: string[];
  /** Resolve/reject the in-flight build. */
  finish: (ref: string) => void;
  fail: (err: Error) => void;
  aborted: () => boolean;
}

function recorder(canonical = ['lazy-runner:9.9.9', 'lazy-runner:latest']): Recorder {
  const tagged: Array<{ source: string; targets: string[] }> = [];
  const untagged: string[] = [];
  const builtTags: string[] = [];
  let resolveBuild!: (ref: string) => void;
  let rejectBuild!: (err: Error) => void;
  let signal: AbortSignal | null = null;
  let clock = 0;

  const deps: BackgroundImageBuildDeps = {
    build: (tag, sig) => {
      builtTags.push(tag);
      signal = sig;
      return new Promise<string>((resolve, reject) => {
        resolveBuild = resolve;
        rejectBuild = reject;
        sig.addEventListener('abort', () => reject(new Error('killed')), { once: true });
      });
    },
    canonicalTags: async () => canonical,
    tag: async (source, targets) => { tagged.push({ source, targets }); },
    untag: async ref => { untagged.push(ref); return true; },
    now: () => (clock += 1000),
  };

  return {
    deps,
    tagged,
    untagged,
    builtTags,
    finish: ref => resolveBuild(ref),
    fail: err => rejectBuild(err),
    aborted: () => signal?.aborted ?? false,
  };
}

describe('background image build for lazy upgrade', () => {
  test('builds to a staging tag derived from the canonical image tag', () => {
    expect(stagingTagFor('0.21.0')).toBe(`0.21.0${STAGING_TAG_SUFFIX}`);

    const rec = recorder();
    const build = new BackgroundImageBuild(stagingTagFor('0.21.0'), rec.deps);

    expect(rec.builtTags).toEqual(['0.21.0-upgrade']);
    expect(build.status()).toBe('building');
    // Nothing canonical has been touched just by starting the build.
    expect(rec.tagged).toEqual([]);
  });

  // INVARIANT: the canonical image tag moves only when the upgrade promotes,
  // i.e. after the human has committed. A build that merely FINISHED must not
  // have repointed anything — otherwise a cancelled upgrade would still have
  // swapped the image out from under future container launches.
  test('a finished-but-unpromoted build leaves the canonical tags alone', async () => {
    const rec = recorder();
    const build = new BackgroundImageBuild('9.9.9-upgrade', rec.deps);

    rec.finish('lazy-runner:9.9.9-upgrade');
    await build.finish();

    expect(build.status()).toBe('succeeded');
    expect(rec.tagged).toEqual([]);
  });

  test('promote points every canonical tag at the staged image, then drops the staging tag', async () => {
    const rec = recorder(['lazy-runner:9.9.9', 'lazy-runner:latest']);
    const build = new BackgroundImageBuild('9.9.9-upgrade', rec.deps);

    rec.finish('lazy-runner:9.9.9-upgrade');
    const tags = await build.promote();

    expect(tags).toEqual(['lazy-runner:9.9.9', 'lazy-runner:latest']);
    expect(rec.tagged).toEqual([
      { source: 'lazy-runner:9.9.9-upgrade', targets: ['lazy-runner:9.9.9', 'lazy-runner:latest'] },
    ]);
    expect(rec.untagged).toEqual(['lazy-runner:9.9.9-upgrade']);
  });

  // INVARIANT: cancelling an upgrade must be a true no-op on the image.
  test('cancel aborts the build, leaves canonical tags untouched, removes the staging tag', async () => {
    const rec = recorder();
    const build = new BackgroundImageBuild('9.9.9-upgrade', rec.deps);

    await build.cancel();

    expect(rec.aborted()).toBe(true);
    expect(build.status()).toBe('cancelled');
    expect(rec.tagged).toEqual([]);
    expect(rec.untagged).toEqual(['lazy-runner:9.9.9-upgrade']);
  });

  test('cancel after promote is a no-op (the promoted image is not untagged again)', async () => {
    const rec = recorder();
    const build = new BackgroundImageBuild('9.9.9-upgrade', rec.deps);

    rec.finish('lazy-runner:9.9.9-upgrade');
    await build.promote();
    const untaggedAfterPromote = [...rec.untagged];

    await build.cancel();

    expect(rec.untagged).toEqual(untaggedAfterPromote);
    expect(build.status()).toBe('succeeded');
  });

  // INVARIANT: no silent fallback to the old image (CLAUDE.md). A failed
  // background build fails the upgrade, with a message that says the current
  // image is intact and what to do next.
  test('a failed build reports failure and throws an actionable error', async () => {
    const rec = recorder();
    const build = new BackgroundImageBuild('9.9.9-upgrade', rec.deps);

    rec.fail(new Error('Container build failed with exit code 1'));
    // Let the recorded rejection settle before inspecting status().
    await Promise.resolve();
    await Promise.resolve();

    expect(build.status()).toBe('failed');
    expect(build.error()?.message).toContain('exit code 1');

    await expect(build.finish()).rejects.toThrow(/Background container image rebuild failed/);
    await expect(build.promote()).rejects.toThrow(/current image is untouched/);
    // A failed build must never have moved a canonical tag.
    expect(rec.tagged).toEqual([]);
  });

  test('status stays "building" until the build settles', async () => {
    const rec = recorder();
    const build = new BackgroundImageBuild('9.9.9-upgrade', rec.deps);

    expect(build.status()).toBe('building');
    rec.finish('lazy-runner:9.9.9-upgrade');
    await build.finish();
    expect(build.status()).toBe('succeeded');
  });
});
