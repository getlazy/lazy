/**
 * Runner-image identity and freshness.
 *
 * These tests drive the REAL image logic in src/capture/claude.ts against a fake
 * `docker` binary (test/helpers/fake-docker.ts) rather than the module
 * mock — the module mock replaces `ensureImage` itself, so it can never reach
 * the decision under test.
 *
 * The incident this encodes: a host that had ever built `lazy-runner:latest`
 * kept serving that image forever, so a newer lazy silently ran months-old agent
 * tooling.
 *
 * The FIX for that is not the tag. The image carries the toolchain (bun, Claude
 * Code, Chromium) and not lazy itself, and that toolchain drifts with wall-clock
 * time rather than with lazy's version — so the tag is only an identity, and
 * three separate triggers keep the image fresh:
 *
 *   1. `lazy upgrade` — always, unconditionally, --no-cache
 *   2. age > IMAGE_MAX_AGE_DAYS
 *   3. the Dockerfile text changed (the `lazy.dockerfile.hash` label)
 *
 * One test per trigger below, plus the boundary of (2).
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import {
  ensureImage,
  resolveImageName,
  calculateDockerfileHash,
  listLazyImages,
  isImageTooOld,
  IMAGE_TAG,
  IMAGE_MAX_AGE_DAYS,
  IMAGE_MAX_AGE_MS,
} from '../../src/capture/claude';
import { imageTagFor } from '../../src/capture/image-tag';
import { startBackgroundImageBuild } from '../../src/upgrade/background-image-build';
import { checkStaleLazyImages } from '../../src/cli/commands/doctor';
import { VERSION } from '../../src/version';

enableInProcessTestMode();

const IMAGE_REF = `lazy-runner:${IMAGE_TAG}`;

/** A timestamp `ms` milliseconds in the past. */
function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

describe('runner image identity and freshness', () => {
  let ctx: TestContext;
  let docker: FakeDocker;
  let originalCwd: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    docker = await installFakeDocker(ctx.root);

    originalCwd = process.cwd();
    // ensureImage resolves the lazy root from cwd; the config it loads is passed
    // the root explicitly, so no separate config pin is needed here.
    process.chdir(ctx.root);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await ctx.cleanup();
  });

  // --- identity -----------------------------------------------------------

  test('the image is tagged with lazy major.minor, never :latest and never the full version', async () => {
    const [major, minor] = VERSION.split('.');
    expect(IMAGE_TAG).toBe(`${major}.${minor}`);

    const ref = await resolveImageName(ctx.root);
    expect(ref).toBe(IMAGE_REF);
    expect(ref.endsWith(':latest')).toBe(false);
    // The per-commit patch component must NOT be in the tag: it advances on
    // every commit, and a tag that moves with it rebuilds a multi-minute image
    // on every commit in a source checkout.
    expect(ref).not.toContain(VERSION);
  });

  // The `-alpha` suffix marks a build that is not from main. It lives past the
  // major.minor prefix, so it must never reach the tag — an alpha and a main
  // build of the same minor want (and get) the same toolchain image.
  test('the -alpha suffix does not reach the image tag', () => {
    expect(imageTagFor('0.21.1373-alpha')).toBe('0.21');
    expect(imageTagFor('0.21.1373')).toBe('0.21');
    expect(imageTagFor('0.21.1373-alpha')).toBe(imageTagFor('0.21.1373'));
  });

  // INVARIANT: an existing `lazy-runner:latest` must NOT satisfy lookup.
  // This is the regression test for the incident — the old image is present and
  // even carries a matching Dockerfile hash, and the build must happen anyway.
  test('an existing :latest image does not satisfy a version-tagged lookup', async () => {
    const currentHash = await calculateDockerfileHash(ctx.root);
    await docker.seedImage('lazy-runner:latest', { dockerfileHash: currentHash, id: 'sha256:stale' });

    const used = await ensureImage(docker.binPath);

    expect(used).toBe(IMAGE_REF);
    const builds = await docker.builds();
    expect(builds.length).toBe(1);
    expect(builds[0]).toContain(`-t ${IMAGE_REF}`);
  });

  // `FROM lazy-runner` in a custom Dockerfile resolves through :latest, so the
  // alias must keep being written — pointed at the newest build, not frozen.
  test('a build writes the version tag and refreshes the :latest alias', async () => {
    await ensureImage(docker.binPath);

    const images = await listLazyImages(docker.binPath);
    const versioned = images.find(image => image.ref === IMAGE_REF);
    const latest = images.find(image => image.ref === 'lazy-runner:latest');
    expect(versioned).toBeDefined();
    expect(latest).toBeDefined();
    // Same ID: one image, two tags — not two copies.
    expect(latest!.id).toBe(versioned!.id);
  });

  test('a fresh, matching image is reused — no rebuild on every launch', async () => {
    await ensureImage(docker.binPath);
    expect((await docker.builds()).length).toBe(1);

    await ensureImage(docker.binPath);
    expect((await docker.builds()).length).toBe(1);
  });

  // --- trigger 1: `lazy upgrade` ------------------------------------------

  // INVARIANT: an upgrade refreshes the toolchain UNCONDITIONALLY. It is the
  // primary freshness mechanism — "upgrading lazy upgrades the toolchain" — and
  // it is what makes the coarse major.minor tag safe. No version comparison, no
  // hash check, no age check gates it; a fresh, hash-matching image is rebuilt
  // anyway. `--no-cache` is part of the invariant: the Dockerfile text is
  // unchanged when a new Claude Code ships, so a cached build re-fetches nothing.
  test('an upgrade rebuilds even when the current image is fresh and hash-matching', async () => {
    await ensureImage(docker.binPath);
    expect((await docker.builds()).length).toBe(1);

    // The exact call `lazy upgrade` makes (src/cli/commands/upgrade.ts).
    const build = startBackgroundImageBuild(ctx.root, docker.binPath);
    await build.promote();

    const builds = await docker.builds();
    expect(builds.length).toBe(2);
    expect(builds[1]).toContain('--no-cache');
    // Staged under its own tag; the canonical tag only moves on promote().
    expect(builds[1]).toContain(`-t lazy-runner:${IMAGE_TAG}-upgrade`);
  });

  // --- trigger 2: age ------------------------------------------------------

  test(`an image older than ${IMAGE_MAX_AGE_DAYS} days is rebuilt`, async () => {
    const currentHash = await calculateDockerfileHash(ctx.root);
    await docker.seedImage(IMAGE_REF, {
      dockerfileHash: currentHash,
      createdAt: ago(IMAGE_MAX_AGE_MS + 60_000),
    });

    const used = await ensureImage(docker.binPath);

    expect(used).toBe(IMAGE_REF);
    const builds = await docker.builds();
    expect(builds.length).toBe(1);
    // A cached build would re-fetch NOTHING (the Dockerfile text is unchanged),
    // so the age rebuild must bust the cache to mean anything.
    expect(builds[0]).toContain('--no-cache');
  });

  test(`an image just under ${IMAGE_MAX_AGE_DAYS} days old is left alone`, async () => {
    const currentHash = await calculateDockerfileHash(ctx.root);
    await docker.seedImage(IMAGE_REF, {
      dockerfileHash: currentHash,
      createdAt: ago(IMAGE_MAX_AGE_MS - 60 * 60_000),
    });

    await ensureImage(docker.binPath);

    expect((await docker.builds()).length).toBe(0);
  });

  // The footgun this guards: `docker build` on an unchanged Dockerfile is an
  // all-cache-hit that returns the SAME image with its ORIGINAL created
  // timestamp. Without --no-cache the age rebuild would never reset the clock,
  // and every launch from then on would rebuild. One rebuild, then quiet.
  test('the age rebuild resets the clock — it does not fire again on the next launch', async () => {
    const currentHash = await calculateDockerfileHash(ctx.root);
    await docker.seedImage(IMAGE_REF, {
      dockerfileHash: currentHash,
      createdAt: ago(IMAGE_MAX_AGE_MS * 3),
    });

    await ensureImage(docker.binPath);
    expect((await docker.builds()).length).toBe(1);

    await ensureImage(docker.binPath);
    expect((await docker.builds()).length).toBe(1);
  });

  // An unreadable timestamp means "no opinion", never "infinitely old" — the
  // latter would rebuild a multi-minute image on every single container launch.
  test('an image whose created timestamp cannot be read is not treated as stale', async () => {
    const verdict = await isImageTooOld('lazy-runner:does-not-exist', docker.binPath);
    expect(verdict.tooOld).toBe(false);
    expect(verdict.ageDays).toBeNull();
  });

  // --- trigger 3: the Dockerfile text -------------------------------------

  test('a Dockerfile change rebuilds the same tag', async () => {
    await docker.seedImage(IMAGE_REF, { dockerfileHash: 'hash-from-an-older-dockerfile' });

    const used = await ensureImage(docker.binPath);

    expect(used).toBe(IMAGE_REF);
    expect((await docker.builds()).length).toBe(1);
  });

  // --- doctor --------------------------------------------------------------

  test('doctor reports older-version images and ignores the :latest alias', async () => {
    await ensureImage(docker.binPath);
    await docker.seedImage('lazy-runner:0.1', { id: 'sha256:ancient', size: '2.5GB' });

    const result = await checkStaleLazyImages(IMAGE_REF, docker.binPath);

    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('lazy-runner:0.1');
    expect(result.warning).toContain('2.5GB');
    expect(result.warning).toContain('image rm');
    // The alias shares the current image's ID — it is the same image, not junk.
    expect(result.warning).not.toContain('lazy-runner:latest');
  });

  // INVARIANT: an older image is never silently substituted for the one this
  // lazy asked for. Quietly falling back to it would recreate the exact failure
  // the rebuild triggers exist to prevent (the offline path is the one explicit
  // exception, and it says so out loud).
  test('a failed build errors out rather than falling back to an older image', async () => {
    await docker.seedImage('lazy-runner:0.1', { id: 'sha256:ancient' });
    await docker.failBuilds();

    await expect(ensureImage(docker.binPath)).rejects.toThrow(/build failed/i);
  });

  test('doctor is quiet when only the current image is present', async () => {
    await ensureImage(docker.binPath);

    const result = await checkStaleLazyImages(IMAGE_REF, docker.binPath);

    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});
