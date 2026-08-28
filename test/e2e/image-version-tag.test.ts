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
import { readFile, writeFile, mkdir, mkdtemp } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import {
  ensureImage,
  resolveImageName,
  calculateDockerfileHash,
  preflightAgentBinaryInImage,
  listLazyImages,
  isImageTooOld,
  IMAGE_TAG,
  IMAGE_MAX_AGE_DAYS,
  IMAGE_MAX_AGE_MS,
  enableUpgradeImageBuild,
  resetUpgradeImageBuild,
} from '../../src/capture/claude';
import { imageTagFor } from '../../src/capture/image-tag';
import { startBackgroundImageBuild } from '../../src/upgrade/background-image-build';
import { checkStaleLazyImages } from '../../src/cli/commands/doctor';
import { VERSION } from '../../src/version';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

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

  // --- agent-aware images (cursor-first-class-agent) ----------------------
  //
  // A container-capable non-claude agent (cursor) gets its OWN image: the
  // default Dockerfile plus the agent's install command, under a repository
  // that never collides with the base lazy-runner image.

  test('a cursor-default project resolves an agent-suffixed repository with a distinct hash', async () => {
    const baseHash = await calculateDockerfileHash(ctx.root);

    const configPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(configPath, 'utf-8');
    const updated = toml.replace('agent_id = "claude-code"', 'agent_id = "cursor"');
    expect(updated).not.toBe(toml);
    await writeFile(configPath, updated);

    const ref = await resolveImageName(ctx.root);
    expect(ref).toBe(`lazy-runner-cursor:${IMAGE_TAG}`);

    const cursorHash = await calculateDockerfileHash(ctx.root);
    expect(cursorHash).not.toBe(baseHash);
  });

  // Per-task --agent override: a claude-default project still builds the
  // cursor image when the TASK's agent is cursor.
  test('an explicit agentId override resolves the agent image on a claude-default project', async () => {
    expect(await resolveImageName(ctx.root)).toBe(IMAGE_REF);
    expect(await resolveImageName(ctx.root, 'cursor')).toBe(`lazy-runner-cursor:${IMAGE_TAG}`);
    // claude-code override is a no-op — the base image already contains it.
    expect(await resolveImageName(ctx.root, 'claude-code')).toBe(IMAGE_REF);
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
    expect(runs[0]).toContain('which cursor-agent');
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
    await preflightAgentBinaryInImage(`lazy-runner-cursor:${IMAGE_TAG}`, docker.binPath, 'cursor');
    const runs = (await docker.invocations()).filter(line => line.startsWith('run '));
    expect(runs.length).toBe(0);
  });

  test('the built agent image Dockerfile contains the cursor install command', async () => {
    const used = await ensureImage(docker.binPath, { agentId: 'cursor' });
    expect(used).toBe(`lazy-runner-cursor:${IMAGE_TAG}`);

    const builds = await docker.builds();
    expect(builds.length).toBe(1);
    // The build argv carries `-f <path>` to the temp Dockerfile lazy wrote —
    // read it back to assert the agent install was appended.
    const match = builds[0].match(/-f (\S+)/);
    expect(match).not.toBeNull();
    const dockerfile = await readFile(match![1], 'utf-8');
    expect(dockerfile).toContain('cursor.com/install');
    // The base image content is still there (claude stays available for
    // in-container merge turns).
    expect(dockerfile).toContain('claude.ai/install.sh');
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

  async function setupWorktreeWithOwnDockerfile(): Promise<{ wt: string; wtContent: string; rootContent: string }> {
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
    // edits the Dockerfile, e.g. adding an install line.
    const wt = join(ctx.root, '.lazy', 'worktrees', 'dockerfile-branch');
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, 'lazy.toml'), updated);
    const wtContent = rootContent + 'RUN curl https://cursor.com/install -fsS | bash\n';
    await writeFile(join(wt, 'Dockerfile.custom'), wtContent);
    return { wt, wtContent, rootContent };
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
    } finally {
      process.chdir(ctx.root);
    }
  });

  // INVARIANT: without the upgrade-build latch, ensureImage soft-pins an
  // adopted imageName and never rebuilds from the worktree path — even when
  // the latch is later flipped for an upgrade rebuild of that same adoption.
  test('upgrade-build latch lets resolveCustomDockerfile see an adopted path; launches do not', async () => {
    const { wt, wtContent, rootContent } = await setupWorktreeWithOwnDockerfile();
    const wtDockerfile = join(wt, 'Dockerfile.custom');
    const { writeAdoptedImage, hashDockerfileContent } = await import('../../src/daemon/adopted-image');
    const { getAdoptedDockerfilePath } = await import('../../src/daemon/paths');
    const imageName = `lazy-custom-${shortHashOf(wtContent)}:${IMAGE_TAG}`;
    await writeAdoptedImage(ctx.root, {
      dockerfilePath: wtDockerfile,
      contentHash: hashDockerfileContent(wtContent),
      imageName,
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
});
