import { describe, test, expect } from 'bun:test';
import { spawn, spawnSync } from '../../src/utils/spawn';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('spawn', () => {
  // INVARIANT: When Bun.spawn fails with ENOENT because a stdout file's parent
  // directory doesn't exist, the wrapper must diagnose the real cause instead of
  // blaming the binary. This was the root cause of days of debugging on the daemon task.
  test('diagnoses missing stdout directory instead of blaming binary', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'spawn-test-'));
    const nonexistentDir = join(tmp, 'nonexistent', 'subdir');
    const logFile = join(nonexistentDir, 'output.log');

    expect(() => {
      spawn(['echo', 'hello'], {
        stdout: Bun.file(logFile),
        stderr: 'pipe',
      });
    }).toThrow(/directory.*nonexistent.*does not exist.*stdout/);
  });

  test('diagnoses missing stderr directory instead of blaming binary', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'spawn-test-'));
    const nonexistentDir = join(tmp, 'nonexistent', 'subdir');
    const logFile = join(nonexistentDir, 'error.log');

    expect(() => {
      spawn(['echo', 'hello'], {
        stdout: 'pipe',
        stderr: Bun.file(logFile),
      });
    }).toThrow(/directory.*nonexistent.*does not exist.*stderr/);
  });

  test('diagnoses missing binary', () => {
    expect(() => {
      spawn(['/nonexistent/binary/path'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }).toThrow(/binary.*\/nonexistent\/binary\/path.*not found/);
  });

  test('passes through successful spawn', () => {
    const proc = spawn(['echo', 'hello'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.pid).toBeGreaterThan(0);
    proc.kill();
  });

  test('works with BunFile stdout when directory exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'spawn-test-'));
    const logFile = join(tmp, 'output.log');

    const proc = spawn(['echo', 'hello'], {
      stdout: Bun.file(logFile),
      stderr: 'pipe',
    });

    expect(proc.pid).toBeGreaterThan(0);
  });

  // INVARIANT: When posix_spawn gets a nonexistent cwd, it returns ENOENT but
  // blames the binary. The wrapper must diagnose the real cause: missing cwd.
  test('diagnoses nonexistent cwd instead of blaming binary', () => {
    expect(() => {
      spawn(['echo', 'hello'], {
        cwd: '/nonexistent/working/directory',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }).toThrow(/working directory.*\/nonexistent\/working\/directory.*does not exist/);
  });
});

describe('spawnSync', () => {
  test('diagnoses missing binary', () => {
    expect(() => {
      spawnSync(['/nonexistent/binary/path'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }).toThrow(/binary.*\/nonexistent\/binary\/path.*not found/);
  });

  // INVARIANT: Same cwd diagnosis for spawnSync as for spawn.
  test('diagnoses nonexistent cwd instead of blaming binary', () => {
    expect(() => {
      spawnSync(['echo', 'hello'], {
        cwd: '/nonexistent/working/directory',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }).toThrow(/working directory.*\/nonexistent\/working\/directory.*does not exist/);
  });

  test('passes through successful spawnSync', () => {
    const result = spawnSync(['echo', 'hello'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
  });
});
