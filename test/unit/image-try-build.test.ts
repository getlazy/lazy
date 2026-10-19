/**
 * `lazy_image_build` (src/daemon/image-try-build.ts): the try-build a fix
 * task's agent verifies its Dockerfile.lazy with. Every docker call is
 * recorded through the injectable runner, and a fake docker binary stands
 * in for the image store so the tests can prove what is NEVER touched.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir, symlink, readdir, readFile, realpath, rename } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pinConfig } from '../helpers/pin-config';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { runGit } from '../../src/utils/git';
import {
  imageTryBuildAvailable,
  tryBuildTaskDockerfile,
  TRY_BUILD_UNAVAILABLE,
  TRY_BUILD_BUILDER_PREFIX,
  type DockerRun,
} from '../../src/daemon/image-try-build';
import { readAdoptedImage } from '../../src/daemon/adopted-image';

const MICROVM = { LAZY_MANAGED: '1', LAZY_MANAGED_BACKEND: 'microvm', PATH: process.env.PATH ?? '' };
const COMMITTED = 'FROM alpine:3.20\nCOPY tools.txt /tools.txt\n';
const EDITED = 'FROM alpine:3.20\nCOPY tools.txt /tools.txt\nRUN echo edited\n';

async function git(cwd: string, ...args: string[]) {
  const r = await runGit(args, { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

interface Call { argv: string[]; env: Record<string, string>; context?: string[] }

const BASE_DIGEST = `sha256:${'a'.repeat(64)}`;

/**
 * Write what `docker save` produces. Docker Engine >= 25 (the Teams guest runs
 * docker-ce 29.x) writes an OCI image layout whose index annotates each image
 * with `io.containerd.image.name` and `org.opencontainers.image.ref.name`;
 * `legacy` writes the pre-25 Docker archive (manifest.json only).
 */
async function writeOciSave(tarPath: string, ref: string, legacy: boolean): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-fake-save-'));
  if (legacy) {
    await writeFile(join(dir, 'manifest.json'), JSON.stringify([{ RepoTags: [ref], Layers: [] }]));
  } else {
    const tag = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : 'latest';
    await writeFile(join(dir, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
    await writeFile(join(dir, 'index.json'), JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [{
        mediaType: 'application/vnd.oci.image.index.v1+json',
        digest: BASE_DIGEST,
        size: 100,
        annotations: { 'io.containerd.image.name': `docker.io/library/${ref}`, 'org.opencontainers.image.ref.name': tag },
      }],
    }));
  }
  const proc = Bun.spawn(['tar', '-cf', tarPath, '-C', dir, '.'], { stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;
  await rm(dir, { recursive: true, force: true });
}

describe('lazy_image_build (try-build)', () => {
  let base: string;
  let root: string;
  let worktree: string;
  let docker: FakeDocker;
  let undoBase: (() => void) | undefined;
  let undoConfig: (() => void) | undefined;
  const task = { id: 'task-1', label: 'fix-image', branch: 'lazy/fix-image' };

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-trybuild-test-')));
    undoBase = pinDaemonBaseDir(join(base, 'daemon'));
    docker = await installFakeDocker(base);
    root = join(base, 'repo');
    worktree = join(base, 'wt');
    await mkdir(root);
    await git(root, 'init', '-q', '-b', 'main');
    await git(root, 'config', 'user.email', 't@example.com');
    await git(root, 'config', 'user.name', 'T');
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = ""\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'init');
    await git(root, 'worktree', 'add', '-q', '-b', task.branch, worktree);
    await writeFile(join(worktree, 'Dockerfile.lazy'), COMMITTED);
    await writeFile(join(worktree, 'tools.txt'), 'committed\n');
    await git(worktree, 'add', '.');
    await git(worktree, 'commit', '-q', '-m', 'image');
    // Uncommitted: an edit to the Dockerfile (tested) and a stray file (not in the context).
    await writeFile(join(worktree, 'Dockerfile.lazy'), EDITED);
    await writeFile(join(worktree, 'uncommitted-secret.txt'), 'not committed');
    undoConfig = pinConfig(root);
  });

  afterEach(async () => {
    undoConfig?.();
    undoBase?.();
    await rm(base, { recursive: true, force: true });
  });

  /** A runner that records every call and the build context it was handed, then delegates. */
  function recorder(calls: Call[], opts: { buildExit?: number; inner?: DockerRun; legacySave?: boolean } = {}): DockerRun {
    return async (argv, o) => {
      const call: Call = { argv, env: o.env };
      calls.push(call);
      if (argv[1] === 'buildx' && argv[2] === 'build') {
        const ctx = argv[argv.length - 1];
        call.context = (await readdir(ctx)).sort();
        const f = argv[argv.indexOf('-f') + 1];
        call.argv = [...argv, `#dockerfile=${await readFile(f, 'utf-8')}`];
        return { exitCode: opts.buildExit ?? 0, output: opts.buildExit ? '#5 ERROR: boom' : '#5 DONE' };
      }
      if (opts.inner) return opts.inner(argv, o);
      if (argv[1] === 'save') {
        // Stand in for `docker save -o <tar> <ref>` on Docker Engine >= 25: an
        // OCI image layout, shaped as moby writes it.
        const out = argv[argv.indexOf('-o') + 1];
        await writeOciSave(out, argv[argv.length - 1], opts.legacySave === true);
        return { exitCode: 0, output: '' };
      }
      if (argv[0] === 'tar') {
        const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
        return { exitCode: await proc.exited, output: '' };
      }
      return { exitCode: 0, output: '' };
    };
  }

  const noBases = async () => ({ buildable: [], unbuildable: [] });

  // INVARIANT: the tool exists only on a managed daemon on the microVM
  // backend. Solo, local-docker Teams (the host's shared dockerd) and an
  // unset backend are all refused — fail closed.
  test('is available only on managed + microVM', async () => {
    expect(imageTryBuildAvailable({})).toBe(false);
    expect(imageTryBuildAvailable({ LAZY_MANAGED: '1' })).toBe(false);
    expect(imageTryBuildAvailable({ LAZY_MANAGED: '1', LAZY_MANAGED_BACKEND: 'local-docker' })).toBe(false);
    expect(imageTryBuildAvailable({ LAZY_MANAGED_BACKEND: 'microvm' })).toBe(false);
    expect(imageTryBuildAvailable(MICROVM)).toBe(true);
    for (const env of [{}, { LAZY_MANAGED: '1', LAZY_MANAGED_BACKEND: 'local-docker' }]) {
      const calls: Call[] = [];
      const err = await tryBuildTaskDockerfile(root, task, worktree, { env, run: recorder(calls), prepareBases: noBases }).catch((e) => e);
      expect(err.message).toBe(TRY_BUILD_UNAVAILABLE);
      expect(calls).toEqual([]);
    }
  });

  test('the builder (no task) is refused', async () => {
    const err = await tryBuildTaskDockerfile(root, { ...task, id: '' }, root, { env: MICROVM, prepareBases: noBases }).catch((e) => e);
    expect(err.message).toContain('builder mode');
  });

  // INVARIANT: the try-build never uses the daemon's default builder. It
  // creates its own docker-container builder (cache private to it), exports
  // nothing (cacheonly, no tag, no --load/--push), passes no secrets, SSH or
  // entitlements, and removes the builder with its state afterwards. Sharing
  // the default builder's cache would let a layer an agent's RUN downloaded
  // be reused by an accepted production image build.
  test('builds on a throwaway isolated builder, exports nothing, and removes it', async () => {
    const calls: Call[] = [];
    const result = await tryBuildTaskDockerfile(root, task, worktree, { binary: 'docker', env: MICROVM, run: recorder(calls), prepareBases: noBases });
    expect(result.ok).toBe(true);
    expect(result.discarded).toBe(true);

    // (The orphan sweep's `ps` / `volume ls` come first; only buildx is about this build.)
    const docker_ = calls.filter((c) => c.argv[0] === 'docker' && c.argv[1] === 'buildx');
    expect(docker_.map((c) => c.argv.slice(1, 3).join(' '))).toEqual(['buildx create', 'buildx build', 'buildx rm']);
    const create = docker_[0].argv;
    const builder = create[create.indexOf('--name') + 1];
    expect(builder.startsWith(TRY_BUILD_BUILDER_PREFIX)).toBe(true);
    expect(create).toContain('--driver');
    expect(create[create.indexOf('--driver') + 1]).toBe('docker-container');

    const build = docker_[1].argv;
    expect(build[build.indexOf('--builder') + 1]).toBe(builder);
    expect(build[build.indexOf('--output') + 1]).toBe('type=cacheonly');
    for (const forbidden of ['-t', '--tag', '--load', '--push', '--secret', '--ssh', '--allow', '--network']) {
      expect(build).not.toContain(forbidden);
    }
    expect(docker_[2].argv).toEqual(['docker', 'buildx', 'rm', '--force', builder]);
  });

  // INVARIANT: the context is the task branch's COMMITTED tree, exported by
  // the daemon — never the live worktree. Only the Dockerfile's uncommitted
  // edit is carried, so the agent can test it before committing.
  test('the context is the committed tree plus the edited Dockerfile, never the live worktree', async () => {
    const calls: Call[] = [];
    await tryBuildTaskDockerfile(root, task, worktree, { env: MICROVM, run: recorder(calls), prepareBases: noBases });
    const build = calls.find((c) => c.argv[2] === 'build')!;
    expect(build.context).toContain('tools.txt');
    expect(build.context).not.toContain('uncommitted-secret.txt');
    expect(build.argv[build.argv.length - 2]).not.toBe(worktree);
    expect(build.argv.at(-1)).toBe(`#dockerfile=${EDITED}`);
  });

  // INVARIANT: no credential reaches any docker call: a minimal environment
  // and an EMPTY docker config (no registry logins, helpers or contexts).
  test('every docker call gets an empty docker config and none of the daemon\'s environment', async () => {
    const calls: Call[] = [];
    await tryBuildTaskDockerfile(root, task, worktree, {
      env: { ...MICROVM, ANTHROPIC_API_KEY: 'secret', GH_TOKEN: 'secret', DOCKER_HOST: 'unix:///run/guest.sock' },
      run: async (argv, o) => {
        if (argv[0] === 'docker' && argv[2] === 'create') expect(await readdir(o.env.DOCKER_CONFIG)).toEqual([]);
        return recorder(calls)(argv, o);
      },
      prepareBases: noBases,
    });
    for (const c of calls) expect(Object.keys(c.env).sort()).toEqual(['DOCKER_CONFIG', 'DOCKER_HOST', 'HOME', 'PATH']);
  });

  test('a failing build returns its output and still removes the builder', async () => {
    const calls: Call[] = [];
    const result = await tryBuildTaskDockerfile(root, task, worktree, { env: MICROVM, run: recorder(calls, { buildExit: 1 }), prepareBases: noBases });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('boom');
    expect(calls.some((c) => c.argv[2] === 'rm' && c.argv.includes('--force'))).toBe(true);
  });

  // lazy's own base image reaches the isolated builder read-only as a named
  // OCI-layout context; it is never pulled from a registry or rebuilt there.
  test('a FROM lazy-runner base is handed over as an oci-layout named context', async () => {
    await writeFile(join(worktree, 'Dockerfile.lazy'), 'FROM lazy-runner\nRUN true\n');
    const calls: Call[] = [];
    await tryBuildTaskDockerfile(root, task, worktree, {
      env: MICROVM,
      run: recorder(calls),
      prepareBases: async () => ({ buildable: ['lazy-runner:latest'], unbuildable: [] }),
    });
    expect(calls.some((c) => c.argv[1] === 'save' && c.argv.includes('lazy-runner:latest'))).toBe(true);
    const build = calls.find((c) => c.argv[2] === 'build')!.argv;
    const contexts = build.filter((_, i) => build[i - 1] === '--build-context');
    // Pinned by the digest read from the exported layout's own index.
    expect(contexts.some((c) => c.startsWith('lazy-runner:latest=oci-layout://') && c.endsWith(`@${BASE_DIGEST}`))).toBe(true);
    expect(contexts.some((c) => c.startsWith('lazy-runner=oci-layout://') && c.endsWith(`@${BASE_DIGEST}`))).toBe(true);
  });

  // A pre-25 engine's legacy archive is refused by name, never handed to buildx.
  test('a legacy docker save archive is refused with what to do', async () => {
    await writeFile(join(worktree, 'Dockerfile.lazy'), 'FROM lazy-runner\nRUN true\n');
    const calls: Call[] = [];
    const result = await tryBuildTaskDockerfile(root, task, worktree, {
      env: MICROVM,
      run: recorder(calls, { legacySave: true }),
      prepareBases: async () => ({ buildable: ['lazy-runner:latest'], unbuildable: [] }),
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('legacy Docker archive');
    expect(calls.some((c) => c.argv[2] === 'build')).toBe(false);
  });

  // INVARIANT: production images and the default builder are untouched: the
  // real (fake) docker binary sees no default-builder `build`, no tag, no
  // image removal, and no adoption is written.
  test('against a docker binary, the image store and default builder are never touched', async () => {
    await docker.seedImage('lazy-custom-abc:0.23');
    const before = (await readdir(join(docker.stateDir, 'images'))).sort();
    const result = await tryBuildTaskDockerfile(root, task, worktree, { binary: docker.binPath, env: MICROVM, prepareBases: noBases });
    expect(result.discarded).toBe(true);
    const inv = await docker.invocations();
    expect(inv.filter((l) => l.startsWith('build '))).toEqual([]);
    expect(inv.some((l) => l.startsWith('image rm') || l.startsWith('tag ') || l.startsWith('rmi'))).toBe(false);
    expect(inv.some((l) => l.startsWith('buildx build') && l.includes('type=cacheonly'))).toBe(true);
    expect(inv.some((l) => l.startsWith('buildx rm --force'))).toBe(true);
    expect((await readdir(join(docker.stateDir, 'images'))).sort()).toEqual(before);
    expect(await readAdoptedImage(root)).toBeNull();
  });

  test('a Dockerfile that is a symlink is refused before any docker call', async () => {
    await rm(join(worktree, 'Dockerfile.lazy'));
    await symlink('/etc/hostname', join(worktree, 'Dockerfile.lazy'));
    const calls: Call[] = [];
    const err = await tryBuildTaskDockerfile(root, task, worktree, { env: MICROVM, run: recorder(calls), prepareBases: noBases }).catch((e) => e);
    expect(err.message).toContain('not a regular file');
    expect(calls).toEqual([]);
  });

  // INVARIANT: an isolated builder orphaned by a daemon restart mid-build or a
  // failed `buildx rm` is removed by the next try-build, by its BuildKit
  // container and volume names — its metadata died with the old scratch
  // DOCKER_CONFIG, so `buildx rm` can never find it. A live one is spared.
  test('orphaned try-build builders are swept; an in-flight one is spared', async () => {
    const calls: Call[] = [];
    let liveNode = '';
    const inner: DockerRun = async (argv) => {
      if (argv[1] === 'ps') {
        return { exitCode: 0, output: `buildx_buildkit_lazy-trybuild-old0\n${liveNode}\nsomething-else\n` };
      }
      if (argv[1] === 'volume' && argv[2] === 'ls') {
        return { exitCode: 0, output: `buildx_buildkit_lazy-trybuild-old0_state\n${liveNode}_state\n` };
      }
      return { exitCode: 0, output: '' };
    };
    // A second task's build is in flight while this one sweeps.
    let releaseOther: () => void = () => {};
    const otherTask = { id: 'task-2', label: 'other', branch: task.branch };
    const other = tryBuildTaskDockerfile(root, otherTask, worktree, {
      env: MICROVM,
      prepareBases: noBases,
      run: async (argv, o) => {
        if (argv[1] === 'buildx' && argv[2] === 'create') liveNode = `buildx_buildkit_${argv[argv.indexOf('--name') + 1]}0`;
        if (argv[1] === 'buildx' && argv[2] === 'build') await new Promise<void>((r) => { releaseOther = r; });
        return recorder([], { inner })(argv, o);
      },
    });
    while (!liveNode) await Bun.sleep(5);

    await tryBuildTaskDockerfile(root, task, worktree, { env: MICROVM, run: recorder(calls, { inner }), prepareBases: noBases });
    releaseOther();
    await other;

    const rmContainers = calls.find((c) => c.argv[1] === 'rm' && c.argv[2] === '-f')!.argv;
    expect(rmContainers).toContain('buildx_buildkit_lazy-trybuild-old0');
    expect(rmContainers).not.toContain(liveNode);
    expect(rmContainers).not.toContain('something-else');
    const rmVolumes = calls.find((c) => c.argv[1] === 'volume' && c.argv[2] === 'rm')!.argv;
    expect(rmVolumes).toContain('buildx_buildkit_lazy-trybuild-old0_state');
    expect(rmVolumes).not.toContain(`${liveNode}_state`);
  });

  // INVARIANT: the daemon reads the Dockerfile through ONE no-follow
  // descriptor. An agent swapping it for a symlink AFTER the path checks and
  // BEFORE the read must not get the daemon to read a file the agent cannot
  // (a credential, a host file) into the build or its output.
  test('a Dockerfile swapped for a symlink between the checks and the read is refused', async () => {
    const secret = join(base, 'daemon-secret.txt');
    await writeFile(secret, 'SUPER-SECRET-TOKEN');
    const calls: Call[] = [];
    const err = await tryBuildTaskDockerfile(root, task, worktree, {
      env: MICROVM,
      run: recorder(calls),
      prepareBases: noBases,
      beforeDockerfileOpen: async () => {
        const df = join(worktree, 'Dockerfile.lazy');
        await rename(df, `${df}.bak`);
        await symlink(secret, df);
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('not a regular file');
    expect(err.message).not.toContain('SUPER-SECRET');
    expect(calls).toEqual([]);
  });

  test('a Dockerfile in a directory that resolves outside the worktree is refused', async () => {
    const outsideDir = join(base, 'outside');
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, 'agents.Dockerfile'), 'FROM alpine\n');
    await symlink(outsideDir, join(worktree, 'docker'));
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = "docker/agents.Dockerfile"\n');
    const err = await tryBuildTaskDockerfile(root, task, worktree, { env: MICROVM, run: recorder([]), prepareBases: noBases }).catch((e) => e);
    expect(err.message).toContain('outside');
  });

  // INVARIANT: one try-build per task, reserved before the first await — two
  // calls for the same task arriving together cannot both start.
  test('two concurrent calls for one task: the second is refused', async () => {
    const results = await Promise.allSettled([
      tryBuildTaskDockerfile(root, task, worktree, { env: MICROVM, run: recorder([]), prepareBases: noBases }),
      tryBuildTaskDockerfile(root, task, worktree, { env: MICROVM, run: recorder([]), prepareBases: noBases }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason.message).toContain('already running');
  });

  test('a Dockerfile over the size cap is refused', async () => {
    await writeFile(join(worktree, 'Dockerfile.lazy'), 'FROM alpine\n' + '#'.repeat(1024 * 1024 + 10));
    const err = await tryBuildTaskDockerfile(root, task, worktree, { env: MICROVM, run: recorder([]), prepareBases: noBases }).catch((e) => e);
    expect(err.message).toContain('larger than');
  });
});
