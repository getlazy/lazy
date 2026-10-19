/**
 * A managed daemon that finds Docker down tries once to bring the guest's
 * dockerd back, and otherwise names the real problem.
 *
 * INVARIANT: in managed mode the Docker-down error never tells anyone to
 * "Install Docker". A Teams project admin cannot install anything, and Docker
 * was installed — it stopped (2026-10-03, an adoption build on a small microVM).
 * On the microVM backend a build or launch that finds dockerd dead runs
 * `lazy-guest-init --ensure` once and proceeds if that brought it back.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocker } from '../../src/capture/claude';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import {
  latestDockerdOomFromHistory,
  guestDockerdSupervised,
  guestDockerdSystemMessage,
  managedDockerDownMessage,
  parseGuestInitReport,
  setGuestDockerdReporter,
  fileGuestDockerdEvent,
} from '../../src/daemon/guest-dockerd';
import type { SystemMessage } from '../../src/types';

describe('a crash loop collapses into one message per kind of event', () => {
  const report = parseGuestInitReport('ready=no\nreason=dockerd-crash-loop\n', '');
  const failed = { kind: 'failed' as const, report, trigger: 't' };
  const restarted = { kind: 'restarted' as const, report: { ...report, ready: true }, trigger: 't' };

  // INVARIANT: every dockerd event is filed with collapseRepeats, and a restart
  // and a failed recovery carry different titles. A crash loop filed 150+
  // identical "restarted" notices in a day and buried the inbox (2026-10-13);
  // collapsing keys on source+kind+title, so the alert must stay its own message.
  test('both kinds ask the store to collapse repeats, under distinct titles', async () => {
    const calls: { title: string; collapse?: boolean }[] = [];
    const store = {
      createSystemMessage: async (input: { title: string }, options?: { collapseRepeats?: boolean }) => {
        calls.push({ title: input.title, collapse: options?.collapseRepeats });
        return { id: 'x', created_at: 0, body: '', source: '', kind: 'notice' } as unknown as SystemMessage;
      },
    };
    await fileGuestDockerdEvent(store, restarted);
    await fileGuestDockerdEvent(store, failed);
    expect(calls.every(c => c.collapse === true)).toBe(true);
    expect(calls[0].title).not.toBe(calls[1].title);
    expect(guestDockerdSystemMessage(restarted).kind).toBe('notice');
    expect(guestDockerdSystemMessage(failed).kind).toBe('alert');
  });

  // INVARIANT: an OOM kill is its own event — its own title, so collapsing never
  // folds it (and its memory remedy) into an earlier plain-crash message.
  test('an OOM restart and a plain restart carry different titles', () => {
    const oomReport = { ...report, ready: true, died: 'exited-137+oom-killer' };
    const crashReport = { ...report, ready: true, died: 'exited-1' };
    const oom = guestDockerdSystemMessage({ kind: 'restarted', report: oomReport, trigger: 't' });
    const crash = guestDockerdSystemMessage({ kind: 'restarted', report: crashReport, trigger: 't' });
    expect(oom.title).not.toBe(crash.title);
    expect(guestDockerdSystemMessage({ kind: 'failed', report: { ...oomReport, ready: false }, trigger: 't' }).title)
      .not.toBe(guestDockerdSystemMessage({ kind: 'failed', report: { ...crashReport, ready: false }, trigger: 't' }).title);
  });
});

const ENV_KEYS = ['LAZY_MANAGED', 'LAZY_MANAGED_BACKEND', 'PATH'] as const;
let saved: Record<string, string | undefined>;
let dir: string;

async function fake(name: string, body: string): Promise<void> {
  const p = join(dir, name);
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  dir = await mkdtemp(join(tmpdir(), 'guest-dockerd-recovery-'));
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setGuestDockerdReporter(null);
  await rm(dir, { recursive: true, force: true });
});

describe('managed-mode Docker-down error', () => {
  test('unmanaged keeps the install hint', async () => {
    delete process.env.LAZY_MANAGED;
    await expect(checkDocker('false')).rejects.toThrow('False is not installed or not running');
  });

  test('managed never says "Install Docker"', async () => {
    process.env.LAZY_MANAGED = '1';
    const err = await checkDocker('false').then(() => null, (e: Error) => e);
    expect(err?.message).toContain('Docker is not running where this project');
    expect(err?.message).toContain('report it to support');
    expect(err?.message).not.toContain('Install');
  });

  test('a crash loop is named with how it ended', () => {
    const msg = managedDockerDownMessage(parseGuestInitReport(
      'ready=no\nreason=dockerd-crash-loop\ndockerd_died=exited-137+oom-killer\ndockerd_restarts=3\n', '',
    ));
    expect(msg).toContain('dockerd ran out of memory');
    expect(msg).toContain('kept stopping');
    expect(msg).not.toContain('Install');
  });
});

describe('published cause text is evidence-only and sanitised', () => {
  // INVARIANT: messages blame memory only when the guest attributed an OOM kill to
  // THIS dockerd instance (the "+oom-killer" suffix: cgroup oom_kill counter, else a
  // pid/instance-window match - exact pid equality alone cannot work under the
  // nested pid namespace); any other death says what the exit status says and nothing more.
  test('an exit without a matched OOM kill never mentions memory', () => {
    for (const died of ['exited-137', 'exited-1', 'gone', 'not-answering']) {
      const r = parseGuestInitReport(`ready=yes\nsource=restarted-dockerd\ndockerd_died=${died}\n`, '');
      const body = guestDockerdSystemMessage({ kind: 'restarted', report: r, trigger: 't' }).body;
      expect(body).not.toMatch(/memory/i);
    }
  });

  test('free text from the machine never reaches a message', () => {
    const r = parseGuestInitReport('ready=no\nreason=sk-ant-secret value\ndockerd_died=$(whoami)\ndockerd_restarts=3x\n', '');
    expect(r.reason).toBeUndefined();
    expect(r.died).toBeUndefined();
    expect(r.restarts).toBeUndefined();
  });
});

describe('recovery on the microVM backend', () => {
  test('is off without the microVM backend or without the guest script', () => {
    expect(guestDockerdSupervised({ LAZY_MANAGED: '1', LAZY_MANAGED_BACKEND: 'local-docker', PATH: dir })).toBe(false);
    expect(guestDockerdSupervised({ LAZY_MANAGED: '1', LAZY_MANAGED_BACKEND: 'microvm', PATH: dir })).toBe(false);
  });

  /** Run checkDocker('docker') in a child with the fakes first on PATH (bun's spawn reads PATH from the process's start). */
  function runCheck(): { out: string; err: string } {
    const script = `
      import { checkDocker } from '${join(import.meta.dir, '../../src/capture/claude')}';
      import { setGuestDockerdReporter, guestDockerdSystemMessage } from '${join(import.meta.dir, '../../src/daemon/guest-dockerd')}';
      setGuestDockerdReporter(e => { const m = guestDockerdSystemMessage(e); console.log('EVENT', e.kind, m.kind, JSON.stringify(m.body)); });
      try { await checkDocker('docker'); console.log('OK'); } catch (e) { console.log('ERR', e.message); }
    `;
    const r = spawnSyncUnsupervised(['bun', '-e', script], {
      env: { ...process.env, LAZY_MANAGED: '1', LAZY_MANAGED_BACKEND: 'microvm', PATH: `${dir}:${saved.PATH}` },
      stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    });
    return { out: r.stdout.toString(), err: r.stderr.toString() };
  }

  test('a dead dockerd is restarted once and the build proceeds, with the restart reported', async () => {
    const up = join(dir, 'up');
    await fake('docker', `[ -f "${up}" ]`);
    await fake('lazy-guest-init', `echo ran >>"${join(dir, 'ran')}"; touch "${up}"
echo ready=yes; echo source=restarted-dockerd; echo dockerd_died=exited-137+oom-killer; echo dockerd_restarts=1`);
    const { out, err } = runCheck();
    expect(out, err).toContain('OK');
    expect((await readFile(join(dir, 'ran'), 'utf8')).trim()).toBe('ran');
    expect(out).toContain('EVENT restarted notice');
    expect(out).toContain('ran out of memory');
  });

  test('a recovery that fails throws the managed message and files an alert', async () => {
    await fake('docker', 'exit 1');
    await fake('lazy-guest-init', 'echo ready=no; echo reason=dockerd-crash-loop; echo dockerd_died=exited-1; exit 1');
    const { out, err } = runCheck();
    expect(out, err).toContain('EVENT failed alert');
    expect(out).toMatch(/ERR .*kept stopping/);
    expect(out).not.toContain('Install');
    expect(existsSync(join(dir, 'up'))).toBe(false);
  });
});

describe('a dockerd restart requested from god mode', () => {
  // INVARIANT: while god mode restarts dockerd, the daemon's own recovery
  // stands aside — a build that finds dockerd down waits for the restart
  // instead of racing a second lazy-guest-init against it — and a restart the
  // guest reports as requested files no "Docker stopped" notice.
  test('recovery waits for it, and its report is not a crash', async () => {
    const done = join(dir, 'restart-done');
    await fake('lazy-guest-init', `[ -f "${done}" ] && echo after >>"${join(dir, 'ran')}" || echo during >>"${join(dir, 'ran')}"
echo ready=yes; echo source=requested-restart`);
    const script = `
      import { recoverGuestDockerd, runRequestedDockerdRestart, requestedDockerdRestartRunning, setGuestDockerdReporter } from '${join(import.meta.dir, '../../src/daemon/guest-dockerd')}';
      setGuestDockerdReporter(e => console.log('EVENT', e.kind));
      const restart = runRequestedDockerdRestart(async () => {
        await Bun.sleep(400);
        await Bun.write('${done}', '');
      });
      console.log('HELD', requestedDockerdRestartRunning());
      const report = await recoverGuestDockerd('a build or launch');
      await restart;
      console.log('SOURCE', report.source, 'HELD', requestedDockerdRestartRunning());
    `;
    const r = spawnSyncUnsupervised(['bun', '-e', script], {
      env: { ...process.env, PATH: `${dir}:${saved.PATH}` }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    });
    const out = r.stdout.toString();
    expect(out, r.stderr.toString()).toContain('HELD true');
    expect(out).toContain('SOURCE requested-restart HELD false');
    expect(out).not.toContain('EVENT');
    expect((await readFile(join(dir, 'ran'), 'utf8')).trim()).toBe('after');
  });
});

describe('an OOM kill of dockerd is named with its memory and a remedy', () => {
  test('the alert says how much dockerd used and never just "report to support"', () => {
    const r = parseGuestInitReport(
      'ready=no\nreason=dockerd-crash-loop\ndockerd_died=exited-137+oom-killer\ndockerd_oom_used_kb=7276440\ndockerd_oom_machine_kb=8123456\n', '',
    );
    const msg = managedDockerDownMessage(r);
    expect(msg).toContain("dockerd ran out of memory (used 6.9 GiB of the machine's 7.7 GiB)");
    expect(msg).toContain('more memory');
    expect(msg).not.toContain('report it to support');
  });

  test('the Machine page reads the latest OOM death out of the restart history', () => {
    const lines = [
      '=== 2026-10-12T10:00:00Z dockerd (pid 5) stopped answering (cause=exited-1, exit_status=1)',
      '=== 2026-10-12T11:00:00Z dockerd (pid 9) stopped answering (cause=exited-137+oom-killer, exit_status=137)',
      '--- kernel OOM kill of this dockerd:',
      "--- dockerd memory at the kill: used 7276440 kB of the machine's 8123456 kB",
    ];
    expect(latestDockerdOomFromHistory(lines)).toEqual({ used: 7276440, machine: 8123456 });
    expect(latestDockerdOomFromHistory([...lines, '=== 2026-10-12T12:00:00Z dockerd (pid 11) stopped answering (cause=exited-1, exit_status=1)'])).toBeNull();
  });
});
