/**
 * The docker BUILD CONTEXT of a human-consented worktree Dockerfile.
 *
 * THE BUG THIS REPRODUCES. Both consent flows (per-task pin, upgrade adoption)
 * built the worktree's Dockerfile.lazy with the PROJECT ROOT as context. The
 * Dockerfile came from the task branch; the tree came from main. A `COPY` of a
 * file that exists only on the branch failed with
 * `"/extra/file.txt": not found`, and — worse when it did not fail — a file the
 * branch had changed was silently copied from main's version instead.
 *
 * Reported from the wild on 2026-09-05: "the daemon adopted the Dockerfile from
 * the ivan-sandboxes worktree but sent the main checkout as the build context.
 * The Dockerfile and the tree it describes came from different branches."
 *
 * Every test here uses the fake `docker` binary (test/helpers/fake-docker.ts),
 * which records each build's cwd AND the tree found there — argv alone cannot
 * show the context, because lazy always passes `.`. Nothing in src/ is mocked.
 *
 * The fixture is the report's shape: a real linked git worktree on its own
 * branch whose Dockerfile.lazy COPYs a file that does not exist at the project
 * root. Before the fix the build context lacked that file; after it, the
 * context is that worktree directory itself.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, mkdtemp, realpath, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { readTaskJson } from '../helpers/storage';
import { commitAll } from '../helpers/git-repo';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import {
  ensureImage,
  enableUpgradeImageBuild,
  resetUpgradeImageBuild,
} from '../../src/capture/claude';
import { maybeOfferWorktreeImageForTask } from '../../src/docker/worktree-image';
import { maybePromptWorktreeDockerfileAdoption } from '../../src/upgrade/worktree-dockerfile-prompt';
import { inspectAdoptedImage } from '../../src/daemon/adopted-image';
import { createStorage } from '../../src/storage';
import type { Storage } from '../../src/storage/interface';

enableInProcessTestMode();

/** Root Dockerfile: the reference both consent flows compare against. */
const ROOT_DOCKERFILE = 'FROM debian:bookworm-slim\n# project root variant\n';

/**
 * Branch Dockerfile: COPYs a path that exists ONLY on the task branch. This
 * single line is the whole bug — resolved against the project root it names
 * nothing.
 */
const BRANCH_DOCKERFILE =
  'FROM debian:bookworm-slim\nCOPY extra/file.txt /extra.txt\n';

/** TTY consent for a CLI subprocess: forced TTY + auto-yes at every prompt. */
const CONSENT_ENV = { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'accept' };

describe('consented worktree Dockerfile build context', () => {
  let ctx: TestContext;
  let docker: FakeDocker;
  let podman: FakeDocker;
  let originalCwd: string;
  let undoDaemonBase: (() => void) | undefined;

  beforeEach(async () => {
    // The adoption flow writes adopted-image.json under the daemon base — pin
    // it so the suite never touches the developer's ~/.lazy.
    const daemonBase = await mkdtemp(join(tmpdir(), 'lazy-buildctx-daemon-'));
    undoDaemonBase = pinDaemonBaseDir(daemonBase);

    ctx = await setupTestLazy();
    docker = await installFakeDocker(ctx.root);
    // The second runtime lazy supports. It takes the same argv as docker, which
    // is exactly the claim the podman test below checks.
    podman = await installFakeDocker(ctx.root, { name: 'podman' });

    originalCwd = process.cwd();
    process.chdir(ctx.root);

    await writeFile(join(ctx.root, 'Dockerfile.lazy'), ROOT_DOCKERFILE);
    await commitAll(ctx.root, 'root Dockerfile.lazy');
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    // The upgrade-build latch is process-wide and every test file shares one
    // process — a leaked latch would re-enable path resolution for later suites.
    resetUpgradeImageBuild();
    await ctx.cleanup();
    // Unpin AFTER cleanup: cleanup resolves the pidfile from this variable.
    undoDaemonBase?.();
    undoDaemonBase = undefined;
  });

  /**
   * A real linked worktree on its own branch, carrying a Dockerfile.lazy that
   * COPYs `extra/file.txt` — a file that exists on this branch and nowhere at
   * the project root. Returns realpath'd paths, because git prints
   * symlink-resolved ones and the assertions compare against those.
   */
  async function makeBranchWorktree(
    name: string,
    dockerfile = BRANCH_DOCKERFILE,
  ): Promise<{ path: string; head: string }> {
    const path = join(ctx.root, '.lazy', 'worktrees', name);
    await mkdir(join(ctx.root, '.lazy', 'worktrees'), { recursive: true });
    const added = ctx.git('worktree', 'add', '-q', '-b', `lazy/${name}`, path);
    expect(added.exitCode).toBe(0);

    await writeFile(join(path, 'Dockerfile.lazy'), dockerfile);
    await mkdir(join(path, 'extra'), { recursive: true });
    await writeFile(join(path, 'extra', 'file.txt'), `only on ${name}\n`);
    const head = await commitAll(path, `${name} fixture`);

    // Sanity: the file the Dockerfile COPYs must NOT be reachable from the
    // project root, or the test could pass with the old root context.
    expect(ctx.git('cat-file', '-e', `HEAD:extra/file.txt`).exitCode).not.toBe(0);

    return { path: await realpath(path), head };
  }

  /** Run a CLI command from inside a worktree with the fake docker on PATH. */
  function lazyFromWorktree(args: string[], worktree: string, bin = docker.binDir) {
    return ctx.lazy(args, {
      cwd: worktree,
      env: { ...CONSENT_ENV, PATH: `${bin}:${process.env.PATH}` },
    });
  }

  /** The 8-char task id `lazy create` printed. */
  function createdTaskId(stdout: string): string {
    const match = stdout.match(/Created task ([a-f0-9]{8})/);
    if (!match) throw new Error(`no task id in output:\n${stdout}`);
    return match[1];
  }

  // --- Part 1: the per-task pin (lazy create/start/edit on a TTY) ----------

  // REGRESSION: this is the reported bug. The consented Dockerfile COPYs a
  // branch-only path; with the project root as context that path does not
  // exist and the build fails ("not found"). The context must be the tree the
  // human consented to.
  test('a consented pin builds against the worktree tree, not the project root', async () => {
    const wt = await makeBranchWorktree('ctx-pin');

    const result = await lazyFromWorktree(
      ['create', '--goal', 'Task pinned from a branch worktree'],
      wt.path,
    );
    expectSuccess(result);

    // The human is told which directory they are consenting to, before the
    // prompt: a docker build reads the whole thing, not just the Dockerfile.
    expectOutput(result, `Context:    ${wt.path} (this worktree, as it is on disk)`);
    expectOutput(result, 'Pinned lazy-custom-');

    const builds = await docker.builds();
    expect(builds.length).toBe(1);

    // The context directory is the consented worktree, not the project root.
    const [cwd] = await docker.buildCwds();
    expect(cwd).toBe(wt.path);
    expect(cwd).not.toBe(await realpath(ctx.root));

    const files = await docker.buildContextFiles(0);
    // The COPY's target is present — the assertion that fails before the fix.
    expect(files).toContain('extra/file.txt');
    expect(files).toContain('Dockerfile.lazy');

    // HEAD at build time is recorded next to the image as provenance, so
    // `lazy show` / `lazy doctor` can say roughly what was built from what.
    const task = readTaskJson(ctx.root, createdTaskId(result.stdout));
    expect(task.metadata?.custom_image_context).toBe(wt.head);
    expect(task.metadata?.custom_image).toMatch(/^lazy-custom-[0-9a-f]{12}:/);
  });

  // The context is the worktree AS IT IS ON DISK — the same thing the human
  // would get typing `docker build .` there. Uncommitted files are in it, and
  // so are that checkout's own .dockerignore rules; lazy adds no filtering of
  // its own. Asserted so the semantics are visible rather than assumed.
  test('the live worktree is the context, uncommitted files included', async () => {
    const wt = await makeBranchWorktree('ctx-live');
    await writeFile(join(wt.path, 'written-after-commit.txt'), 'uncommitted\n');

    const result = await lazyFromWorktree(
      ['create', '--goal', 'Task with uncommitted worktree files'],
      wt.path,
    );
    expectSuccess(result);

    const files = await docker.buildContextFiles(0);
    expect(files).toContain('extra/file.txt');
    expect(files).toContain('written-after-commit.txt');
  });

  // INVARIANT (predates this change): the Dockerfile docker reads is a temp
  // copy of the consented bytes, never the live worktree path — otherwise an
  // edit between the hash and the build would swap in unconsented steps. The
  // context moving to the worktree does not relax that: `-f` still points
  // outside the context, which docker has always allowed.
  test('the Dockerfile is a temp copy of the consented bytes, not the live path', async () => {
    const wt = await makeBranchWorktree('ctx-inject');
    const edited = `${BRANCH_DOCKERFILE}RUN echo consented-and-edited\n`;
    await writeFile(join(wt.path, 'Dockerfile.lazy'), edited);

    const result = await lazyFromWorktree(
      ['create', '--goal', 'Task with an edited consented Dockerfile'],
      wt.path,
    );
    expectSuccess(result);

    const [cwd] = await docker.buildCwds();
    const [argv] = await docker.builds();
    const dashF = argv.match(/-f (\S+)/)?.[1];
    expect(dashF).toMatch(/lazy-docker-build-\S+\/Dockerfile$/);
    expect(dashF).not.toBe(join(cwd, 'Dockerfile.lazy'));
    // What was AT that path is exactly the text the human consented to.
    expect(await docker.buildContextContent(0, 'dockerfile')).toBe(edited);
  });

  // INVARIANT: the image name covers the Dockerfile bytes AND the directory
  // they build against. Identical bytes in two worktrees are two different
  // builds, so they must not share (and silently reuse) one image.
  test('identical Dockerfiles on two branches produce two different images', async () => {
    const first = await makeBranchWorktree('ctx-branch-a');
    const second = await makeBranchWorktree('ctx-branch-b');

    const a = await lazyFromWorktree(['create', '--goal', 'Branch A'], first.path);
    expectSuccess(a);
    const b = await lazyFromWorktree(['create', '--goal', 'Branch B'], second.path);
    expectSuccess(b);

    const taskA = readTaskJson(ctx.root, createdTaskId(a.stdout));
    const taskB = readTaskJson(ctx.root, createdTaskId(b.stdout));

    // Same Dockerfile bytes: the content hash (what drift detection compares)
    // is deliberately unchanged...
    expect(taskA.metadata?.custom_image_hash).toBe(taskB.metadata?.custom_image_hash);
    // ...but the images are distinct, because the trees are.
    expect(taskA.metadata?.custom_image_context).toBe(first.head);
    expect(taskB.metadata?.custom_image_context).toBe(second.head);
    expect(taskA.metadata?.custom_image).not.toBe(taskB.metadata?.custom_image);

    // And each build really saw its own branch's tree.
    const filesA = await docker.buildContextFiles(0);
    const filesB = await docker.buildContextFiles(1);
    expect(filesA).toContain('extra/file.txt');
    expect(filesB).toContain('extra/file.txt');
    expect(await docker.buildCwds()).toHaveLength(2);
  });

  // --- Part 2: upgrade adoption (lazy upgrade from a worktree TTY) --------

  // The second consent flow. Adoption only RECORDS at prompt time; the build
  // happens later in the upgrade rebuild, which resolves the context from the
  // adopted Dockerfile's own directory.
  test('an adoption records the consented worktree and the rebuild builds from it', async () => {
    const wt = await makeBranchWorktree('ctx-adopt');
    process.chdir(wt.path);
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';

    try {
      const state = await maybePromptWorktreeDockerfileAdoption(ctx.root);
      expect(state).not.toBeNull();
      expect(state!.dockerfilePath).toBe(join(wt.path, 'Dockerfile.lazy'));
      expect(state!.contextCommit).toBe(wt.head);

      // Persisted, so the rebuild in another process reads the same tree.
      const stored = await inspectAdoptedImage(ctx.root);
      // Narrow before reading `state`: only the non-'none' members carry one,
      // and a wrong status here is a real failure, not a type inconvenience.
      if (stored.status !== 'valid') throw new Error(`adoption not valid: ${stored.status}`);
      expect(stored.state.contextCommit).toBe(wt.head);

      // The upgrade rebuild: latch on, so the adopted Dockerfile is resolved.
      enableUpgradeImageBuild();
      const built = await ensureImage(docker.binPath);
      expect(built).toBe(state!.imageName);
    } finally {
      delete process.env.LAZY_FORCE_TTY;
      delete process.env.LAZY_PROMPT_DEFAULTS;
      process.chdir(ctx.root);
    }

    const [cwd] = await docker.buildCwds();
    expect(cwd).toBe(wt.path);
    expect(cwd).not.toBe(await realpath(ctx.root));
    const files = await docker.buildContextFiles(0);
    expect(files).toContain('extra/file.txt');
  });

  // --- both runtimes ------------------------------------------------------

  // podman is passed as the `binary` exactly like docker. A directory context
  // is the shape both runtimes have always treated identically — the same argv
  // on both, unlike a tar piped on stdin where Dockerfile selection and
  // .dockerignore handling differ between them.
  test('docker and podman receive the same context-directory build argv', async () => {
    const wt = await makeBranchWorktree('ctx-runtimes');

    const dockerTask = await lazyFromWorktree(['create', '--goal', 'Runtime docker'], wt.path);
    expectSuccess(dockerTask);

    // Same consented worktree, second task, podman as the runtime binary. The
    // pin is per-task, so this is a fresh consent rather than a cache hit.
    const podmanTaskId = createdTaskId(
      (await ctx.lazy(['create', '--goal', 'Runtime podman'])).stdout,
    );
    const storage: Storage = await createStorage(ctx.root);
    process.chdir(wt.path);
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    try {
      const pinned = await maybeOfferWorktreeImageForTask(ctx.root, storage, podmanTaskId, {
        binary: podman.binPath,
      });
      expect(pinned).not.toBeNull();
    } finally {
      delete process.env.LAZY_FORCE_TTY;
      delete process.env.LAZY_PROMPT_DEFAULTS;
      process.chdir(ctx.root);
      await storage.close();
    }

    const [dockerBuild] = await docker.builds();
    const [podmanBuild] = await podman.builds();
    // Byte-identical argv apart from the temp Dockerfile copy each build gets:
    // both end in the context directory `.`, neither names a tar or `-`.
    const normalize = (argv: string) => argv.replace(/-f \S+/, '-f <tmp>/Dockerfile');
    expect(normalize(podmanBuild)).toBe(normalize(dockerBuild));
    expect(dockerBuild.endsWith(' .')).toBe(true);
    expect(podmanBuild.endsWith(' .')).toBe(true);

    // ...and podman's build saw the branch tree too.
    expect(await podman.buildContextFiles(0)).toContain('extra/file.txt');
    expect((await podman.buildCwds())[0]).toBe(wt.path);
  });
});
