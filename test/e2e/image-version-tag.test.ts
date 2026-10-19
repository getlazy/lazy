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
import { readFile, realpath, writeFile, mkdir, mkdtemp } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import {
  ensureImage,
  resolveImageName,
  calculateImageInputsHash,
  preflightAgentBinaryInImage,
  listLazyImages,
  isImageTooOld,
  classifyRunnerPullFailure,
  IMAGE_TAG,
  IMAGE_MAX_AGE_DAYS,
  IMAGE_MAX_AGE_MS,
  enableUpgradeImageBuild,
  resetUpgradeImageBuild,
  evaluateUpgradeRebuild,
} from '../../src/capture/claude';
import { imageTagFor, runnerContentTag } from '../../src/capture/image-tag';
import { PUBLISHED_RUNNER_REF, runnerIdentityHash } from '../../src/docker/runner-dockerfile';
import { setOfflineMode } from '../../src/utils/offline';
import { publishedRunnerImageLabels, runnerImageAgents, composeRunnerDockerfile } from '../../src/docker/runner-dockerfile';
import { getAgentPackaging, listAgents } from '../../src/agent/registry';
import { startBackgroundImageBuild } from '../../src/upgrade/background-image-build';
import { checkStaleLazyImages } from '../../src/cli/commands/doctor';
import { findStaleLazyImages } from '../../src/cli/commands/doctor-remedies';
import { createTask } from '../helpers/fixtures';
import { setTaskMetadata } from '../helpers/storage';
import { VERSION } from '../../src/version';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { commitAll } from '../helpers/git-repo';

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
  let undoDaemonBase: (() => void) | undefined;

  beforeEach(async () => {
    // Adoption soft-pin / path-resolve tests write adopted-image.json under
    // the daemon base — pin it so we never touch the developer's ~/.lazy.
    const daemonBase = await mkdtemp(join(tmpdir(), 'lazy-img-daemon-'));
    undoDaemonBase = pinDaemonBaseDir(daemonBase);

    ctx = await setupTestLazy();
    docker = await installFakeDocker(ctx.root);

    originalCwd = process.cwd();
    // ensureImage resolves the lazy root from cwd; the config it loads is passed
    // the root explicitly, so no separate config pin is needed here.
    process.chdir(ctx.root);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    // The upgrade-build latch is process-wide, and every test file shares one
    // process — a leaked latch would silently re-enable path resolution for
    // later suites.
    resetUpgradeImageBuild();
    await ctx.cleanup();
    // Unpin AFTER cleanup — same rule as other daemon-base pins.
    undoDaemonBase?.();
    undoDaemonBase = undefined;
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
    const currentHash = await calculateImageInputsHash(ctx.root);
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

  // The one exception to trigger 1, and it lives in the COMMAND, not in the
  // build path above: `lazy upgrade --images` followed minutes later by
  // `lazy upgrade` ran the identical --no-cache build twice. The build path
  // stays unconditional (the test above); `evaluateUpgradeRebuild` is what
  // `lazy upgrade` (never `--images`) asks first — and when the image identity
  // is unchanged it answers `ask`, not "skip". There is deliberately no timer:
  // the rebuild would only re-resolve unpinned contents, which is worth minutes
  // some days and not others, so the age goes into a QUESTION to the human
  // rather than into a threshold nobody can see.
  test('evaluateUpgradeRebuild asks about a same-identity image instead of deciding', async () => {
    const currentHash = await calculateImageInputsHash(ctx.root);
    await docker.seedImage(IMAGE_REF, {
      dockerfileHash: currentHash,
      createdAt: ago(5 * 60_000),
    });

    const decision = await evaluateUpgradeRebuild(ctx.root, docker.binPath);

    expect(decision.verdict).toBe('ask');
    expect(decision.imageName).toBe(IMAGE_REF);
    // The reason is printed to the human, so it must say why, not just "ask".
    expect(decision.reason).toContain(IMAGE_REF);
    // The age is part of the question ("built 5 minutes ago"), not a threshold.
    expect(decision.builtAgo).toBe('5 minutes');
    expect(decision.reason).toContain('5 minutes');
    expect((await docker.builds()).length).toBe(0);
  });

  // Age alone never flips the answer to `rebuild`: an old same-identity image is
  // still the human's call, only with a bigger number in the question.
  test('evaluateUpgradeRebuild still asks about an old same-identity image', async () => {
    const currentHash = await calculateImageInputsHash(ctx.root);
    await docker.seedImage(IMAGE_REF, {
      dockerfileHash: currentHash,
      createdAt: ago(9 * 24 * 60 * 60 * 1000),
    });

    const decision = await evaluateUpgradeRebuild(ctx.root, docker.binPath);

    expect(decision.verdict).toBe('ask');
    expect(decision.builtAgo).toBe('9 days');
  });

  test('evaluateUpgradeRebuild rebuilds when the image identity changed', async () => {
    await docker.seedImage(IMAGE_REF, { dockerfileHash: 'hash-from-an-older-dockerfile' });

    const decision = await evaluateUpgradeRebuild(ctx.root, docker.binPath);

    expect(decision.verdict).toBe('rebuild');
  });

  test('evaluateUpgradeRebuild rebuilds when no image exists on this host', async () => {
    const decision = await evaluateUpgradeRebuild(ctx.root, docker.binPath);

    expect(decision.verdict).toBe('rebuild');
    expect(decision.reason).toContain('not built on this host');
  });

  // --- trigger 2: age ------------------------------------------------------

  test(`an image older than ${IMAGE_MAX_AGE_DAYS} days is rebuilt`, async () => {
    const currentHash = await calculateImageInputsHash(ctx.root);
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
    const currentHash = await calculateImageInputsHash(ctx.root);
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
    const currentHash = await calculateImageInputsHash(ctx.root);
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
    // The remedy is lazy's own flag, never a docker command to paste.
    expect(result.warning).toContain('lazy doctor --clean-docker-images');
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

  // INVARIANT: an image a launch on this machine still needs is never stale.
  // Doctor used to name the image the daemon had just adopted as reclaimable —
  // it escaped the list only when a container happened to be running on it — so
  // the advice was to delete the very image the next turn would launch with. A
  // task's pinned image is worse: a launch whose pinned image is gone fails
  // LOUDLY by design, so deleting it wedges that task rather than degrading it.
  test('doctor never lists the adopted or a task-pinned image as stale', async () => {
    await ensureImage(docker.binPath);

    // A valid adoption: Dockerfile present at the recorded path, content hash
    // matching what was consented, this lazy's image tag.
    const { writeAdoptedImage, hashDockerfileContent } = await import('../../src/daemon/adopted-image');
    const adoptedDockerfile = join(ctx.root, 'Dockerfile.adopted');
    const adoptedContent = 'FROM debian:bookworm\nRUN echo adopted\n';
    await writeFile(adoptedDockerfile, adoptedContent);
    const adoptedImage = `lazy-custom-adopted:${IMAGE_TAG}`;
    await writeAdoptedImage(ctx.root, {
      dockerfilePath: adoptedDockerfile,
      contentHash: hashDockerfileContent(adoptedContent),
      imageName: adoptedImage,
    }, { content: adoptedContent });
    await docker.seedImage(adoptedImage, { id: 'sha256:adopted' });

    // A task whose turns are pinned to their own image.
    const pinnedImage = `lazy-custom-pinned:${IMAGE_TAG}`;
    await docker.seedImage(pinnedImage, { id: 'sha256:pinned' });
    const taskId = await createTask(ctx, 'Pinned image task');
    setTaskMetadata(ctx.root, taskId, 'custom_image', pinnedImage);

    // ...and one image nothing can reach, so the check is not passing by
    // reporting nothing at all.
    await docker.seedImage('lazy-runner:0.1', { id: 'sha256:ancient', size: '2.5GB' });

    const stale = await findStaleLazyImages(IMAGE_REF, docker.binPath, ctx.root);
    const refs = stale.map(i => i.ref);

    expect(refs).toContain('lazy-runner:0.1');
    expect(refs).not.toContain(adoptedImage);
    expect(refs).not.toContain(pinnedImage);
    expect(refs).not.toContain(IMAGE_REF);
  });

  test('doctor is quiet when only the current image is present', async () => {
    await ensureImage(docker.binPath);

    const result = await checkStaleLazyImages(IMAGE_REF, docker.binPath);

    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  // --- one runner image for every agent (published-runner-image) --------
  //
  // INVARIANT: the default image carries EVERY container-capable agent's CLI,
  // so every agent resolves to the one lazy-runner image. Per-agent variants
  // meant patching Dockerfiles, which hid what an image contained (engineer
  // decision 2026-09-27, docs/design/published-runner-image.md).

  test('a cursor-default project runs the same lazy-runner image with the same identity', async () => {
    const baseHash = await calculateImageInputsHash(ctx.root);

    const configPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(configPath, 'utf-8');
    const updated = toml.replace('agent_id = "claude-code"', 'agent_id = "cursor"');
    expect(updated).not.toBe(toml);
    await writeFile(configPath, updated);

    expect(await resolveImageName(ctx.root)).toBe(IMAGE_REF);
    expect(await calculateImageInputsHash(ctx.root)).toBe(baseHash);
  });

  // --- custom-Dockerfile agent-binary preflight (cursor-first-class-agent §2) --
  //
  // Custom Dockerfiles are never amended, so a non-claude agent's binary may be
  // absent from the image. The launch preflight probes for it with a throwaway
  // `docker run` and refuses the launch with the exact RUN line to add —
  // instead of the crash loop the engineer hit on this repo's Dockerfile.lazy.

  async function useCustomDockerfile(content: string = 'FROM debian:bookworm-slim\n'): Promise<void> {
    const dockerfilePath = join(ctx.root, 'Dockerfile.custom');
    await writeFile(dockerfilePath, content);
    const configPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(configPath, 'utf-8');
    const updated = toml.replace('dockerfile = ""', 'dockerfile = "Dockerfile.custom"');
    expect(updated).not.toBe(toml);
    await writeFile(configPath, updated);
  }

  test('preflight refuses a custom image missing the agent binary, naming the RUN line', async () => {
    await useCustomDockerfile();
    await docker.failRuns();

    await expect(
      preflightAgentBinaryInImage('lazy-custom-abc:0.21', docker.binPath, 'cursor'),
    ).rejects.toThrow(/cursor-agent[\s\S]*RUN curl https:\/\/cursor\.com\/install -fsS \| bash/);
  });

  test('preflight passes when the custom image has the binary', async () => {
    await useCustomDockerfile();
    await preflightAgentBinaryInImage('lazy-custom-abc:0.21', docker.binPath, 'cursor');
    const runs = (await docker.invocations()).filter(line => line.startsWith('run '));
    expect(runs.length).toBe(1);
    expect(runs[0]).toContain('--entrypoint which');
    expect(runs[0]).toContain('--network none');
    expect(runs[0]).toContain('cursor-agent');
  });

  test('preflight is a no-op for claude-code and for the agent-aware default image', async () => {
    // claude-code on a custom Dockerfile: base image responsibility, no probe.
    await useCustomDockerfile();
    await preflightAgentBinaryInImage('lazy-custom-abc:0.21', docker.binPath, 'claude-code');
    // cursor on the DEFAULT image: the image build already baked the agent in.
    const configPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(configPath, 'utf-8');
    await writeFile(configPath, toml.replace('dockerfile = "Dockerfile.custom"', 'dockerfile = ""'));
    await docker.failRuns(); // would fail if a probe ran
    await preflightAgentBinaryInImage(IMAGE_REF, docker.binPath, 'cursor');
    const runs = (await docker.invocations()).filter(line => line.startsWith('run '));
    expect(runs.length).toBe(0);
  });

  test('the built default image Dockerfile contains every agent CLI', async () => {
    const used = await ensureImage(docker.binPath);
    expect(used).toBe(IMAGE_REF);

    const builds = await docker.builds();
    expect(builds.length).toBe(1);
    // The build argv carries `-f <path>` to the temp Dockerfile lazy wrote —
    // read it back to assert every agent's install line is in it.
    const match = builds[0].match(/-f (\S+)/);
    expect(match).not.toBeNull();
    const dockerfile = await readFile(match![1], 'utf-8');
    expect(dockerfile).toContain('cursor.com/install');
    expect(dockerfile).toContain('claude.ai/install.sh');
    expect(dockerfile).toContain('openai/codex/releases');
  });

  // --- Dockerfile resolution: root-joined; worktree never auto-governs ---
  //
  // INVARIANT: a TASK's worktree never governs the container image without
  // human TTY consent. Task branches are agent-writable, and deriving the
  // image from one would let an agent's Dockerfile.lazy edits execute as
  // build steps under the daemon's docker on the HOST. The custom Dockerfile
  // path always joins to the PROJECT ROOT. Human-consented paths:
  //   - Part 1: per-task pin via create/start/edit TTY (ensureImage pinnedImage)
  //   - Part 2: upgrade adoption soft-pin (unit-tested in adopted-image.test.ts);
  //     upgrade builds flip enableUpgradeImageBuild() so resolveCustomDockerfile
  //     may return the adopted path for the rebuild itself.

  async function setupWorktreeWithOwnDockerfile(): Promise<{
    wt: string;
    wtContent: string;
    rootContent: string;
    wtHead: string;
  }> {
    // The root project uses a custom Dockerfile...
    const rootContent = 'FROM debian:bookworm-slim\n# root variant\n';
    await writeFile(join(ctx.root, 'Dockerfile.custom'), rootContent);
    const configPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(configPath, 'utf-8');
    const updated = toml.replace('dockerfile = ""', 'dockerfile = "Dockerfile.custom"');
    expect(updated).not.toBe(toml);
    await writeFile(configPath, updated);

    // ...and a task worktree carries its own lazy.toml plus a CHANGED
    // Dockerfile — the shape of a task branch (possibly agent-authored) that
    // edits the Dockerfile, e.g. adding an install line. A REAL linked git
    // worktree, as lazy creates: its `.git` is a file pointing back at the main
    // repo (which is why findGitRoot still answers the project root from in
    // here), and its HEAD is a commit a consented build can be snapshotted from.
    const wt = join(ctx.root, '.lazy', 'worktrees', 'dockerfile-branch');
    await mkdir(join(ctx.root, '.lazy', 'worktrees'), { recursive: true });
    const added = ctx.git('worktree', 'add', '-q', '-b', 'lazy/dockerfile-branch', wt);
    expect(added.exitCode).toBe(0);
    await writeFile(join(wt, 'lazy.toml'), updated);
    const wtContent = rootContent + 'RUN curl https://cursor.com/install -fsS | bash\n';
    await writeFile(join(wt, 'Dockerfile.custom'), wtContent);
    // A file that exists on the branch and NOT at the project root — the shape
    // of the COPY that broke when the root was used as the build context.
    await writeFile(join(wt, 'worktree-only.txt'), 'only on this branch\n');
    const wtHead = await commitAll(wt, 'worktree fixture');
    return { wt, wtContent, rootContent, wtHead };
  }

  const shortHashOf = (content: string) =>
    createHash('sha256').update(content).digest('hex').substring(0, 12);

  test("a worktree's own Dockerfile copy never changes the image", async () => {
    const { wt, rootContent } = await setupWorktreeWithOwnDockerfile();
    const rootRef = `lazy-custom-${shortHashOf(rootContent)}:${IMAGE_TAG}`;

    // From the project root (suite default cwd): the root's Dockerfile.
    expect(await resolveImageName(ctx.root)).toBe(rootRef);

    // Even resolved from INSIDE the worktree (where the config walk finds the
    // worktree's lazy.toml), the Dockerfile still joins to the PROJECT ROOT —
    // the worktree's differing copy is never hashed or built.
    process.chdir(wt);
    try {
      const used = await ensureImage(docker.binPath);
      expect(used).toBe(rootRef);
      const builds = await docker.builds();
      expect(builds.length).toBe(1);
      // Build reads a temp copy of the ROOT Dockerfile (hash/build TOCTOU),
      // never the live root path and never the worktree's differing copy.
      expect(builds[0]).toMatch(/-f \S*lazy-docker-build-\S+\/Dockerfile/);
      expect(builds[0]).not.toContain(join(wt, 'Dockerfile.custom'));
      expect(builds[0]).not.toContain(`-f ${join(ctx.root, 'Dockerfile.custom')}`);

      // INVARIANT: snapshotted build contexts are for CONSENTED worktree
      // Dockerfiles only. The plain `[docker].dockerfile` path is unchanged by
      // that work — it still runs in the PROJECT ROOT with `.` as the context
      // argument. Asserted, not eyeballed: this is the whole blast radius of
      // the `buildCwd` conditional in buildImageWithTags.
      const [cwd] = await docker.buildCwds();
      expect(cwd).toBe(await realpath(ctx.root));
      expect(cwd).not.toMatch(/lazy-build-ctx-/);
      // Trailing `.` — a directory context rooted at that cwd.
      expect(builds[0].endsWith(' .')).toBe(true);
      // Byte-for-byte argv: `build`, the tags, the identity labels (content hash
      // + the build-inputs manifest), `-f <temp>`, `.` — no extra flags, and
      // nothing pointing into an extracted tree.
      expect(builds[0]).toMatch(
        /^build(?: -t \S+)+ --label lazy\.dockerfile\.hash=[0-9a-f]{64} --label lazy\.image\.inputs=\S+ -f \S+\/Dockerfile \.$/,
      );
      // The context this build saw is the project root's real tree, not an
      // extraction: the file only the branch has must be absent.
      const rootFiles = await docker.buildContextFiles(0);
      expect(rootFiles).not.toContain('worktree-only.txt');
    } finally {
      process.chdir(ctx.root);
    }
  });

  // --- Root Dockerfile.lazy convention -------------------------------------
  //
  // INVARIANT: with `[docker].dockerfile` unset, a Dockerfile.lazy in the
  // PROJECT ROOT is the image — so an accepted Dockerfile.lazy governs the next
  // launch with no config edit. A worktree's Dockerfile.lazy still never does.

  // The root file lands through an accept, i.e. a COMMIT on the root branch.
  const commitRootDockerfile = () => {
    expect(ctx.git('add', 'Dockerfile.lazy').exitCode).toBe(0);
    expect(ctx.git('commit', '-q', '--no-verify', '-m', 'accept: task image').exitCode).toBe(0);
  };

  // INVARIANT: an UNTRACKED root Dockerfile.lazy is never the image — nobody
  // reviewed or accepted it. The launch uses the default image and says why.
  test('an untracked root Dockerfile.lazy is not the image, and the launch says why', async () => {
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), 'FROM lazy-runner\nRUN echo unreviewed\n');
    const notes: string[] = [];
    expect(await ensureImage(docker.binPath, { notify: (n) => notes.push(n) })).toBe(IMAGE_REF);
    expect(notes.some(n => /not committed/.test(n))).toBe(true);
  });

  test('a root Dockerfile.lazy with no config key is the image on the next launch', async () => {
    const content = 'FROM lazy-runner\nRUN sudo apt-get install -y cargo\n';
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), content);
    commitRootDockerfile();

    const used = await ensureImage(docker.binPath);

    expect(used).toBe(`lazy-custom-${shortHashOf(content)}:${IMAGE_TAG}`);
    const builds = await docker.builds();
    expect(builds.some(b => b.includes(`-t lazy-custom-${shortHashOf(content)}`))).toBe(true);
  });

  // INVARIANT: the image identity AND the Dockerfile docker builds are the
  // COMMITTED bytes — uncommitted edits in the root checkout reach neither.
  test('uncommitted edits to the root Dockerfile.lazy reach neither the identity nor the build', async () => {
    const committed = 'FROM lazy-runner\n# accepted\n';
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), committed);
    commitRootDockerfile();
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), 'FROM lazy-runner\nRUN echo unreviewed\n');

    const used = await ensureImage(docker.binPath);

    expect(used).toBe(`lazy-custom-${shortHashOf(committed)}:${IMAGE_TAG}`);
    const builds = await docker.builds();
    const index = builds.findIndex(b => b.includes(`-t lazy-custom-${shortHashOf(committed)}`));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(await docker.buildContextContent(index, 'dockerfile')).toBe(committed);
  });

  test('changing the root Dockerfile.lazy (an accept) rebuilds under a new identity', async () => {
    const first = 'FROM lazy-runner\n# v1\n';
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), first);
    commitRootDockerfile();
    const before = await ensureImage(docker.binPath);

    const second = 'FROM lazy-runner\nRUN sudo apt-get install -y nodejs\n';
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), second);
    commitRootDockerfile();
    const after = await ensureImage(docker.binPath);

    expect(after).not.toBe(before);
    expect(after).toBe(`lazy-custom-${shortHashOf(second)}:${IMAGE_TAG}`);
  });

  test("a worktree's Dockerfile.lazy is not the image when the root has none", async () => {
    const wt = join(ctx.root, '.lazy', 'worktrees', 'toolchain-branch');
    await mkdir(join(ctx.root, '.lazy', 'worktrees'), { recursive: true });
    expect(ctx.git('worktree', 'add', '-q', '-b', 'lazy/toolchain-branch', wt).exitCode).toBe(0);
    await writeFile(join(wt, 'Dockerfile.lazy'), 'FROM lazy-runner\nRUN echo agent-authored\n');
    await commitAll(wt, 'agent adds Dockerfile.lazy');

    process.chdir(wt);
    try {
      expect(await ensureImage(docker.binPath)).toBe(IMAGE_REF);
    } finally {
      process.chdir(ctx.root);
    }
  });

  // INVARIANT: a root Dockerfile.lazy that fails to build fails the launch,
  // naming the file — never a silent fall back to the default image.
  test('a root Dockerfile.lazy that fails to build fails loudly, naming the file', async () => {
    // A plain base, so the failure is THIS file's build, not a base-image build.
    const rootDockerfile = join(ctx.root, 'Dockerfile.lazy');
    await writeFile(rootDockerfile, 'FROM debian:bookworm-slim\nRUN false\n');
    commitRootDockerfile();
    await docker.failBuilds();

    const err = await ensureImage(docker.binPath).then(() => null, (e: Error) => e);
    expect(err).not.toBeNull();
    // Names the COMMITTED file it built (never the working-tree copy) and where.
    expect(err!.message).toMatch(/Dockerfile\.lazy as committed \([0-9a-f]{12}\)/);
    expect(err!.message).toContain(await realpath(ctx.root));
    expect(err!.message).toContain('Last output:');
    expect(err!.message).not.toMatch(/Base image/i);
    // Exactly the one failed build, of the project file — nothing retried
    // from the default Dockerfile.
    const builds = await docker.builds();
    expect(builds).toHaveLength(1);
    expect(builds[0]).toContain('lazy-custom-');
  });

  // INVARIANT: without the upgrade-build latch, ensureImage soft-pins an
  // adopted imageName and never rebuilds from the worktree path — even when
  // the latch is later flipped for an upgrade rebuild of that same adoption.
  test('upgrade-build latch lets resolveCustomDockerfile see an adopted path; launches do not', async () => {
    const { wt, wtContent, rootContent, wtHead } = await setupWorktreeWithOwnDockerfile();
    const wtDockerfile = join(wt, 'Dockerfile.custom');
    const { writeAdoptedImage, hashDockerfileContent } = await import('../../src/daemon/adopted-image');
    const { getAdoptedDockerfilePath } = await import('../../src/daemon/paths');
    const { consentedBuildIdentity } = await import('../../src/capture/image-tag');
    const contentHash = hashDockerfileContent(wtContent);
    // An adoption names its image after the consented Dockerfile AND the
    // directory it builds against — the same bytes in another worktree are
    // another image.
    const identity = consentedBuildIdentity(contentHash, wt);
    const imageName = `lazy-custom-${identity.substring(0, 12)}:${IMAGE_TAG}`;
    await writeAdoptedImage(ctx.root, {
      dockerfilePath: wtDockerfile,
      contentHash,
      imageName,
      contextCommit: wtHead,
    }, { content: wtContent });
    await docker.seedImage(imageName, { dockerfileHash: 'consented' });

    // Launch path (latch off): soft-pin the consented image — do not rebuild
    // from the worktree file.
    resetUpgradeImageBuild();
    const launched = await ensureImage(docker.binPath);
    expect(launched).toBe(imageName);
    expect(await docker.builds()).toHaveLength(0);

    // Upgrade path (latch on): resolve the consented SNAPSHOT (not the live
    // worktree path) for the rebuild itself.
    enableUpgradeImageBuild();
    const { resolveCustomDockerfile } = await import('../../src/capture/claude');
    const snapshotPath = getAdoptedDockerfilePath(ctx.root);
    expect(await resolveCustomDockerfile(ctx.root)).toBe(snapshotPath);
    expect(await resolveCustomDockerfile(ctx.root)).not.toBe(wtDockerfile);
    // Soft-pin is skipped; ensureImage builds from consented bytes (snapshot
    // copied to a unique temp for the docker -f arg — never the worktree).
    const rebuilt = await ensureImage(docker.binPath);
    expect(rebuilt).toBe(imageName);
    const builds = await docker.builds();
    expect(builds.length).toBe(1);
    expect(builds[0]).not.toContain(`-f ${wtDockerfile}`);
    // Root Dockerfile was never the source of this rebuild.
    expect(builds[0]).not.toContain(`-f ${join(ctx.root, 'Dockerfile.custom')}`);
    expect(rootContent).not.toBe(wtContent); // sanity: they differ

    // ...and the CONTEXT is the consented WORKTREE directory — not the project
    // root, whose tree belongs to main and would resolve the Dockerfile's COPY
    // paths against the wrong branch.
    const [cwd] = await docker.buildCwds();
    expect(cwd).toBe(await realpath(wt));
    expect(cwd).not.toBe(await realpath(ctx.root));
    const contextFiles = await docker.buildContextFiles(0);
    // `worktree-only.txt` exists only on this branch: it is in the context
    // precisely because the context followed the Dockerfile.
    expect(contextFiles).toContain('worktree-only.txt');
    expect(contextFiles).toContain('Dockerfile.custom');
  });

  // --- the lazy-runner base a custom Dockerfile builds FROM ----------------
  //
  // `lazy-runner` lives on no registry. A custom Dockerfile that does
  // `FROM lazy-runner` on a machine where the base was never built (fresh
  // install, `docker system prune`) made docker try Docker Hub and fail with
  // "pull access denied, repository does not exist" — a message that points at
  // nothing. The version tag makes this reachable on any minor bump: it forces a
  // custom-image rebuild, and the rebuild then has nothing to layer on.

  test('a missing lazy-runner base is built BEFORE the custom image that FROMs it', async () => {
    const content = 'FROM lazy-runner\nRUN echo hi\n';
    await useCustomDockerfile(content);

    const used = await ensureImage(docker.binPath);
    expect(used).toBe(`lazy-custom-${shortHashOf(content)}:${IMAGE_TAG}`);

    const builds = await docker.builds();
    expect(builds.length).toBe(2);
    // Order matters — the base must exist before the custom build runs.
    expect(builds[0]).toContain(`-t ${IMAGE_REF}`);
    // ...including the `:latest` alias, which is what untagged FROM resolves through.
    expect(builds[0]).toContain('-t lazy-runner:latest');
    expect(builds[1]).toContain(`-t lazy-custom-${shortHashOf(content)}:${IMAGE_TAG}`);
    // Custom build uses a temp copy of the Dockerfile (hash/build TOCTOU),
    // not the live project-root path.
    expect(builds[1]).toMatch(/-f \S*lazy-docker-build-\S+\/Dockerfile/);
    expect(builds[1]).not.toContain(`-f ${join(ctx.root, 'Dockerfile.custom')}`);
  });

  // ONLY-WHEN-MISSING: this is not a second freshness mechanism. ensureImage's
  // own triggers (upgrade / age / hash) govern how fresh the base stays; adding
  // a rebuild here would bolt a multi-minute build onto every custom build.
  test('an existing base image is left alone — no rebuild, no second mechanism', async () => {
    await useCustomDockerfile('FROM lazy-runner\n');
    await docker.seedImage('lazy-runner:latest', { id: 'sha256:base' });

    await ensureImage(docker.binPath);

    const builds = await docker.builds();
    expect(builds.length).toBe(1);
    expect(builds[0]).toContain('lazy-custom-');
  });

  test('a custom Dockerfile with no lazy base never triggers a base build', async () => {
    await useCustomDockerfile('FROM debian:bookworm-slim\n');

    await ensureImage(docker.binPath);

    const builds = await docker.builds();
    expect(builds.length).toBe(1);
    expect(builds[0]).not.toContain(`-t ${IMAGE_REF}`);
  });

  // When lazy cannot supply the base itself, the human must be told the remedy —
  // a raw registry error for an image that lives on no registry is a dead end.
  test('a failing base build names `lazy system build lazy-runner` as the remedy', async () => {
    await useCustomDockerfile('FROM lazy-runner\n');
    await docker.failBuilds();

    await expect(ensureImage(docker.binPath)).rejects.toThrow(/lazy system build lazy-runner/);
  });

  // A base pinned to a tag no base build writes (and, on the same rule, an
  // agent-suffixed `lazy-runner-cursor`) cannot be auto-built: building would
  // not produce the ref the Dockerfile asked for. It still gets the remedy.
  test('a base pinned to an unwritable tag is not built, but the failure explains itself', async () => {
    await useCustomDockerfile('FROM lazy-runner:0.1\n');
    await docker.failBuilds();

    await expect(ensureImage(docker.binPath)).rejects.toThrow(/lazy-runner:0\.1[\s\S]*lazy system build lazy-runner/);
    // No base build was attempted — only the custom one, which failed.
    const builds = await docker.builds();
    expect(builds.length).toBe(1);
    expect(builds[0]).toContain('lazy-custom-');
  });
  // --- the published runner image (published-runner-image) ----------------
  //
  // INVARIANT: launches PULL the release's runner image and re-tag it locally;
  // a local build is the fallback, never removed. The release publishes the
  // same composed Dockerfile this binary builds, and the identity label is what
  // proves it (docs/design/published-runner-image.md §4).

  // INVARIANT: lazy pulls the runner by its CONTENT tag, sha-<first 16 hex of the
  // identity label>, from the one function the publish script also calls. A launch
  // and the release computing it differently would mean every pull misses.
  test('the pulled ref is the content tag of the composed runner', () => {
    expect(runnerContentTag('0123456789abcdef0123')).toBe('sha-0123456789abcdef');
    expect(PUBLISHED_RUNNER_REF).toBe(`ghcr.io/getlazy/lazy-runner:${runnerContentTag(runnerIdentityHash())}`);
    const script = Bun.spawnSync(['bun', 'scripts/runner-image-dockerfile.ts', '--content-tag'], { cwd: join(import.meta.dir, '..', '..') });
    expect(script.stdout.toString().trim()).toBe(PUBLISHED_RUNNER_REF.split(':').pop()!);
  });

  // INVARIANT: the labels the release stamps equal the identity a local build
  // of the same text computes. If they drifted, every launch would reject the
  // published image and silently go back to multi-minute local builds.
  test('the release labels match the local identity for the default image', async () => {
    const labels = publishedRunnerImageLabels();
    expect(labels['lazy.dockerfile.hash']).toBe(await calculateImageInputsHash(ctx.root));
    expect(labels['lazy.base.source']).toBe('published');
  });

  test('the runner Dockerfile installs every container-capable agent, once each', () => {
    const expected = listAgents().filter(id => getAgentPackaging(id).supportsContainerRunner());
    expect(runnerImageAgents()).toEqual(expected);
    expect(expected).toEqual(expect.arrayContaining(['claude-code', 'codex', 'cursor', 'pi']));
    const dockerfile = composeRunnerDockerfile();
    for (const id of expected) {
      const install = getAgentPackaging(id).dockerInstallCommand();
      expect(dockerfile.split(install).length - 1).toBe(1);
    }
  });

  test('a published image for this version is pulled and tagged — nothing is built', async () => {
    await docker.publishImage(PUBLISHED_RUNNER_REF, { dockerfileHash: await calculateImageInputsHash(ctx.root) });

    expect(await ensureImage(docker.binPath)).toBe(IMAGE_REF);

    expect(await docker.pulls()).toEqual([`pull ${PUBLISHED_RUNNER_REF}`]);
    expect(await docker.builds()).toEqual([]);
    const tags = (await docker.invocations()).filter(line => line.startsWith('tag '));
    expect(tags).toEqual([
      `tag ${PUBLISHED_RUNNER_REF} ${IMAGE_REF}`,
      `tag ${PUBLISHED_RUNNER_REF} lazy-runner:latest`,
    ]);
  });

  test('an unpublished version builds locally, labelled local and tagged with the published ref', async () => {
    expect(await ensureImage(docker.binPath)).toBe(IMAGE_REF);

    expect((await docker.pulls()).length).toBe(1);
    const builds = await docker.builds();
    expect(builds.length).toBe(1);
    expect(builds[0]).toContain('--label lazy.base.source=local');
    expect(builds[0]).toContain(`-t ${PUBLISHED_RUNNER_REF}`);
  });

  // A published image whose identity label differs means the release built a
  // different Dockerfile than this binary composes — never used.
  test('a published image with a different identity is not used', async () => {
    await docker.publishImage(PUBLISHED_RUNNER_REF, { dockerfileHash: 'some-other-dockerfile' });

    await ensureImage(docker.binPath);

    expect((await docker.pulls()).length).toBe(1);
    expect((await docker.builds()).length).toBe(1);
    expect((await docker.invocations()).some(line => line.startsWith(`tag ${PUBLISHED_RUNNER_REF}`))).toBe(false);
  });

  // INVARIANT: a PULLED image pins its agent CLIs to its release and is never
  // age-rebuilt — newer CLIs come by upgrading lazy (engineer decision
  // 2026-09-27). A LOCAL build keeps the age trigger (covered above).
  test('a pulled image older than the age limit is not rebuilt', async () => {
    const hash = await calculateImageInputsHash(ctx.root);
    await docker.publishImage(PUBLISHED_RUNNER_REF, { dockerfileHash: hash, createdAt: ago(IMAGE_MAX_AGE_MS * 3) });
    await ensureImage(docker.binPath);

    expect(await ensureImage(docker.binPath)).toBe(IMAGE_REF);
    expect(await docker.builds()).toEqual([]);
    expect((await docker.pulls()).length).toBe(1);
  });

  // An upgrade to a release promotes THAT release's image. Its --no-cache is
  // for re-fetching unpinned CLIs in a local build, and a published image pins
  // them, so the pull wins and nothing is built.
  test('lazy upgrade stages and promotes the published image instead of building', async () => {
    await docker.publishImage(PUBLISHED_RUNNER_REF, { dockerfileHash: await calculateImageInputsHash(ctx.root) });

    const build = startBackgroundImageBuild(ctx.root, docker.binPath);
    await build.promote();

    expect(await docker.builds()).toEqual([]);
    const tags = (await docker.invocations()).filter(line => line.startsWith('tag '));
    expect(tags[0]).toBe(`tag ${PUBLISHED_RUNNER_REF} lazy-runner:${IMAGE_TAG}-upgrade`);
    expect(tags).toContain(`tag lazy-runner:${IMAGE_TAG}-upgrade ${IMAGE_REF}`);
  });


  // INVARIANT: an upgrade whose pull missed promotes its LOCAL build onto the
  // published content ref too (task-image-design §2), labelled local — otherwise
  // an older image keeps answering a FROM that names that ref.
  test('lazy upgrade with no published image promotes the local build onto the content ref', async () => {
    await docker.failPulls();

    const build = startBackgroundImageBuild(ctx.root, docker.binPath);
    await build.promote();

    const builds = await docker.builds();
    expect(builds.length).toBe(1);
    expect(builds[0]).toContain('--label lazy.base.source=local');
    const tags = (await docker.invocations()).filter(line => line.startsWith('tag '));
    expect(tags).toContain(`tag lazy-runner:${IMAGE_TAG}-upgrade ${PUBLISHED_RUNNER_REF}`);
  });

  test('offline mode never pulls the base for a custom FROM lazy-runner', async () => {
    await docker.publishImage(PUBLISHED_RUNNER_REF, { dockerfileHash: await calculateImageInputsHash(ctx.root) });
    await useCustomDockerfile('FROM lazy-runner\n');
    await setOfflineMode(join(ctx.root, '.lazy'), true);

    await ensureImage(docker.binPath);

    expect(await docker.pulls()).toEqual([]);
  });


  // INVARIANT: only the RUNNER repository is exempt from the age rebuild when
  // published. Docker inherits labels from the base, so a custom image built FROM
  // a pulled runner can carry `lazy.base.source=published`; its own layers still
  // go stale and must keep the 14-day rebuild.
  test('a custom image inheriting the published label is still age-rebuilt', async () => {
    await useCustomDockerfile('FROM debian:bookworm-slim\n');
    await ensureImage(docker.binPath);
    const first = (await docker.builds())[0]!;
    const ref = first.match(/-t (lazy-custom-[^ ]+)/)![1]!;

    await docker.seedImage(ref, {
      dockerfileHash: await calculateImageInputsHash(ctx.root),
      createdAt: ago(IMAGE_MAX_AGE_MS * 3),
      baseSource: 'published',
    });
    await ensureImage(docker.binPath);

    const builds = await docker.builds();
    expect(builds.length).toBe(2);
    expect(builds[1]).toContain('--no-cache');
  });


  // Design note §5: a host whose LOCAL build ages out switches to the published
  // image when one exists, instead of rebuilding locally every 14 days.
  test('an aged local runner is replaced by the published image when there is one', async () => {
    const hash = await calculateImageInputsHash(ctx.root);
    await docker.seedImage(IMAGE_REF, { dockerfileHash: hash, createdAt: ago(IMAGE_MAX_AGE_MS * 2), baseSource: 'local' });
    await docker.publishImage(PUBLISHED_RUNNER_REF, { dockerfileHash: hash });

    expect(await ensureImage(docker.binPath)).toBe(IMAGE_REF);
    expect(await docker.pulls()).toEqual([`pull ${PUBLISHED_RUNNER_REF}`]);
    expect(await docker.builds()).toEqual([]);
  });

  // INVARIANT: "nothing was published" is the quiet, expected fallback; every
  // other pull failure is a problem the human can fix, so it is warned with the
  // remedy — a silent multi-minute local build every launch is the failure mode.
  test('pull failures are classified: unpublished is quiet, the rest name a remedy', () => {
    expect(classifyRunnerPullFailure('Error response from daemon: manifest for ghcr.io/getlazy/lazy-runner:sha-x not found: manifest unknown', 1).quiet).toBe(true);
    expect(classifyRunnerPullFailure('Error response from daemon: pull access not found somewhere', 1).quiet).toBe(false);
    const denied = classifyRunnerPullFailure('Error response from daemon: denied: denied', 1);
    expect(denied.quiet).toBe(false);
    expect(denied.why).toContain('docker logout ghcr.io');
    expect(classifyRunnerPullFailure('x509: certificate signed by unknown authority', 1).why).toContain('CA');
    expect(classifyRunnerPullFailure('dial tcp: lookup ghcr.io: no such host', 1).why).toContain('lazy system offline');
    expect(classifyRunnerPullFailure('', null).why).toContain('could not be reached');
  });

  test('a failed fallback build names why the pull did not happen', async () => {
    await docker.failPulls();
    await docker.failBuilds();

    await expect(ensureImage(docker.binPath)).rejects.toThrow(/Built locally because the pull of [\s\S]*no such host/);
  });

  test('a failed pull falls back to a local build', async () => {
    await docker.publishImage(PUBLISHED_RUNNER_REF, { dockerfileHash: await calculateImageInputsHash(ctx.root) });
    await docker.failPulls();

    expect(await ensureImage(docker.binPath)).toBe(IMAGE_REF);
    expect((await docker.builds()).length).toBe(1);
  });

  test('offline mode builds locally without trying to pull', async () => {
    await docker.publishImage(PUBLISHED_RUNNER_REF, { dockerfileHash: await calculateImageInputsHash(ctx.root) });
    await setOfflineMode(join(ctx.root, '.lazy'), true);

    await ensureImage(docker.binPath);

    expect(await docker.pulls()).toEqual([]);
    expect((await docker.builds()).length).toBe(1);
  });

  // The structural fix for the missing-base failure class: a custom
  // `FROM lazy-runner` on a host with no base pulls it instead of building.
  test('a custom Dockerfile FROM lazy-runner pulls a missing base instead of building it', async () => {
    const baseHash = await calculateImageInputsHash(ctx.root);
    await docker.publishImage(PUBLISHED_RUNNER_REF, { dockerfileHash: baseHash });
    await useCustomDockerfile('FROM lazy-runner\n');

    await ensureImage(docker.binPath);

    expect(await docker.pulls()).toEqual([`pull ${PUBLISHED_RUNNER_REF}`]);
    const builds = await docker.builds();
    expect(builds.length).toBe(1);
    expect(builds[0]).toContain('lazy-custom-');
  });

  test('a custom Dockerfile FROM a retired per-agent image is told to use lazy-runner', async () => {
    await useCustomDockerfile('FROM lazy-runner-cursor\n');
    await docker.failBuilds();

    await expect(ensureImage(docker.binPath)).rejects.toThrow(/per-agent runner images are no longer produced[\s\S]*FROM lazy-runner/);
  });
});
