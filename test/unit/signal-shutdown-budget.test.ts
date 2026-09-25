/**
 * The signal-shutdown budget is a contract between two sides that are written
 * in different files, so it is checked mechanically rather than by reading.
 *
 * A signalled daemon awaits `stop()` — stopping this project's supervisors,
 * recording why each turn ended, closing storage — and exits after
 * SIGNAL_SHUTDOWN_BUDGET_MS regardless. Every caller that then escalates to
 * SIGKILL has to allow at least that long, or it force-kills a daemon shutting
 * down exactly as instructed: the turns are left reading as "General error",
 * and a kill landing inside a storage write leaves a `.storage-lock` naming a
 * pid that will one day be recycled, at which point the lock looks held
 * forever by a process that never had it.
 *
 * These numbers drifted apart once already — the budget was written at 15s
 * while the tightest window was 2s — and the failure is silent at every call
 * site, which is exactly what a source-level guard is for.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { SIGNAL_SHUTDOWN_BUDGET_MS, SHUTDOWN_STOP_GRACE_SECONDS } from '../../src/daemon/lifecycle';

const repoRoot = join(import.meta.dir, '..', '..');

describe('signal shutdown budget', () => {
  // INVARIANT: the sweep must fit inside the budget it is bounded by. The
  // per-run grace is the sweep's dominant cost, so a grace at or above the
  // whole budget guarantees the shutdown is cut off before it records anything.
  test('the shutdown sweep grace is well inside the budget', () => {
    expect(SHUTDOWN_STOP_GRACE_SECONDS * 1_000).toBeLessThan(SIGNAL_SHUTDOWN_BUDGET_MS / 2);
  });

  // INVARIANT: `lazy daemon stop`'s two escalation windows both allow a
  // signalled daemon its full budget. Read from source rather than imported,
  // because they are literals chosen for a different reason (how the daemon
  // answered the shutdown request) and nothing else ties them to this number.
  test("lazy daemon stop's SIGKILL windows allow the full budget", async () => {
    const src = await readFile(join(repoRoot, 'src', 'cli', 'commands', 'daemon.ts'), 'utf-8');
    const match = src.match(/const graceMs = shutdownAccepted \? ([\d_]+) : ([\d_]+);/);
    expect(match).not.toBeNull();

    const accepted = Number(match![1].replace(/_/g, ''));
    const unanswered = Number(match![2].replace(/_/g, ''));
    expect(accepted).toBeGreaterThanOrEqual(SIGNAL_SHUTDOWN_BUDGET_MS);
    expect(unanswered).toBeGreaterThanOrEqual(SIGNAL_SHUTDOWN_BUDGET_MS);
  });

  // INVARIANT: every caller that signals a daemon it has no reason to think is
  // wedged derives its window from the budget rather than restating it. A
  // literal here is the drift itself, not a symptom of it — the demo reaper had
  // a flat 1500ms against a 3000ms budget while a comment claimed the two
  // agreed, which is exactly what a source-level check is for.
  test('every caller that signals a healthy daemon derives its window from the budget', async () => {
    const cli = await readFile(join(repoRoot, 'src', 'cli', 'commands', 'daemon.ts'), 'utf-8');
    expect(cli).toContain('async function terminatePid(pid: number, timeoutMs = SIGNAL_SHUTDOWN_BUDGET_MS');

    const harness = await readFile(join(repoRoot, 'test', 'helpers', 'setup.ts'), 'utf-8');
    expect(harness).toMatch(/const steps = Math\.ceil\(\(SIGNAL_SHUTDOWN_BUDGET_MS \+ [\d_]+\) \/ 100\)/);

    // `lazy playground down` reaps a --teams demo's fleet daemons, which live under
    // <root>/teams/ and so match its owned-path markers.
    const reaper = await readFile(join(repoRoot, 'src', 'demo', 'reap.ts'), 'utf-8');
    expect(reaper).toContain('const deadline = Date.now() + SIGNAL_SHUTDOWN_BUDGET_MS;');
    // And no flat sleep left behind to race it.
    expect(reaper).not.toMatch(/setTimeout\(resolve, 1500\)/);
  });

  // INVARIANT: the shutdown sweep's short per-run stop goes to the HOST runner
  // only. On Docker the same option is not a shorter grace — it switches
  // `docker kill` (immediate, the default) to `docker stop --time <n>`, so
  // passing it unconditionally makes production's runner spend wall clock
  // inside a budget that was sized assuming it would not.
  test('the shutdown sweep leaves the Docker runner on its own default stop', async () => {
    const server = await readFile(join(repoRoot, 'src', 'daemon', 'server.ts'), 'utf-8');
    expect(server).toContain(
      "const shutdownStopOpts = runner.type === 'dangerously-host-process-without-any-isolation'",
    );
    expect(server).toContain('await runner.stopRun(runName, shutdownStopOpts)');
  });
});
