import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_SUBPROCESS_TIMEOUT_MS,
  spawn,
  spawnSyncInteractive,
  spawnSyncUnsupervised,
} from '../../src/utils/spawn';
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

describe('spawnSyncUnsupervised', () => {
  test('diagnoses missing binary', () => {
    expect(() => {
      spawnSyncUnsupervised(['/nonexistent/binary/path'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }).toThrow(/binary.*\/nonexistent\/binary\/path.*not found/);
  });

  // INVARIANT: Same cwd diagnosis for sync spawns as for spawn.
  test('diagnoses nonexistent cwd instead of blaming binary', () => {
    expect(() => {
      spawnSyncUnsupervised(['echo', 'hello'], {
        cwd: '/nonexistent/working/directory',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }).toThrow(/working directory.*\/nonexistent\/working\/directory.*does not exist/);
  });

  test('passes through a successful sync spawn', () => {
    const result = spawnSyncUnsupervised(['echo', 'hello'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
  });

  // INVARIANT: a sync spawn must NEVER run unbounded when the caller asked for a
  // timeout. The wrapper forwards `timeout` to Bun, which implements it natively —
  // this test pins that guarantee, because it lives in Bun rather than in our
  // wrapper. If a future Bun stops killing the child, this fails loudly instead
  // of the option going quietly dead and leaving daemon-reachable sync call
  // sites (pairing lock `ps`, daemon `git rev-parse`) with no backstop.
  test('honors an explicit timeout and kills the child', () => {
    const started = Date.now();
    const result = spawnSyncUnsupervised(['sleep', '10'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 500,
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    // Killed by signal: no exit code, SIGTERM (Bun's default killSignal).
    expect(result.exitCode).toBeNull();
    expect(result.signalCode).toBe('SIGTERM');
    expect(result.success).toBe(false);
  });

  // INVARIANT: an unsupervised sync spawn is bounded even when the caller forgets.
  // Nobody is watching such a child and it holds the whole thread — in the daemon
  // that is the event loop — so the default backstop applies unless overridden.
  // Asserted on the options that actually reach Bun: waiting out the real 60s
  // default would make this suite unusable, and the kill itself is already pinned
  // by the explicit-timeout test above.
  test('applies the default timeout when the caller passes none', () => {
    const real = Bun.spawnSync;
    const seen: Array<Record<string, unknown>> = [];
    (Bun as any).spawnSync = (cmd: string[], options: Record<string, unknown>) => {
      seen.push(options);
      return real(cmd as any, options as any);
    };
    try {
      spawnSyncUnsupervised(['echo', 'hi'], { stdout: 'pipe', stderr: 'pipe' });
      spawnSyncUnsupervised(['echo', 'hi'], { stdout: 'pipe', stderr: 'pipe', timeout: 1_234 });
    } finally {
      (Bun as any).spawnSync = real;
    }

    expect(seen[0]?.timeout).toBe(DEFAULT_SUBPROCESS_TIMEOUT_MS);
    // An explicit timeout still wins over the default.
    expect(seen[1]?.timeout).toBe(1_234);
  });

  test('does not kill a fast child', () => {
    const result = spawnSyncUnsupervised(['echo', 'hi'], { stdout: 'pipe', stderr: 'pipe' });

    expect(result.exitCode).toBe(0);
    // A clean exit is never signalled — the default must not kill a fast child.
    expect(result.signalCode ?? null).toBeNull();
  });
});

describe('spawnSyncInteractive', () => {
  test('diagnoses missing binary', () => {
    expect(() => {
      spawnSyncInteractive(['/nonexistent/binary/path'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }).toThrow(/binary.*\/nonexistent\/binary\/path.*not found/);
  });

  test('diagnoses nonexistent cwd instead of blaming binary', () => {
    expect(() => {
      spawnSyncInteractive(['echo', 'hello'], {
        cwd: '/nonexistent/working/directory',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }).toThrow(/working directory.*\/nonexistent\/working\/directory.*does not exist/);
  });

  // INVARIANT: the interactive variant imposes NO timeout. It hands the terminal
  // to the child (`lazy shell`, `tmux attach-session`) and the human is the
  // supervisor — killing a session someone is actively using is a bug, not a
  // backstop. Passing `timeout` here is a compile error (`timeout?: never`), so
  // the choice can never be made silently by an options bag.
  test('runs the child without a timeout', () => {
    const real = Bun.spawnSync;
    const seen: Array<Record<string, unknown>> = [];
    (Bun as any).spawnSync = (cmd: string[], options: Record<string, unknown>) => {
      seen.push(options);
      return real(cmd as any, options as any);
    };
    let result;
    try {
      result = spawnSyncInteractive(['echo', 'hi'], { stdout: 'pipe', stderr: 'pipe' });
    } finally {
      (Bun as any).spawnSync = real;
    }

    expect(result!.exitCode).toBe(0);
    expect(result!.signalCode ?? null).toBeNull();
    // No timeout reaches Bun at all — not even the unsupervised default.
    expect(seen[0]).not.toHaveProperty('timeout');
  });
});
