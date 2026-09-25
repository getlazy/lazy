/**
 * `[docker] build_inputs` — files whose CONTENTS are part of the image identity.
 *
 * The gap this closes: the image identity hash covered the Dockerfile TEXT only,
 * never the build context it COPYs from. So `COPY Gemfile.lock . && RUN bundle
 * install` built once and then silently drifted — a lockfile bump changed
 * neither the Dockerfile text nor therefore lazy's idea of the image, so
 * `ensureImage` hash-matched and skipped forever.
 *
 * These tests drive the REAL logic in src/capture/claude.ts against the fake
 * `docker` binary (test/helpers/fake-docker.ts), not the module mock — the
 * module mock replaces `ensureImage` itself and can never reach the decision
 * under test.
 *
 * Three things are asserted here, and the third is the one with teeth:
 *   1. a changed build input rebuilds; an unchanged one does not
 *   2. a missing declared input is a loud error, not a silent no-op
 *   3. N concurrent starts produce exactly ONE build (the per-image lock)
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import {
  ensureImage,
  calculateImageInputsHash,
  calculateImageInputManifest,
  describeInputChanges,
  resolveImageName,
} from '../../src/capture/claude';
import { IMAGE_INPUTS_LABEL, DOCKERFILE_INPUT_KEY } from '../../src/capture/image-tag';
import { loadConfig } from '../../src/config/loader';

enableInProcessTestMode();

describe('[docker] build_inputs', () => {
  let ctx: TestContext;
  let docker: FakeDocker;
  let originalCwd: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    docker = await installFakeDocker(ctx.root);
    originalCwd = process.cwd();
    process.chdir(ctx.root);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await ctx.cleanup();
  });

  /**
   * Give the project a custom Dockerfile plus the declared inputs. A custom
   * Dockerfile is what makes build_inputs meaningful at all (it is the only
   * case where the build context is the project root), so every test here uses
   * one. Edits the `[docker]` table lazy init already wrote rather than
   * appending a second one — a duplicate table is a TOML redefinition error.
   */
  async function configureBuildInputs(inputs: string[], files: Record<string, string>): Promise<void> {
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), 'FROM lazy-runner\nCOPY Gemfile.lock .\n');
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(ctx.root, name), content);
    }

    const tomlPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(tomlPath, 'utf-8');
    const desired =
      `dockerfile = "Dockerfile.lazy"\nbuild_inputs = [${inputs.map(i => `"${i}"`).join(', ')}]`;
    // Idempotent: matches the key init wrote AND the block a previous call to
    // this helper left behind, so a test can reconfigure more than once.
    const after = before.replace(/dockerfile = "[^"]*"(\nbuild_inputs = \[[^\]]*\])?/, desired);
    expect(after).not.toBe(before);
    await writeFile(tomlPath, after);
  }

  // --- identity ------------------------------------------------------------

  test('a build input appears in the manifest and moves the identity hash', async () => {
    await configureBuildInputs(['Gemfile.lock'], { 'Gemfile.lock': 'rails 7.0.0\n' });

    const before = await calculateImageInputsHash(ctx.root);
    const manifest = await calculateImageInputManifest(ctx.root);
    expect(Object.keys(manifest).sort()).toEqual([DOCKERFILE_INPUT_KEY, 'Gemfile.lock']);

    await writeFile(join(ctx.root, 'Gemfile.lock'), 'rails 7.1.0\n');
    expect(await calculateImageInputsHash(ctx.root)).not.toBe(before);
  });

  // The repository name is content-addressed by the DOCKERFILE hash only. If
  // build_inputs reached it too, every lockfile bump would mint a brand new
  // image NAME and leave the previous one orphaned on disk forever.
  test('a build input change rebuilds in place — it does not mint a new image name', async () => {
    await configureBuildInputs(['Gemfile.lock'], { 'Gemfile.lock': 'rails 7.0.0\n' });

    const nameBefore = await resolveImageName(ctx.root);
    await writeFile(join(ctx.root, 'Gemfile.lock'), 'rails 7.1.0\n');
    expect(await resolveImageName(ctx.root)).toBe(nameBefore);
  });

  // Same bytes under a different name is still a different image: the
  // Dockerfile COPYs by name, so what gets built genuinely differs.
  test('renaming a declared input changes the identity even with identical contents', async () => {
    await configureBuildInputs(['a.lock'], { 'a.lock': 'same bytes\n' });
    const withA = await calculateImageInputsHash(ctx.root);

    await configureBuildInputs(['b.lock'], { 'b.lock': 'same bytes\n' });
    expect(await calculateImageInputsHash(ctx.root)).not.toBe(withA);
  });

  // --- rebuild triggering --------------------------------------------------

  test('changing a build input triggers exactly one rebuild, and the next launch is quiet', async () => {
    await configureBuildInputs(['Gemfile.lock'], { 'Gemfile.lock': 'rails 7.0.0\n' });

    await ensureImage(docker.binPath);
    expect((await docker.builds()).length).toBe(1);

    // Unchanged inputs: no build.
    await ensureImage(docker.binPath);
    expect((await docker.builds()).length).toBe(1);

    await writeFile(join(ctx.root, 'Gemfile.lock'), 'rails 7.1.0\n');
    await ensureImage(docker.binPath);
    expect((await docker.builds()).length).toBe(2);

    // And it settles — the rebuild wrote the new hash, so it does not re-fire.
    await ensureImage(docker.binPath);
    expect((await docker.builds()).length).toBe(2);
  });

  test('the build writes the input manifest label, so a rebuild can name what changed', async () => {
    await configureBuildInputs(['Gemfile.lock'], { 'Gemfile.lock': 'rails 7.0.0\n' });
    await ensureImage(docker.binPath);

    const build = (await docker.builds())[0];
    expect(build).toContain(`--label ${IMAGE_INPUTS_LABEL}=`);
    expect(build).toContain('Gemfile.lock');
  });

  test('the rebuild reason names the file that changed', () => {
    const previous = { [DOCKERFILE_INPUT_KEY]: 'aaa', 'Gemfile.lock': 'bbb' };
    expect(describeInputChanges(previous, { ...previous, 'Gemfile.lock': 'ccc' }))
      .toBe('Gemfile.lock changed');
    expect(describeInputChanges(previous, { ...previous, 'yarn.lock': 'ddd' }))
      .toBe('yarn.lock added');
    expect(describeInputChanges(previous, { [DOCKERFILE_INPUT_KEY]: 'aaa' }))
      .toBe('Gemfile.lock no longer a build input');
    // No manifest label (an image built by an older lazy) means "no opinion" —
    // the caller falls back to a generic line rather than inventing a reason.
    expect(describeInputChanges(null, previous)).toBeNull();
  });

  // --- validation ----------------------------------------------------------

  // A typo is the case that actually happens, and hashing a missing file "as
  // absent" would make it a PERMANENT silent no-op: the image would never
  // rebuild on a lockfile bump and nothing anywhere would say why. Loud, with
  // the offending path named, matching how a missing [docker] dockerfile fails.
  test('a declared input that does not exist fails loudly, naming the file', async () => {
    await configureBuildInputs(['Gemfile.lock', 'nope.lock'], { 'Gemfile.lock': 'rails 7.0.0\n' });

    await expect(ensureImage(docker.binPath)).rejects.toThrow(/nope\.lock/);
    await expect(ensureImage(docker.binPath)).rejects.toThrow(/build_inputs/);
    // Nothing was built on the way to the error.
    expect((await docker.builds()).length).toBe(0);
  });

  test('an absolute or escaping build_inputs entry is rejected at config load', async () => {
    for (const bad of ['/etc/passwd', '../outside.lock']) {
      await configureBuildInputs([bad], {});
      await expect(loadConfig(ctx.root)).rejects.toThrow(/build_inputs/);
    }
  });

  test('no build_inputs configured is a no-op — the Dockerfile alone is the identity', async () => {
    const manifest = await calculateImageInputManifest(ctx.root);
    expect(Object.keys(manifest)).toEqual([DOCKERFILE_INPUT_KEY]);
  });

  // --- the per-image build lock -------------------------------------------

  // INVARIANT: ensureImage is serialized per resolved image name. Without it,
  // the fan-out after a lockfile bump has every concurrently-launching task
  // inspect the same stale image and start its own multi-minute build, each
  // holding an agent slot. The lock makes the second caller wait and then find
  // the hash current.
  //
  // The fake build sleeps so the callers genuinely overlap — without the delay
  // this assertion can pass by accident, with build #1 finished before caller
  // #2 has inspected anything.
  test('parallel starts after a build-input change trigger exactly ONE build', async () => {
    await configureBuildInputs(['Gemfile.lock'], { 'Gemfile.lock': 'rails 7.0.0\n' });
    await docker.slowBuilds(1);

    const used = await Promise.all([
      ensureImage(docker.binPath),
      ensureImage(docker.binPath),
      ensureImage(docker.binPath),
      ensureImage(docker.binPath),
    ]);

    expect((await docker.builds()).length).toBe(1);
    // Every caller still gets a usable image ref back, not just the winner.
    expect(new Set(used).size).toBe(1);
  });

  test('a second parallel wave after a further change builds once more, not zero times', async () => {
    await configureBuildInputs(['Gemfile.lock'], { 'Gemfile.lock': 'rails 7.0.0\n' });
    await docker.slowBuilds(1);

    await Promise.all([ensureImage(docker.binPath), ensureImage(docker.binPath)]);
    expect((await docker.builds()).length).toBe(1);

    await writeFile(join(ctx.root, 'Gemfile.lock'), 'rails 7.1.0\n');
    await Promise.all([ensureImage(docker.binPath), ensureImage(docker.binPath)]);
    expect((await docker.builds()).length).toBe(2);
  });
});
