/**
 * Terminals on the smolvm runner: the web shell's exec, `lazy pair`'s and
 * `lazy shell`'s client, all reach the project's machine's engine — through
 * this process's relay (`smolvm machine exec -i … docker system dial-stdio`,
 * faked here by a process that pipes its stdio to the fake Engine API) —
 * never the host's own Docker.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { createSmolvmRunner, closeSmolvmRelaysForTests, type SmolvmRunnerDeps } from '../../src/runner/smolvm-runner';
import { containerCliOf } from '../../src/runner/container-cli';
import { ExecStream } from '../../src/runner/docker-exec-stream';
import { resolveRunShellTarget, resolveShellContainer } from '../../src/server/shell-ws';
import { pairInContainerCmd } from '../../src/supervisor/pair';
import { readFile } from 'fs/promises';
import type { Task, Session } from '../../src/types';
import { buildPairExecArgs } from '../../src/cli/commands/pair-container';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import type { ResolvedConfig } from '../../src/config/types';
import type { DialedProcess } from '../../src/vm/docker-relay';
import type { SmolvmRunner as SmolvmCli } from '../../src/vm/smolvm-docker-machine';
import { soloMachineName, type SoloShareInputs } from '../../src/vm/smolvm-project-machine';
import { startFakeEngine, type FakeEngine } from '../helpers/fake-docker-engine';

let root: string;
let engine: FakeEngine;
beforeEach(async () => { root = await realpath(await mkdtemp(join('/tmp', 'svt-'))); });
afterEach(async () => {
  await closeSmolvmRelaysForTests();
  engine?.stop();
  await rm(root, { recursive: true, force: true });
});

/** dial-stdio's stand-in: this process's stdio IS one connection to the engine socket. */
const DIAL_STDIO = `
const conn = await Bun.connect({ unix: process.argv[2], socket: {
  data(_s, d) { process.stdout.write(d); },
  close() { process.exit(0); },
} });
for await (const c of Bun.stdin.stream()) conn.write(c);
conn.end();
`;

/** A docker CLI stand-in that says which engine it was aimed at and with what. */
const DOCKER = (log: string) => `#!/bin/sh\necho "host=$DOCKER_HOST args=$*" | tee -a '${log}'\n`;

async function smolvmRunner() {
  const dial = join(root, 'dial.ts');
  await writeFile(dial, DIAL_STDIO);
  const docker = join(root, 'docker');
  await writeFile(docker, DOCKER(join(root, 'docker-calls.log')));
  await chmod(docker, 0o755);
  const project = join(root, 'proj');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'sock'), { recursive: true });
  const image = join(root, 'lazy-daemon.tar');
  await writeFile(image, 'tar');
  engine = startFakeEngine(join(root, 'guest-engine.sock'), { allowExec: true });

  const config = structuredClone(DEFAULT_CONFIG) as ResolvedConfig;
  config.runner.type = 'smolvm';
  config.smolvm = { ...config.smolvm, binary: '/opt/smolvm/smolvm', image };
  const machine = soloMachineName(project);
  const cli: SmolvmCli = async (argv) => argv[1] === 'ls'
    ? { exitCode: 0, stdout: JSON.stringify([{ name: machine, state: 'running' }]), stderr: '' }
    : { exitCode: 0, stdout: '', stderr: '' };
  const shares: SoloShareInputs = {
    projectRoot: project, gitCommonDir: join(project, '.git'), protocolProjectDir: project, agentBinDir: project,
    mcpConfigDir: project, oneshotDir: project, mounts: [], runArgSources: [],
  };
  const deps: SmolvmRunnerDeps = {
    stateRoot: join(root, 'state'),
    socketRoot: join(root, 'sock'),
    dockerCli: docker,
    verifyBinary: async (p) => p,
    cli: () => cli,
    dial: () => () => Bun.spawn(['bun', dial, engine.socketPath], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }) as unknown as DialedProcess,
    shareInputs: async () => shares,
  };
  return createSmolvmRunner(project, config, deps);
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(25);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

describe('terminals on the smolvm runner go to the machine\'s engine', () => {
  // INVARIANT: a terminal on a smolvm task streams over this process's relay to
  // the machine's engine, never the host's Docker socket. The host's engine
  // (Docker Desktop, if any) has none of the task's containers.
  test('the web shell target names the runner\'s client and its relay socket', async () => {
    const runner = await smolvmRunner();
    const target = await resolveRunShellTarget(root, { slug: 'abc' }, async () => Object.assign(runner, { isRunning: async () => true }));
    expect(target.available).toBe(true);
    if (!target.available) return;
    expect(target.binary).toBe(containerCliOf(runner));
    expect(target.binary).not.toBe('docker');
    expect(target.engineSocket).toBe(runner.engineSocketPath()!);
    expect(target.engineSocket).not.toBe(engine.socketPath);
  });

  test('a PTY exec through the relay: output, keystrokes, resize, and an exit ends it', async () => {
    const runner = await smolvmRunner();
    let out = '';
    let exited: number | null | undefined;
    const exec = new ExecStream({
      socketPath: runner.engineSocketPath()!,
      container: 'lazy-task-1',
      cmd: ['sh'],
      cols: 100,
      rows: 30,
      onData: (d) => { out += Buffer.from(d).toString('latin1'); },
      onExit: (code) => { exited = code; },
    });
    await exec.start();
    await until(() => out.includes('exec:lazy-task-1'), 'the exec banner');
    expect(engine.execCreates).toEqual(['lazy-task-1']);
    // Raw bytes both ways: control characters survive the relay untouched.
    exec.write(new TextEncoder().encode('hi\x1b[A\x03'));
    await until(() => out.includes('hi\x1b[A\x03'), 'the echoed keystrokes');
    await exec.resize(120, 40);
    await until(() => engine.resizes.length === 2, 'the resizes');
    expect(engine.resizes).toEqual(['/exec/exec-1/resize?h=30&w=100', '/exec/exec-1/resize?h=40&w=120']);
    exec.write(new TextEncoder().encode('exit\r'));
    await until(() => exited !== undefined, 'the exec to end');
    expect(exited).toBe(0);
  });

  test('closing the stream hangs the exec up in the guest', async () => {
    const runner = await smolvmRunner();
    let out = '';
    const exec = new ExecStream({
      socketPath: runner.engineSocketPath()!, container: 'lazy-task-1', cmd: ['sh'], cols: 80, rows: 24,
      onData: (d) => { out += Buffer.from(d).toString('latin1'); }, onExit: () => {},
    });
    await exec.start();
    await until(() => out.includes('exec:lazy-task-1'), 'the exec banner');
    exec.close();
    await until(() => engine.streamsClosed() === 1, 'the guest stream to close');
  });

  // INVARIANT: `lazy pair` and `lazy shell` exec through the runner's client,
  // which is aimed at the relay — a bare `docker` would reach the host's engine.
  test('lazy pair\'s and lazy shell\'s exec is the runner\'s client, aimed at the relay', async () => {
    const runner = await smolvmRunner();
    const argv = buildPairExecArgs({
      binary: containerCliOf(runner), containerName: 'lazy-task-1', taskId: 't', worktreePath: root,
      harness: 'claude-code', runnerType: 'smolvm', tty: false,
    });
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, DOCKER_HOST: 'unix:///var/run/docker.sock' } });
    const said = await new Response(proc.stdout).text();
    expect(said).toContain(`host=unix://${runner.engineSocketPath()}`);
    expect(said).toContain('args=exec -i lazy-task-1');
  });

  // INVARIANT: the in-container half of pair is told `docker` on smolvm — the
  // container runs on the machine's Docker engine, and `lazy-agent pair` cannot
  // build a smolvm runner (it has no project), so `--runner smolvm` crashed it.
  test('pair and chat tell the in-container agent the docker runner', () => {
    const cmd = pairInContainerCmd({ taskId: 't', worktreePath: '/w', harness: 'claude-code', runnerType: 'smolvm' });
    expect(cmd[cmd.indexOf('--runner') + 1]).toBe('docker');
    const podman = pairInContainerCmd({ taskId: 't', worktreePath: '/w', harness: 'claude-code', runnerType: 'podman' });
    expect(podman[podman.indexOf('--runner') + 1]).toBe('podman');
  });

  // INVARIANT: the dashboard's task shell is offered on smolvm (the refusal is
  // gone) and aims at the relay, not the host engine.
  test('a smolvm task\'s dashboard shell resolves to the relay', async () => {
    const runner = await smolvmRunner();
    const task = { id: 'task-1', code: 'shell-task' } as unknown as Task;
    const session = { id: 's1', runner_type: 'smolvm', container_name: 'lazy-task-1' } as unknown as Session;
    const target = await resolveShellContainer(root, task, session, async () => runner);
    expect(target.available).toBe(true);
    if (!target.available) return;
    expect(target.binary).toBe(containerCliOf(runner));
    expect(target.engineSocket).toBe(runner.engineSocketPath()!);
  });

  test('lazy shell\'s interactive exec runs the runner\'s client with -it, aimed at the relay', async () => {
    const runner = await smolvmRunner();
    await runner.execInRun('lazy-task-1', ['sh'], { interactive: true });
    const log = await readFile(join(root, 'docker-calls.log'), 'utf-8');
    expect(log).toContain(`host=unix://${runner.engineSocketPath()} args=exec -it lazy-task-1 sh`);
  });
});
