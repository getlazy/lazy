/**
 * A task's service, running in its `services` tmux session, survives a daemon
 * restart — and its output can be read and a terminal attached afterwards.
 *
 * Everything lazy does here is real, against the project's real FileStorage:
 * the container's PID-1 wrapper (`buildSupervisorWrapperScript`), Start
 * services (`runStartServices` and its in-container script), the whole task
 * half of a daemon restart — the restart reaper (`reapTaskAgents` →
 * `stopTaskAgent` → `DockerRunner.stopAgentInRun` and its in-container
 * script → `interruptForDaemonRestart`) and the auto-resume launch it
 * dispatches (`autoResumeTask` → start-or-recreate → `writeCommand`), run in
 * a subprocess under the NEW daemon's proxy port
 * (test/helpers/restart-resume-entry.ts) — the daemon's session reads
 * (`listTaskSessions` / `readTaskSession`) and the attach argv
 * (`attachSessionArgv`), against a real tmux.
 *
 * The one stand-in is the container runtime: `docker` is a shim whose `exec`
 * runs the command on this machine, with every container path under
 * `/tmp/lazy-` moved into a scratch dir, and which logs every other call — so
 * the suite runs without Docker, sees whether lazy recreated anything, and
 * never touches a real lazy supervisor running alongside it (the agent stop's
 * fallback scan is narrowed to this suite's own stand-in too). The supervisor
 * is a stand-in that keeps the command it is handed.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { buildSupervisorWrapperScript } from '../../src/capture/claude';
import { runStartServices } from '../../src/daemon/serve-run';
import { listTaskSessions, readTaskSession } from '../../src/daemon/task-sessions';
import { attachSessionArgv, TMUX_SOCKET } from '../../src/sessions/tmux';
import { FileStorage } from '../../src/storage';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import { getWorktreePathForRef, taskRef } from '../../src/task/identity';
import { hardwareTestEnv } from '../helpers/hardware-env';
import { ENVIRONMENT_REPLACED_KEY, LAST_ENVIRONMENT_REPLACED_KEY } from '../../src/task/environment-replaced';

const RESTART_ENTRY = resolve(__dirname, '../helpers/restart-resume-entry.ts');

const hasTmux = Bun.which('tmux') !== null;
const hasScript = Bun.which('script') !== null;
if (!hasTmux) console.log('skip: task sessions survive a daemon restart — tmux is not on PATH; the task container (lazy\'s runner image) always has it');

let root = '';
const leftovers: Array<() => Promise<void>> = [];
const savedEnv: Record<string, string | undefined> = {};
let fixtureEnv: Record<string, string | undefined>;

afterEach(async () => {
  for (const undo of leftovers.splice(0).reverse()) await undo();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, env: fixtureEnv, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${err}`);
  return out.trim();
}

/**
 * The `docker` shim. `exec [-i] [-t] [-w dir] [-e K=V] <container> argv…` runs
 * argv here, with `/tmp/lazy-` → `<root>/c/lazy-` in every argument and the
 * agent stop's command-line scan narrowed to this suite's protocol dir. `ps`
 * names the container as running; `inspect` says running and kept. Every call
 * but `exec` is logged, so a test sees a `run` or `rm` lazy should not make.
 */
async function installDockerShim(bin: string, containerTmp: string, protoDir: string, container: string, log: string): Promise<string> {
  const shim = join(bin, 'docker');
  await writeFile(shim, [
    '#!/usr/bin/env bash',
    `[ "$1" = exec ] || printf '%s\\n' "$*" >> "${log}"`,
    'case "$1" in',
    `  ps) echo ${container}-id; exit 0;;`,
    '  inspect) echo "true 1"; exit 0;;',
    '  exec) shift',
    '    while [ $# -gt 0 ]; do case "$1" in -i|-t|-it|-ti) shift;; -w|-e|-u|--workdir) shift 2;; *) break;; esac; done',
    '    shift  # the container',
    '    args=()',
    '    for a in "$@"; do',
    `      a="\${a//\\/tmp\\/lazy-/${containerTmp}/lazy-}"`,
    `      a="\${a//--protocol-dir\\*)/--protocol-dir*${protoDir}*)}"`,
    '      args+=("$a")',
    '    done',
    '    exec "${args[@]}";;',
    '  *) exit 0;;',
    'esac',
  ].join('\n'));
  await chmod(shim, 0o755);
  return shim;
}

function spawnText(argv: string[], timeoutMs = 20_000, cwd?: string) {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', env: fixtureEnv, ...(cwd ? { cwd } : {}) });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    .finally(() => clearTimeout(timer));
}

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

describe('a task\'s services session across a daemon restart', () => {
  // INVARIANT: a daemon restart stops the task's AGENT, never its container:
  // the services in its tmux sessions keep running, unrestarted, and their
  // output stays readable and attachable afterwards; the resumed turn REUSES
  // the container (nothing is created or removed), the session keeps the
  // container's name and agent stamp, and the resumed command carries the new
  // daemon's proxy port. The restart used to stop the container and the next
  // launch recreated it, throwing away the running services and everything
  // installed outside the worktree.
  test.skipIf(!hasTmux)('the service keeps running, the turn resumes in the same container, output reads, a terminal attaches', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-sessions-e2e-')));
    const project = join(root, 'project');
    const store = join(root, 'store');
    const bin = join(root, 'bin');
    const containerTmp = join(root, 'c');
    for (const d of [project, store, bin, containerTmp]) await mkdir(d, { recursive: true });
    fixtureEnv = hardwareTestEnv({
      LAZY_TEST: '1',
      LAZY_PROTOCOL_BASE: join(root, 'protocol'),
      LAZY_DAEMON_BASE_DIR: join(root, 'daemon'),
      PATH: `${bin}:${process.env.PATH}`,
      // The resume plans a credential for the turn; the proxy never sees this one.
      ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing',
    });
    // In-process daemon calls need the same isolation as the subprocesses.
    // Restore the outer task's state only after every fixture has been reaped.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LAZY_')) setEnv(key, undefined);
    }
    for (const [key, value] of Object.entries(fixtureEnv)) {
      if (key.startsWith('LAZY_') || key === 'PATH' || key === 'ANTHROPIC_API_KEY') setEnv(key, value);
    }

    // A real project and store: one task, `working`, whose session records the
    // container it runs in and the agent it was created for.
    await git(project, 'init', '-q', '-b', 'main');
    await git(project, 'config', 'user.email', 'test@lazy.test');
    await git(project, 'config', 'user.name', 'Lazy Test');
    await writeFile(join(project, 'lazy.toml'), `[remote]\noffline = true\n\n[storage]\nbackend = "external"\nexternal_path = "${store}"\n`);
    await git(project, 'add', '.');
    await git(project, 'commit', '-qm', 'base');
    const baseSha = await git(project, 'rev-parse', 'HEAD');
    const storage = new FileStorage(project, { basePath: store });
    await storage.initialize();
    leftovers.push(async () => { await storage.close(); });
    const created = await storage.createTask('services across a restart', undefined, baseSha);
    const ref = taskRef(created);
    const container = `lazy-${ref}`;
    const branch = `lazy/${ref}`;
    const sess = await storage.createSession(created.id, 'claude-code', branch, baseSha);
    await git(project, 'branch', branch, baseSha);
    const worktree = getWorktreePathForRef(project, ref);
    await mkdir(dirname(worktree), { recursive: true });
    await git(project, 'worktree', 'add', '-q', worktree, branch);
    await storage.updateSessionRunnerType(sess.id, 'docker');
    await storage.updateSessionContainerName(sess.id, container, 'claude-code');
    await storage.updateTaskStatus(created.id, 'working', 'system');
    const protoDir = getProtocolDir(created.id);
    await mkdir(protoDir, { recursive: true });

    const dockerLog = join(root, 'docker.log');
    const shim = await installDockerShim(bin, containerTmp, protoDir, container, dockerLog);

    // The supervisor stand-in the wrapper runs: counts its starts, then waits
    // for a command in its protocol dir and keeps a copy of it.
    await writeFile(join(bin, 'lazy-agent'), [
      '#!/bin/sh',
      `n=$(($(cat "${root}/supervisor-starts" 2>/dev/null | wc -l) + 1)); echo start >> "${root}/supervisor-starts"`,
      `while [ ! -f "${protoDir}/command.json" ]; do sleep 0.1; done`,
      `cp "${protoDir}/command.json" "${root}/received-$n.json"`,
      'exec sleep 600',
    ].join('\n'));
    await chmod(join(bin, 'lazy-agent'), 0o755);
    leftovers.push(async () => {
      await Bun.spawn(['tmux', '-S', TMUX_SOCKET.replace('/tmp/lazy-', `${containerTmp}/lazy-`), 'kill-server'], { env: fixtureEnv, stdout: 'ignore', stderr: 'ignore' }).exited;
    });

    // The container's PID 1: the real wrapper, run "in the container".
    const wrapper = Bun.spawn([shim, 'exec', container, 'sh', '-c', buildSupervisorWrapperScript(protoDir, worktree)], {
      stdout: 'ignore', stderr: 'pipe', env: fixtureEnv,
    });
    leftovers.push(async () => {
      wrapper.kill('SIGKILL');
      const pidFile = join(containerTmp, 'lazy-supervisor.pid');
      try { process.kill(Number((await readFile(pidFile, 'utf-8')).trim()), 'SIGKILL'); } catch { /* already gone */ }
    });
    const starts = async () => (await readFile(join(root, 'supervisor-starts'), 'utf-8').catch(() => '')).trim().split('\n').filter(Boolean).length;
    await waitFor('the first supervisor', async () => (await starts()) === 1);

    // Start services: the real daemon operation, into the services session.
    const started = await runStartServices(project, { taskId: created.id }, {
      getStorage: async () => storage,
      resolveCmd: async () => 'i=0; while :; do i=$((i+1)); echo tick-$i; sleep 0.2; done',
      ensureContainer: async () => ({ containerName: container, worktreePath: worktree, runnerType: 'docker', alreadyRunning: true }),
      // The argv lazy built, with `docker` resolved to the shim.
      exec: async (argv, timeoutMs) => {
        expect(argv[0]).toBe('docker');
        const [stdout, stderr, exitCode] = await spawnText([shim, ...argv.slice(1)], timeoutMs);
        return { exitCode, stdout, stderr };
      },
    });
    expect(started.containerName).toBe(container);

    const sessionDeps = {
      getStorage: async () => storage,
      containerTarget: async () => ({ binary: shim, name: container }),
    };
    const before = await listTaskSessions(project, { taskId: created.id }, sessionDeps);
    const servicesBefore = before.sessions.find(s => s.name === 'services');
    expect(servicesBefore?.alive).toBe(true);
    const ticksIn = async () => {
      const read = await readTaskSession(project, { taskId: created.id, name: 'services', logBytes: 4096 }, sessionDeps);
      const all = [...(read.output?.log ?? '').matchAll(/tick-(\d+)/g)].map(m => Number(m[1]));
      return all.length ? Math.max(...all) : 0;
    };
    const ticksBeforeRestart = await waitFor('the service to print', async () => (await ticksIn()) >= 2 && ticksIn());

    // The daemon restart, task half: the reaper stops the agent in the
    // container, marks the turn interrupted, and the auto-resume launches it
    // again — under the NEW daemon's proxy port.
    await writeFile(dockerLog, '');
    const NEW_PROXY_PORT = 45678;
    // Run from the project, as the daemon runs: nothing may resolve a project
    // from wherever the test runner happens to be.
    const [out, err, code] = await spawnText(['bun', 'run', RESTART_ENTRY, project, store, container, String(NEW_PROXY_PORT)], 60_000, project);
    if (code !== 0) throw new Error(`restart entry failed (${code}):\n${err}\n${out}`);
    const result = JSON.parse(out.trim().split('\n').pop()!);
    expect(result.interrupted).toHaveLength(1);
    // The auto-resume launched the turn again.
    expect(result.status).toBe('working');
    // The session keeps the container's name and the agent it was created for.
    expect(result).toMatchObject({ container_name: container, container_agent_id: 'claude-code' });
    // Keeping the environment must not tell the agent or person it was lost.
    expect(await storage.getTaskMetadata(created.id, ENVIRONMENT_REPLACED_KEY)).toBeNull();
    expect(await storage.getTaskMetadata(created.id, LAST_ENVIRONMENT_REPLACED_KEY)).toBeNull();
    expect((await storage.getTaskJournal(created.id)).filter(entry => /Container replaced/.test(entry.content))).toEqual([]);

    // The container was reused: nothing was created, started or removed.
    const calls = (await readFile(dockerLog, 'utf-8')).split('\n').filter(Boolean);
    expect(calls.filter(c => /^(run|create|rm|start|stop|kill)\b/.test(c))).toEqual([]);

    // The wrapper started a fresh supervisor instead of exiting, and that
    // supervisor was handed the resumed turn's command, carrying the new port.
    await waitFor('the wrapper to start a fresh supervisor', async () => (await starts()) === 2);
    expect(wrapper.exitCode).toBeNull();
    const received = await waitFor('the resumed command', async () => readFile(join(root, 'received-2.json'), 'utf-8').catch(() => null))
      .catch((e: Error) => { throw new Error(`${e.message}\n--- restart entry output ---\n${out}\n${err}`); });
    expect(JSON.parse(received).proxy_port).toBe(NEW_PROXY_PORT);

    // The service was never touched: same session, same process, still printing.
    const after = await listTaskSessions(project, { taskId: created.id }, sessionDeps);
    const servicesAfter = after.sessions.find(s => s.name === 'services');
    expect(servicesAfter).toMatchObject({ alive: true, pid: servicesBefore!.pid, createdAt: servicesBefore!.createdAt });
    await waitFor('the service to keep printing', async () => (await ticksIn()) > ticksBeforeRestart + 2);

    // Its live screen reads without attaching.
    const read = await readTaskSession(project, { taskId: created.id, name: 'services' }, sessionDeps);
    expect(read.output?.screen).toMatch(/tick-\d+/);

    // And a terminal attaches to it: the argv the attach route runs, under a pty.
    if (hasScript) {
      const attach = [shim, 'exec', '-it', container, ...attachSessionArgv('services', { readOnly: true })].join(' ');
      // The viewer is detached after a moment, which ends the attach cleanly.
      // TERM as the attach route sets it.
      const socket = TMUX_SOCKET.replace('/tmp/lazy-', `${containerTmp}/lazy-`);
      const body = `export TERM=xterm-256color; (sleep 2; tmux -S ${socket} detach-client -s =services) & exec ${attach}`;
      const scriptArgv = process.platform === 'darwin'
        ? ['script', '-q', '/dev/null', 'sh', '-c', body]
        : ['script', '-qfec', body, '/dev/null'];
      const [screen] = await spawnText(scriptArgv, 15_000);
      expect(screen).toMatch(/tick-\d+/);
    } else {
      console.log('skip: the attach leg — `script` is not on PATH to give tmux a terminal');
    }
  }, 120_000);
});
