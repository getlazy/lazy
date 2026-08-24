/**
 * INVARIANT — THE BUILDER SCRATCH DIR IS FOR THE BUILDER AND THE HUMAN, NEVER
 * FOR A TASK AGENT.
 *
 * The scratch dir exists so the builder can leave documents, scripts, dumps and
 * long accept/review messages somewhere the human can read them — the repo is
 * mounted read-only and the host builder is sandboxed to the worktree. Its whole
 * design rests on two properties, both asserted here:
 *
 *   1. It lives OUTSIDE the repository tree, so it cannot be committed by
 *      construction — no .gitignore entry to forget or edit away — and cannot be
 *      reached from an agent worktree.
 *   2. NO agent launch path mounts it. If agents could see it, the builder would
 *      start writing code there and telling agents to copy it in, dissolving the
 *      builder/agent separation the whole system depends on. An agent-visible
 *      scratch dir is worse than no scratch dir.
 *
 * Do not relax this test. Making the scratch dir reachable by agents is a design
 * reversal, not a test edit.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join, relative, isAbsolute, resolve } from 'path';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'fs/promises';
import {
  builderScratchDir,
  ensureBuilderScratchDir,
  getScratchBaseDir,
  scratchDirSize,
  formatScratchBytes,
  SCRATCH_ENV_VAR,
} from '../../src/builder/scratch';
import { buildBuilderDockerArgs } from '../../src/runner/docker-runner';
import { buildDockerArgs, buildSupervisorDockerArgs } from '../../src/capture/claude';
import { buildAgentSandboxArgs, buildBuilderPermissionArgs } from '../../src/runner/host-sandbox';
import type { HostPermissionConfig } from '../../src/runner/host-sandbox';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { validateMount, buildMountArgs } from '../../src/capture/mounts';

/** True when `fn` threw — used to name WHICH case failed in the assertion. */
function threw(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const PROJECT_ROOT = '/tmp/lazy-scratch-project';
const HOME = '/home/tester';

/** Every `-v` mount SOURCE (the host side) in a docker/podman argv. */
function mountSources(argv: string[]): string[] {
  const sources: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== '-v') continue;
    const spec = argv[i + 1];
    // Anonymous volume (`-v /target`) has no host source.
    const parts = spec.split(':');
    if (parts.length >= 2 && isAbsolute(parts[0]!)) sources.push(parts[0]!);
  }
  return sources;
}

function withScratchBase<T>(base: string, fn: () => T): T {
  const previous = process.env.LAZY_SCRATCH_BASE_DIR;
  process.env.LAZY_SCRATCH_BASE_DIR = base;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.LAZY_SCRATCH_BASE_DIR;
    else process.env.LAZY_SCRATCH_BASE_DIR = previous;
  }
}

const SCRATCH_DIR = withScratchBase(join(HOME, '.lazy', 'scratch'), () =>
  builderScratchDir(PROJECT_ROOT));

function builderArgs(binary = 'docker'): string[] {
  return buildBuilderDockerArgs({
    binary,
    builderId: 'a1b2c3d4',
    lazyRoot: PROJECT_ROOT,
    dataDir: `${PROJECT_ROOT}/.lazy`,
    scratchDir: SCRATCH_DIR,
    containerConfigFile: `${PROJECT_ROOT}/.lazy/tmp/builder-container-a1b2c3d4.json`,
    agentBinaryPath: '/usr/local/share/lazy-agent',
    home: HOME,
    neutralCredentialStore: `${PROJECT_ROOT}/.lazy/tmp/creds.json`,
    mergedConfigFile: `${PROJECT_ROOT}/.lazy/builder-claude.json`,
    authEnvVars: [],
    imageName: 'lazy-agent:latest',
    promptFile: `${PROJECT_ROOT}/.lazy/tmp/prompt.txt`,
    claudeExtraArgs: [],
    debug: false,
  });
}

const sandbox = {
  taskId: 'task-a',
  worktreePath: `${PROJECT_ROOT}/.lazy/worktrees/task-a`,
  sandboxPath: `${PROJECT_ROOT}/.lazy/sandboxes/task-a`,
  prompt: 'do the thing',
} as unknown as Parameters<typeof buildDockerArgs>[0];

function agentOneShotArgs(binary = 'docker'): string[] {
  return buildDockerArgs(sandbox, ['claude', '-p', 'x'], '/usr/local/share/lazy-agent',
    'lazy-agent:latest', binary, PROJECT_ROOT, []);
}

function agentSupervisorArgs(binary = 'docker'): string[] {
  return buildSupervisorDockerArgs({
    binary,
    containerName: 'lazy-task-a',
    imageName: 'lazy-agent:latest',
    repoRoot: PROJECT_ROOT,
    sandbox,
    protocolDir: `${PROJECT_ROOT}/.lazy/protocol/task-a`,
    agentBinaryPath: '/usr/local/share/lazy-agent',
    authEnvVars: [],
    customMountArgs: [],
    gitMountArgs: [],
    wrapperScript: 'sleep 1',
  });
}

describe('builder scratch dir location', () => {
  // INVARIANT: outside the repo. This is what makes "cannot be committed" a
  // structural fact rather than a .gitignore promise.
  test('is not inside the project root', () => {
    const rel = relative(PROJECT_ROOT, SCRATCH_DIR);
    expect(rel.startsWith('..')).toBe(true);
  });

  test('is not inside the daemon state dir either', () => {
    withScratchBase(join(HOME, '.lazy', 'scratch'), () => {
      const rel = relative(join(HOME, '.lazy', 'daemon'), builderScratchDir(PROJECT_ROOT));
      expect(rel.startsWith('..')).toBe(true);
    });
  });

  test('defaults under ~/.lazy/scratch and is keyed per project', () => {
    withScratchBase(join(HOME, '.lazy', 'scratch'), () => {
      const a = builderScratchDir('/tmp/project-a');
      const b = builderScratchDir('/tmp/project-b');
      expect(a.startsWith(join(HOME, '.lazy', 'scratch'))).toBe(true);
      expect(a).not.toBe(b);
      // Stable: same root always resolves to the same dir, so artifacts from a
      // previous builder session are still there for the human.
      expect(builderScratchDir('/tmp/project-a')).toBe(a);
    });
  });

  test('LAZY_SCRATCH_BASE_DIR relocates every scratch path together', () => {
    withScratchBase('/tmp/elsewhere', () => {
      expect(getScratchBaseDir()).toBe('/tmp/elsewhere');
      expect(builderScratchDir(PROJECT_ROOT).startsWith('/tmp/elsewhere/')).toBe(true);
    });
  });
});

describe('builder container mounts the scratch dir', () => {
  for (const binary of ['docker', 'podman']) {
    test(`${binary}: mounted read-write at the identical host path`, () => {
      const argv = builderArgs(binary);
      // Identical path on both sides — a path the builder prints must paste
      // straight into a host command.
      expect(argv).toContain(`${SCRATCH_DIR}:${SCRATCH_DIR}`);
      // ...and NOT read-only: the point is that the builder can write there.
      expect(argv).not.toContain(`${SCRATCH_DIR}:${SCRATCH_DIR}:ro`);
    });

    test(`${binary}: path is exported to the builder as an env var`, () => {
      expect(builderArgs(binary)).toContain(`${SCRATCH_ENV_VAR}=${SCRATCH_DIR}`);
    });
  }
});

describe('NO agent launch path can reach the builder scratch dir', () => {
  for (const binary of ['docker', 'podman']) {
    // INVARIANT: this is the load-bearing property of the whole feature.
    test(`${binary}: agent containers never mount it, or any ancestor of it`, () => {
      for (const argv of [agentOneShotArgs(binary), agentSupervisorArgs(binary)]) {
        for (const source of mountSources(argv)) {
          const rel = relative(resolve(source), resolve(SCRATCH_DIR));
          const wouldExpose = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
          expect(wouldExpose).toBe(false);
        }
        expect(argv.join(' ')).not.toContain(SCRATCH_ENV_VAR);
      }
    });
  }

  // INVARIANT: `[[mounts]]` is the ONE remaining way a host path can reach an
  // agent container, so it must refuse the scratch dir the same way it refuses
  // the daemon state dir. Without this, one lazy.toml entry would quietly undo
  // the whole boundary.
  test('a lazy.toml [[mounts]] entry cannot mount it into an agent container', () => {
    withScratchBase('/tmp/scratch-base', () => {
      const paths = { worktreePath: `${PROJECT_ROOT}/.lazy/worktrees/task-a`, repoRoot: PROJECT_ROOT };
      const cases = [
        ['the scratch base itself', '/tmp/scratch-base'],
        ['one project’s scratch dir', '/tmp/scratch-base/proj-deadbeef'],
        ['an ancestor of the scratch base', '/tmp'],
      ] as const;
      for (const [what, source] of cases) {
        const entry = { type: 'bind' as const, source, target: '/mnt/x' };
        // Refused at config-load time (a plain absolute source)...
        expect({ what, threw: threw(() => validateMount(entry, 0)) })
          .toEqual({ what, threw: true });
        // ...and again at launch, on the fully resolved path.
        expect({ what, threw: threw(() => buildMountArgs([entry], paths)) })
          .toEqual({ what, threw: true });
      }

      // A `..` traversal is invisible to load-time validation, so the launch-time
      // check is what catches it.
      const sneaky = { type: 'bind' as const, source: '/tmp/scratch-base/../scratch-base', target: '/mnt/x' };
      expect(threw(() => buildMountArgs([sneaky], paths))).toBe(true);

      // An unrelated host path is still perfectly mountable.
      const fine = { type: 'bind' as const, source: '/tmp/some-cache', target: '/mnt/cache' };
      expect(buildMountArgs([fine], paths)).toEqual(['-v', '/tmp/some-cache:/mnt/cache']);
    });
  });

  test('agent worktree is never inside the scratch dir', () => {
    const rel = relative(SCRATCH_DIR, sandbox.worktreePath);
    expect(rel.startsWith('..')).toBe(true);
  });

  // INVARIANT: the host runner shares one filesystem between builder and agents,
  // so the boundary there is the deny list, not a mount set. Without this, the
  // scratch dir would be agent-invisible under Docker and agent-readable on the
  // host — a capability boundary that holds only on some runners.
  test('host-runner agents are denied the scratch base dir; the builder is not', () => {
    withScratchBase('/tmp/scratch-base', () => {
      const cfg: HostPermissionConfig = {
        mode: 'sandbox',
        allowedDomains: ['*.anthropic.com'],
        allowWeakerNested: false,
        denyRead: [],
        denyWrite: [],
      };
      const agent = buildAgentSandboxArgs(cfg).join(' ');
      expect(agent).toContain('Read(//tmp/scratch-base/**)');
      expect(agent).toContain('Write(//tmp/scratch-base/**)');
      expect(agent).toContain('Edit(//tmp/scratch-base/**)');
      // Bash + children are confined by the OS sandbox's own denyRead list.
      expect(agent).toContain('/tmp/scratch-base');

      // The builder must NOT be denied its own scratch dir.
      const builder = buildBuilderPermissionArgs(cfg, /*autonomous*/ false).join(' ');
      expect(builder).not.toContain('/tmp/scratch-base');
    });
  });
});

describe('ensureBuilderScratchDir', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp('/tmp/lazy-scratch-test-');
    process.env.LAZY_SCRATCH_BASE_DIR = base;
  });

  afterEach(async () => {
    delete process.env.LAZY_SCRATCH_BASE_DIR;
    await rm(base, { recursive: true, force: true });
  });

  test('creates the dir and returns its path', async () => {
    const dir = await ensureBuilderScratchDir(PROJECT_ROOT);
    expect(dir).toBe(builderScratchDir(PROJECT_ROOT));
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  // WHY 0777: a builder CONTAINER writes as the image's `user`, whose uid need
  // not match the host user's — a 0700 dir is silently unwritable there on any
  // host where they differ, so the capability would exist on some machines only.
  test('is writable by any uid (0777) even if it already existed restrictively', async () => {
    const dir = builderScratchDir(PROJECT_ROOT);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await ensureBuilderScratchDir(PROJECT_ROOT);
    expect((await stat(dir)).mode & 0o777).toBe(0o777);
  });

  // INVARIANT: a repair only ever WIDENS. Bun's chmod cannot set the sticky bit,
  // so a human who sets 1777 by hand on a multi-user host must not have it
  // silently stripped by the next builder launch.
  test('never narrows bits the human set deliberately', async () => {
    const dir = await ensureBuilderScratchDir(PROJECT_ROOT);
    // chmod(2) via the shell — Bun's chmod masks the sticky bit away.
    spawnSyncUnsupervised(['chmod', '1777', dir]);
    const before = (await stat(dir)).mode & 0o7777;
    if (before !== 0o1777) return; // filesystem doesn't keep sticky — nothing to assert
    await ensureBuilderScratchDir(PROJECT_ROOT);
    expect((await stat(dir)).mode & 0o7777).toBe(0o1777);
  });

  // INVARIANT: persistent across builder sessions — nothing auto-wipes it. The
  // human may read an artifact long after the session that wrote it is gone.
  test('preserves existing contents across calls', async () => {
    const dir = await ensureBuilderScratchDir(PROJECT_ROOT);
    await writeFile(join(dir, 'accept-msg.md'), 'ship it');
    await ensureBuilderScratchDir(PROJECT_ROOT);
    expect(await Bun.file(join(dir, 'accept-msg.md')).text()).toBe('ship it');
  });
});

describe('scratchDirSize', () => {
  test('reports zero for a dir that was never created', async () => {
    expect(await scratchDirSize('/tmp/definitely-not-here-lazy-scratch')).toEqual({ bytes: 0, entries: 0 });
  });

  test('counts top-level entries and total bytes recursively', async () => {
    const dir = await mkdtemp('/tmp/lazy-scratch-size-');
    try {
      await writeFile(join(dir, 'a.txt'), 'x'.repeat(10));
      await mkdir(join(dir, 'sub'));
      await writeFile(join(dir, 'sub', 'b.txt'), 'y'.repeat(5));
      expect(await scratchDirSize(dir)).toEqual({ bytes: 15, entries: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('formats sizes past KB (scratch dirs hold dumps, not just notes)', () => {
    expect(formatScratchBytes(512)).toBe('512 B');
    expect(formatScratchBytes(2048)).toBe('2.0 KB');
    expect(formatScratchBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatScratchBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});
