/**
 * A daemon start that first backs up the store is visible, and survives the
 * terminal that started it.
 *
 * On a 4.2 GiB store, starts from three binaries each began a full backup,
 * printed nothing anywhere, and were killed by the person (Ctrl+C, a closed
 * terminal, `lazy daemon stop`) who could not tell a backup from a hang.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { readPid, waitForDaemon } from '../../src/daemon';
import { getDaemonDir, getLogPath } from '../../src/daemon/paths';
import { storageDirFor } from '../helpers/storage';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// `ps -o pgid=` is portable (macOS ps has no `sid` keyword).
function processGroup(pid: number): number {
  return Number(Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)]).stdout.toString().trim());
}

describe('daemon start with a store backup', () => {
  let ctx: TestContext;
  let started: number[] = [];

  beforeEach(async () => {
    ctx = await setupTestLazy();
    started = [];
    // The previous start was another version: this start backs the store up.
    await mkdir(getDaemonDir(ctx.root), { recursive: true });
    await writeFile(join(getDaemonDir(ctx.root), 'daemon-last-version.json'), JSON.stringify({ version: '0.0.1-older' }));
  });

  afterEach(async () => {
    const pid = readPid(ctx.root);
    for (const p of [...started, ...(pid ? [pid] : [])]) {
      if (isAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ } }
    }
    await ctx.cleanup();
  });

  const env = () => ({ ...process.env, LAZY_PROTOCOL_BASE: ctx.protocolBase, ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing' });

  // INVARIANT: the background daemon runs in its own session, so a Ctrl+C on
  // the CLI that started it (SIGINT to the terminal's foreground process group)
  // or the terminal closing never reaches it — even mid-backup.
  test('a SIGINT to the starting CLI\'s process group leaves the daemon running and finishing its backup', async () => {
    // Big enough that the backup is still running when the signal lands.
    const big = join(storageDirFor(ctx.root), 'tasks', 'zz-ballast');
    await mkdir(big, { recursive: true });
    for (let i = 0; i < 24; i++) await writeFile(join(big, `blob-${i}`), randomBytes(16 * 1024 * 1024));

    // The CLI leads its own group, standing in for a terminal's foreground job.
    const cli = Bun.spawn(['bun', 'run', ENTRY_PATH, 'daemon', 'start', '--project', ctx.root], {
      cwd: ctx.root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: env(), detached: true,
    });
    started.push(cli.pid);
    const marker = join(getDaemonDir(ctx.root), 'store-backup-progress.json');
    const deadline = Date.now() + 20_000;
    let pid: number | null = null;
    while (Date.now() < deadline) {
      const m = await readFile(marker, 'utf-8').then(t => JSON.parse(t) as { pid: number }, () => null);
      if (m) { pid = m.pid; break; }
      await Bun.sleep(50);
    }
    expect(pid).not.toBeNull();
    started.push(pid!);
    // The person sees the backup in the background start's own output before
    // they would reach for Ctrl+C.
    const reader = cli.stderr.getReader();
    let seen = '';
    // One read in flight at a time: a read abandoned by a race would swallow its chunk.
    let pending = reader.read();
    while (Date.now() < deadline && !(seen.includes('Backing up your store before lazy') && seen.includes('keeps going if you close this terminal'))) {
      const chunk = await Promise.race([pending, Bun.sleep(500).then(() => null)]);
      if (chunk === null) continue;
      if (chunk.done) break;
      seen += new TextDecoder().decode(chunk.value);
      pending = reader.read();
    }
    expect(seen).toContain('Backing up your store before lazy');
    expect(seen).toContain('keeps going if you close this terminal');
    reader.cancel().catch(() => {});
    expect(processGroup(pid!)).toBe(pid!);

    // INVARIANT: status asked of a REAL daemon mid-backup (PID file already
    // written) reports the backup — not "alive but not responding", which is
    // what the liveness check alone answered.
    const status = Bun.spawnSync(['bun', 'run', ENTRY_PATH, 'daemon', 'status', '--project', ctx.root], { cwd: ctx.root, env: env() });
    expect(status.stdout.toString()).toContain(`Daemon is starting (PID ${pid}). Backing up your store before lazy`);

    process.kill(-cli.pid, 'SIGINT');
    await cli.exited;
    expect(await waitForDaemon(ctx.root, 60_000)).toBe(true);
    expect(readPid(ctx.root)).toBe(pid);
    expect(await readFile(getLogPath(ctx.root), 'utf-8')).toMatch(/Backup saved: .* To go back to lazy 0\.0\.1-older: `lazy daemon stop`, then `lazy system store-restore /);
  }, 120_000);

  // INVARIANT: a foreground start shows the backup on the terminal — the person
  // running `--foreground` is watching this process, not daemon.log.
  test('--foreground prints the backup to the terminal', async () => {
    const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, 'daemon', 'start', '--foreground', '--project', ctx.root], {
      cwd: ctx.root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: env(),
    });
    started.push(proc.pid);
    expect(await waitForDaemon(ctx.root, 30_000)).toBe(true);
    proc.kill('SIGTERM');
    const out = await new Response(proc.stdout).text();
    expect(out).toContain('making sure there is a backup to go back to first');
    expect(out).toMatch(/Backup saved: .* To go back to lazy 0\.0\.1-older: `lazy daemon stop`, then `lazy system store-restore /);
  }, 60_000);

  // INVARIANT: while a start is backing up, status says so — never "not
  // running", which is what sent the person stopping and restarting it.
  test('status while a start is backing up says so', async () => {
    const holder = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    started.push(holder.pid);
    await writeFile(join(getDaemonDir(ctx.root), 'store-backup-progress.json'), JSON.stringify({
      phase: 'copying', files: 10, bytes: 1, total_files: 40, total_bytes: 4, from_version: 'a', to_version: '9.9.9',
      pid: holder.pid, updated_at: new Date().toISOString(), eta_seconds: 40,
      line: 'copying: 1.20 GiB of 4.20 GiB (10 of 40 files), about 40 s left',
    }));
    const text = await ctx.lazy(['daemon', 'status']);
    expect(text.stdout).toContain(`Daemon is starting (PID ${holder.pid}). Backing up your store before lazy 9.9.9 opens it, so you can go back to a if you need to: copying: 1.20 GiB of 4.20 GiB (10 of 40 files), about 40 s left.`);
    const json = JSON.parse((await ctx.lazy(['daemon', 'status', '--json'])).stdout);
    expect(json.running).toBe(false);
    expect(json.starting.phase).toBe('store_backup');
  });
});

describe('daemon start with a store backup: stop and failure', () => {
  let ctx: TestContext;
  let holder: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    await mkdir(getDaemonDir(ctx.root), { recursive: true });
  });

  afterEach(async () => {
    if (holder && isAlive(holder.pid)) holder.kill('SIGKILL');
    holder = null;
    const pid = readPid(ctx.root);
    if (pid && isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    await ctx.cleanup();
  });

  // INVARIANT: `lazy daemon stop` on a start that is mid-backup names the
  // backup and leaves it running unless told --yes. Stopping it over and over,
  // each time throwing the backup away, is the loop this task ended.
  test('stop names a running backup and leaves it running without --yes', async () => {
    holder = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    await writeFile(join(getDaemonDir(ctx.root), 'store-backup-progress.json'), JSON.stringify({
      phase: 'copying', files: 1, bytes: 1, total_files: 2, total_bytes: 2, from_version: 'a', to_version: '9.9.9',
      pid: holder.pid, updated_at: new Date().toISOString(), eta_seconds: null, line: 'copying: x',
    }));
    const kept = await ctx.lazy(['daemon', 'stop']);
    expect(kept.stdout).not.toContain('not running');
    expect(kept.stdout).toContain('Backing up your store before lazy 9.9.9');
    expect(isAlive(holder.pid)).toBe(true);
    await ctx.lazy(['daemon', 'stop', '--yes']);
    await holder.exited;
    expect(isAlive(holder.pid)).toBe(false);
  });

  // INVARIANT: the background start ends by saying what the person now has —
  // where the backup is and the command that takes them back — not just "started".
  test('a background start says where the backup is and how to go back', async () => {
    await writeFile(join(getDaemonDir(ctx.root), 'daemon-last-version.json'), JSON.stringify({ version: '0.0.1-older' }));
    const cli = Bun.spawn(['bun', 'run', ENTRY_PATH, 'daemon', 'start', '--project', ctx.root], {
      cwd: ctx.root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, LAZY_PROTOCOL_BASE: ctx.protocolBase, ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing' },
    });
    const stderr = await new Response(cli.stderr).text();
    expect(await cli.exited).toBe(0);
    expect(stderr).toMatch(/Backup saved: .* To go back to lazy 0\.0\.1-older: `lazy daemon stop`, then `lazy system store-restore [^`]+`\./);
  }, 60_000);

  // INVARIANT: a start failure whose cause has been fixed is never shown as the
  // current state — status says it is fixed and gives the next step.
  test('status reports a fixed ownership failure as fixed', async () => {
    await writeFile(join(getDaemonDir(ctx.root), 'startup-error'),
      `Store ${storageDirFor(ctx.root)} contains saved data but has no recorded owning checkout. Refusing to claim it.`);
    const text = await ctx.lazy(['daemon', 'status']);
    expect(text.stdout).toContain('Ownership is recorded now, so that is fixed. Start the daemon: `lazy daemon start`.');
    expect(text.stdout).not.toContain('Last start attempt failed');
  });

  // INVARIANT: a failed start backup reaches the person who started the daemon
  // as the refusal itself, not as a generic "did not start" timeout.
  test('a failed backup is shown by the starting CLI', async () => {
    await writeFile(join(getDaemonDir(ctx.root), 'daemon-last-version.json'), JSON.stringify({ version: '0.0.1-older' }));
    await writeFile(`${storageDirFor(ctx.root)}.backups`, 'not a directory');
    const cli = Bun.spawn(['bun', 'run', ENTRY_PATH, 'daemon', 'start', '--project', ctx.root], {
      cwd: ctx.root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, LAZY_PROTOCOL_BASE: ctx.protocolBase, ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing' },
    });
    const err = await new Response(cli.stderr).text();
    expect(await cli.exited).not.toBe(0);
    expect(err).toContain('store backup taken before every upgrade failed');
  }, 60_000);
});
