/**
 * Default: real Docker CLI + fake Engine API, no Docker engine or VM required.
 * Mac/Docker Desktop: LAZY_REAL_DOCKER_RELAY=1 bun test test/e2e/docker-relay.test.ts
 * also checks the production relay dialing the host's real docker system dial-stdio.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { startDockerRelay, type DialedProcess, type RelayHandle } from '../../src/vm/docker-relay';
import { hardwareTestEnv } from '../helpers/hardware-env';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import { createSmolvmRunner, closeSmolvmRelaysForTests, SmolvmLivenessUnknownError } from '../../src/runner/smolvm-runner';
import { soloMachineName } from '../../src/vm/smolvm-project-machine';
import { setupTestLazy } from '../helpers/setup';

const docker = Bun.which('docker');
if (!docker) console.log('skipped: test/e2e/docker-relay.test.ts — no Docker CLI on PATH');
const realEngine = process.env.LAZY_REAL_DOCKER_RELAY === '1';
if (!realEngine) console.log('skipped: real-engine docker relay — LAZY_REAL_DOCKER_RELAY=1 is not set');

async function run(socket: string | null, args: string[], input = '', timeout = 30_000) {
  const proc = Bun.spawn([docker!, ...(socket ? ['--host', `unix://${socket}`] : []), ...args], {
    // --host must override the person's active context and TLS settings. The
    // dial itself uses their normal engine selection, isolated from LAZY_*.
    env: hardwareTestEnv(socket ? { DOCKER_CONTEXT: undefined, DOCKER_TLS_VERIFY: undefined, DOCKER_CERT_PATH: undefined } : {}),
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout,
  });
  if (input) proc.stdin.write(input);
  proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect(code, `docker ${args.join(' ')}: ${stderr}`).toBe(0);
  return { stdout, stderr };
}

async function withRelay(dial: (root: string) => DialedProcess, check: (relay: RelayHandle) => Promise<void>) {
  // /tmp keeps even macOS's socket path below its 103-byte limit.
  const root = await mkdtemp('/tmp/lazy-dr-');
  const children: DialedProcess[] = [];
  let relay: RelayHandle | undefined;
  try {
    relay = await startDockerRelay({
      socketPath: join(root, 'd.sock'), ensureServing: async () => {},
      dial: () => { const child = dial(root); children.push(child); return child; },
    });
    await check(relay);
  } finally {
    // Docker leaves ordinary HTTP keep-alives behind. Reap every dial before
    // waiting for the listener to close, on assertion failures as well.
    for (const child of children) child.kill();
    await Promise.all(children.map(child => child.exited));
    await relay?.close();
    await rm(root, { recursive: true, force: true });
  }
}

function fakeDial(mode: string): (root: string) => DialedProcess {
  return root => Bun.spawn([process.execPath, join(import.meta.dir, '../helpers/docker-relay-engine.ts'), mode, join(root, 'completed')], {
    env: hardwareTestEnv(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  }) as unknown as DialedProcess;
}

describe.skipIf(!docker)('Docker CLI through the relay, with a fake engine', () => {
  // INVARIANT: the production supervisor launch prepares a readable single-file
  // MCP mount for a different guest UID, without opening its host directory.
  test('a smolvm supervisor launch delivers its MCP handoff to a different guest UID', async () => {
    const ctx = await setupTestLazy({ inheritedEnv: hardwareTestEnv() });
    try {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../helpers/smolvm-launch-fixture.ts'), ctx.root, ctx.protocolBase, docker!], {
        cwd: ctx.root, env: hardwareTestEnv({ LAZY_PROTOCOL_BASE: ctx.protocolBase,
          LAZY_DAEMON_BASE_DIR: join(ctx.root, 'daemon'), LAZY_CONFIG: join(ctx.root, 'lazy.toml') }),
        stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code, stdout + stderr).toBe(0);
      const launch = JSON.parse(await Bun.file(join(ctx.root, 'launch.json')).text());
      expect(launch.guestUid).not.toBe(launch.hostUid);
      expect(launch.hostDirectoryMode).toBe(0o700);
      expect(launch.content).toBe('{"token":"fixture-only"}');
      expect(launch.binds).toContain(`${launch.configPath}:${launch.configPath}:ro`);
    } finally {
      await ctx.cleanup();
    }
  }, 150_000);

  // INVARIANT: the reconciler's smolvm liveness probe sees a live guest
  // container through the real Docker CLI; a failed engine is unknown, never dead.
  test('smolvm ps and inspect agree for live, exited, absent and unreachable containers', async () => {
    const root = await mkdtemp('/tmp/lazy-live-');
    const children: DialedProcess[] = [];
    try {
      const config = structuredClone(DEFAULT_CONFIG);
      config.runner.type = 'smolvm';
      config.smolvm.binary = '/fixture/smolvm';
      const runner = await createSmolvmRunner(root, config, {
        stateRoot: join(root, 'state'), socketRoot: '/tmp', dockerCli: docker,
        verifyBinary: async path => path,
        cli: () => async () => ({ exitCode: 0, stdout: JSON.stringify([{ name: soloMachineName(root), state: 'running' }]), stderr: '' }),
        dial: () => () => {
          const child = fakeDial('liveness')(root);
          children.push(child);
          return child;
        },
        shareInputs: async () => { throw new Error('a liveness probe must not launch a machine'); },
      });
      // fakeDial uses <root>/completed as its fixture control file.
      for (const state of ['running', 'exited', 'missing']) {
        await writeFile(join(root, 'completed'), state);
        expect(await runner.isRunning('lazy-live')).toBe(state === 'running');
        expect(await runner.isRunning('lazy-other')).toBe(false);
        const info = await runner.probeRunInfo('lazy-live');
        expect(info.kind).toBe('answered');
        if (info.kind === 'answered') expect(info.info?.running ?? false).toBe(state === 'running');
      }
      await writeFile(join(root, 'completed'), 'broken');
      await expect(runner.isRunning('lazy-live')).rejects.toBeInstanceOf(SmolvmLivenessUnknownError);
      expect((await runner.probeRunInfo('lazy-live')).kind).toBe('no-answer');
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map(child => child.exited));
      await closeSmolvmRelaysForTests();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  // INVARIANT: a hijacked Docker connection preserves stdout and stderr after
  // client SHUT_WR. A separate wait/inspect returning zero cannot prove output arrived.
  test('attached run and non-tty exec preserve output after the 101 and half-close', async () => {
    await withRelay(fakeDial('echo'), async relay => {
      for (const args of [['exec', 'c', 'echo', 'hi'], ['run', '--rm', 'alpine', 'echo', 'hi']]) {
        expect(await run(relay.socketPath, args)).toEqual({ stdout: 'hi\n', stderr: 'stderr\n' });
      }
    });
  }, 60_000);

  // INVARIANT: stdin EOF reaches the engine without ending its output side.
  // Dropping EOF to hide the Bun Unix-socket bug hangs stdin readers instead.
  test('run -i and exec -i receive EOF and return the input afterwards', async () => {
    await withRelay(fakeDial('stdin'), async relay => {
      for (const args of [['run', '-i', '--rm', 'alpine', 'cat'], ['exec', '-i', 'c', 'cat']]) {
        expect(await run(relay.socketPath, args, 'x\n')).toEqual({ stdout: 'x\n', stderr: 'stderr\n' });
        expect(await run(relay.socketPath, args)).toEqual({ stdout: '', stderr: 'stderr\n' });
      }
    });
  }, 60_000);

  test('large multiplexed output is flushed before the connection ends', async () => {
    await withRelay(fakeDial('bulk'), async relay => {
      expect(await run(relay.socketPath, ['exec', 'c', 'echo', 'hi'])).toEqual({
        stdout: 'x'.repeat(512 * 1024) + '\n', stderr: 'stderr\n',
      });
    });
  }, 60_000);

  test('tty exec preserves the raw output stream', async () => {
    await withRelay(fakeDial('tty'), async relay => {
      expect(await run(relay.socketPath, ['exec', '-t', 'c', 'echo', 'hi'])).toEqual({ stdout: 'hi\n', stderr: '' });
    });
  }, 60_000);
});

describe.skipIf(!docker || !realEngine)('Docker relay against the host engine (opt in)', () => {
  test('attached run, exec, and stdin EOF behave like the local engine', async () => {
    await run(null, ['info']);
    await run(null, ['pull', 'alpine'], '', 180_000);
    await withRelay(() => Bun.spawn([docker!, 'system', 'dial-stdio'], {
      env: hardwareTestEnv(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout: 0,
    }) as unknown as DialedProcess, async relay => {
      expect((await run(relay.socketPath, ['run', '--rm', 'alpine', 'echo', 'hi'])).stdout).toBe('hi\n');
      expect((await run(relay.socketPath, ['run', '-i', '--rm', 'alpine', 'cat'], 'x\n')).stdout).toBe('x\n');
      expect((await run(relay.socketPath, ['run', '-i', '--rm', 'alpine', 'sh', '-c', 'cat; echo after-eof'])).stdout).toBe('after-eof\n');
      const id = (await run(relay.socketPath, ['run', '-d', 'alpine', 'sleep', '120'])).stdout.trim();
      try {
        expect(await run(relay.socketPath, ['exec', id, 'sh', '-c', 'echo hi; echo stderr >&2'])).toEqual({ stdout: 'hi\n', stderr: 'stderr\n' });
        expect((await run(relay.socketPath, ['exec', '-i', id, 'cat'], 'x\n')).stdout).toBe('x\n');
        expect((await run(relay.socketPath, ['exec', '-i', id, 'sh', '-c', 'cat; echo after-eof'])).stdout).toBe('after-eof\n');
      } finally {
        await run(relay.socketPath, ['rm', '-f', id]);
      }
    });
  }, 300_000);
});
