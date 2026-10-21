/**
 * `lazy daemon logs` prints the recent log and exits; only -f/--follow follows.
 * A follow-by-default made `lazy daemon logs | tail -200` hang and print nothing.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { getDaemonDir, getLogPath } from '../../src/daemon/paths';

describe('lazy daemon logs', () => {
  let ctx: TestContext;
  let daemonBase: string;
  let unpin: () => void;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    daemonBase = await mkdtemp(join(tmpdir(), 'lzd-logs-'));
    unpin = pinDaemonBaseDir(daemonBase);
    await mkdir(getDaemonDir(ctx.root), { recursive: true });
    const lines = Array.from({ length: 300 }, (_, i) => `line-${i + 1}`);
    await writeFile(getLogPath(ctx.root), lines.join('\n') + '\n');
  });

  afterEach(async () => {
    await ctx.cleanup();
    unpin();
    await rm(daemonBase, { recursive: true, force: true });
  });

  // INVARIANT: with no flags the command prints the last 200 lines and EXITS, so
  // it is safe in a pipe. Following forever by default hung `| tail -200`.
  test('default prints the last 200 lines and exits', async () => {
    const result = await ctx.lazy(['daemon', 'logs']);
    expect(result.exitCode).toBe(0);
    const out = result.stdout.trim().split('\n');
    expect(out).toHaveLength(200);
    expect(out[0]).toBe('line-101');
    expect(out[199]).toBe('line-300');
  });

  test('-n sets how many lines', async () => {
    const result = await ctx.lazy(['daemon', 'logs', '-n', '3']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['line-298', 'line-299', 'line-300']);
  });

  test('--no-follow is still accepted and exits', async () => {
    const result = await ctx.lazy(['daemon', 'logs', '--no-follow', '-n', '1']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('line-300');
  });

  // INVARIANT: -f follows; new lines appended after start are printed.
  test('-f prints the tail then follows appended lines', async () => {
    const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, '../../src/index.ts'), 'daemon', 'logs', '-f', '-n', '1', '--project', ctx.root], {
      cwd: ctx.root,
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const reader = proc.stdout.getReader();
      let seen = '';
      const read = async (needle: string) => {
        const deadline = Date.now() + 20_000;
        while (!seen.includes(needle) && Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          seen += new TextDecoder().decode(value);
        }
        expect(seen).toContain(needle);
      };
      await read('line-300');
      expect(proc.exitCode).toBeNull();
      await appendFile(getLogPath(ctx.root), 'appended-line\n');
      await read('appended-line');
    } finally {
      proc.kill();
    }
  });
});
