/**
 * A daemon restart stops the AGENT in a task's container, never the container
 * (src/runner/agent-stop.ts). The in-container script runs here under a local
 * `sh` against a stand-in supervisor tree, with its /tmp paths rewritten to a
 * scratch dir.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, chmod, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AGENT_RESTART_MARKER,
  SUPERVISOR_PID_FILE,
  parseAgentStop,
  stopAgentScript,
  stopTaskAgent,
} from '../../src/runner/agent-stop';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('the in-container agent stop', () => {
  let dir: string;
  const leftovers: number[] = [];
  afterEach(async () => {
    for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    await rm(dir, { recursive: true, force: true });
  });

  const local = (script: string) => script
    .replaceAll(AGENT_RESTART_MARKER, join(dir, 'restart-marker'))
    .replaceAll(SUPERVISOR_PID_FILE, join(dir, 'supervisor.pid'));

  async function runStop(pidFileWaitSeconds = 1): Promise<string> {
    const proc = Bun.spawn(['sh', '-c', local(stopAgentScript({ commandMatch: `*--protocol-dir*${dir}/proto*`, pidFileWaitSeconds })), 'lazy-agent-stop', '2'], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return out.trim();
  }

  /** A stand-in supervisor: a `lazy-agent --one-shot --protocol-dir …` with a child (the agent) and a detached grandchild. */
  async function startSupervisor(opts: { writePidFile: boolean }): Promise<{ sup: number; agent: number; detached: number }> {
    const bin = join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'supervisor.sh'), [
      '#!/bin/sh',
      // The agent: a direct child.
      `sleep 311 & echo $! > "${dir}/agent.pid"`,
      // Something the agent started and detached: reparented away, not a descendant.
      `(sleep 312 & echo $! > "${dir}/detached.pid")`,
      'wait',
    ].join('\n'));
    // argv[0] is `lazy-agent`, as for the real (compiled) supervisor.
    const proc = Bun.spawn(['bash', '-c', 'exec -a lazy-agent sh "$0" "$@"', join(bin, 'supervisor.sh'), '--one-shot', '--protocol-dir', join(dir, 'proto'), '--worktree', dir], { stdout: 'ignore', stderr: 'ignore' });
    for (let i = 0; i < 50; i++) {
      if (await Bun.file(join(dir, 'agent.pid')).exists() && await Bun.file(join(dir, 'detached.pid')).exists()) break;
      await Bun.sleep(50);
    }
    const agent = Number((await readFile(join(dir, 'agent.pid'), 'utf-8')).trim());
    const detached = Number((await readFile(join(dir, 'detached.pid'), 'utf-8')).trim());
    leftovers.push(proc.pid, agent, detached);
    if (opts.writePidFile) await writeFile(join(dir, 'supervisor.pid'), `${proc.pid}\n`);
    return { sup: proc.pid, agent, detached };
  }

  // INVARIANT: the agent stop ends the supervisor and what it started, leaves
  // what was detached running, and writes the marker the wrapper restarts on.
  // A daemon restart must not take the task's services and environment with it.
  test('ends the supervisor and its descendants, keeps a detached process, writes the restart marker', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-stop-'));
    const { sup, agent, detached } = await startSupervisor({ writePidFile: true });
    expect(await runStop()).toBe('stopped');
    for (let i = 0; i < 20 && (alive(sup) || alive(agent)); i++) await Bun.sleep(50);
    expect(alive(sup)).toBe(false);
    expect(alive(agent)).toBe(false);
    expect(alive(detached)).toBe(true);
    expect((await Bun.file(join(dir, 'restart-marker')).text()).trim()).toBe(String(sup));
  }, 20_000);

  /**
   * A wrapper-shaped process: `sh -c <script>` whose script text holds
   * `lazy-agent --one-shot --protocol-dir …`, like the real wrapper's. With
   * `current`, its text also names the pid file, as a wrapper that writes one does.
   */
  function startWrapperShaped(opts: { current: boolean }): number {
    const text = `while :; do sleep 1; done; lazy-agent --one-shot --protocol-dir "${dir}/proto" --worktree "${dir}"` +
      (opts.current ? `; echo $! > ${join(dir, 'supervisor.pid')}` : '');
    const proc = Bun.spawn(['sh', '-c', text], { stdout: 'ignore', stderr: 'ignore' });
    leftovers.push(proc.pid);
    return proc.pid;
  }

  test('finds the supervisor by its command line when the wrapper wrote no pid file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-stop-'));
    const { sup } = await startSupervisor({ writePidFile: false });
    expect(await runStop()).toBe('stopped');
    for (let i = 0; i < 20 && alive(sup); i++) await Bun.sleep(50);
    expect(alive(sup)).toBe(false);
  }, 20_000);

  // INVARIANT: the fallback scan never selects the wrapper. Its `sh -c` text
  // holds the same words as the supervisor's command line, /proc is walked in
  // lexical order, and the wrapper's descendants are everything in the
  // container — selecting it would stop the services the stop exists to keep.
  test('an older wrapper listed BEFORE the supervisor is never selected', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-stop-'));
    let wrapper = startWrapperShaped({ current: false });
    let { sup } = await startSupervisor({ writePidFile: false });
    // /proc/[0-9]* is walked lexically: make sure the wrapper comes first.
    for (let i = 0; i < 5 && String(wrapper) > String(sup); i++) {
      process.kill(sup, 'SIGKILL');
      wrapper = startWrapperShaped({ current: false });
      ({ sup } = await startSupervisor({ writePidFile: false }));
    }
    expect(String(wrapper) < String(sup)).toBe(true);
    expect(await runStop()).toBe('stopped');
    for (let i = 0; i < 20 && alive(sup); i++) await Bun.sleep(50);
    expect(alive(sup)).toBe(false);
    expect(alive(wrapper)).toBe(true);
  }, 30_000);

  test('a current wrapper without its pid file yet: waits for the file instead of scanning', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-stop-'));
    const wrapper = startWrapperShaped({ current: true });
    const { sup } = await startSupervisor({ writePidFile: false });
    setTimeout(() => { void writeFile(join(dir, 'supervisor.pid'), `${sup}\n`); }, 400);
    expect(await runStop(3)).toBe('stopped');
    for (let i = 0; i < 20 && alive(sup); i++) await Bun.sleep(50);
    expect(alive(sup)).toBe(false);
    expect(alive(wrapper)).toBe(true);
  }, 30_000);

  test('a current wrapper whose pid file never appears: none, and nothing is scanned for or stopped', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-stop-'));
    const wrapper = startWrapperShaped({ current: true });
    const { sup } = await startSupervisor({ writePidFile: false });
    expect(await runStop(1)).toBe('none');
    expect(alive(sup)).toBe(true);
    expect(alive(wrapper)).toBe(true);
    expect(await Bun.file(join(dir, 'restart-marker')).exists()).toBe(false);
  }, 30_000);

  test('no supervisor: says so and writes no marker', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-stop-'));
    await writeFile(join(dir, 'supervisor.pid'), '999999\n');
    // The scan is narrowed to this test's own dir (runStop), so it can never
    // reach a real supervisor — running this suite inside an agent's container
    // once stopped that agent.
    expect(await runStop()).toBe('none');
    expect(await Bun.file(join(dir, 'restart-marker')).exists()).toBe(false);
  });
});

describe('parseAgentStop', () => {
  test('reads the last line; a failed exec is failed', () => {
    expect(parseAgentStop(0, 'stopped\n')).toBe('stopped');
    expect(parseAgentStop(0, 'none\n')).toBe('none');
    expect(parseAgentStop(1, 'stopped\n')).toBe('failed');
    expect(parseAgentStop(0, '')).toBe('failed');
  });
});

describe('stopTaskAgent', () => {
  // INVARIANT: the guarantee every caller relies on is that the previous
  // agent no longer runs. Keeping the container is the courtesy: when only the
  // agent cannot be stopped, the whole run is.
  test('keeps the run when the agent stop worked, falls back to the run when it did not', async () => {
    const calls: string[] = [];
    const runner = (outcome: 'stopped' | 'none' | 'failed') => ({
      stopRun: async (name: string, opts?: { gracefulTimeoutSeconds?: number }) => { calls.push(`stopRun ${name} ${opts?.gracefulTimeoutSeconds ?? '-'}`); return true; },
      stopAgentInRun: async (name: string) => { calls.push(`agent ${name}`); return outcome; },
    });
    expect(await stopTaskAgent(runner('stopped'), 'lazy-a', { gracefulTimeoutSeconds: 3 })).toEqual({ ok: true, keptRun: true });
    expect(await stopTaskAgent(runner('none'), 'lazy-b')).toEqual({ ok: true, keptRun: true });
    expect(await stopTaskAgent(runner('failed'), 'lazy-c', { gracefulTimeoutSeconds: 1, fallback: null })).toEqual({ ok: true, keptRun: false });
    expect(calls).toEqual(['agent lazy-a', 'agent lazy-b', 'agent lazy-c', 'stopRun lazy-c -']);
  });

  test('a runner whose run IS the agent (host-process) stops the run', async () => {
    let stopped = '';
    expect(await stopTaskAgent({ stopRun: async (n: string) => { stopped = n; return true; } }, 'lazy-h')).toEqual({ ok: true, keptRun: false });
    expect(stopped).toBe('lazy-h');
  });
});
