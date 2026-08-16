import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { makeDaemonBaseDir, pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { getDaemonDir, getSocketPath, getTokenPath } from '../../src/daemon/paths';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { setTaskStatus } from '../helpers/storage';
import { pinConfig } from '../helpers/pin-config';
import {
  collectDaemonStopInventory,
  confirmDaemonStop,
  describeStorageFailure,
  printDaemonStopInventory,
  type DaemonStopInventory,
} from '../../src/cli/commands/daemon-pre-stop';
import { RpcApplicationError } from '../../src/daemon/client';

/**
 * `lazy daemon stop` / `lazy daemon restart` pre-stop warning.
 *
 * These need a REAL daemon (withDaemon), not just because stop is the subject
 * but because the inventory is read through the daemon's own storage — under
 * LAZY_TEST there is no daemon to ask and nothing would be enumerated.
 */
describe('lazy daemon stop — pre-stop warning', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('stays silent when nothing is live', async () => {
    const result = await ctx.lazy(['daemon', 'stop']);
    expectSuccess(result);
    expectOutput(result, 'Daemon stopped.');
    // INVARIANT: the warning is a courtesy for live sessions, not a banner on
    // every stop. A warning nobody can act on is the noise that trains people
    // to stop reading warnings.
    expectOutputExcludes(result, 'affects live sessions');
  });

  test('lists working agents with their per-class consequence', async () => {
    const taskId = await createTask(ctx, 'Working task', 'Some work');
    setTaskStatus(ctx.root, taskId, 'working');

    const result = await ctx.lazy(['daemon', 'stop', '--yes']);
    expectSuccess(result);
    expectOutput(result, 'This stop affects live sessions:');
    expectOutput(result, '1 task agent is working');
    expectOutput(result, taskId);
    // The consequence, not just the count: an interrupted turn is a different
    // thing from a stranded builder.
    expectOutput(result, 'interrupting the current turn');
    expectOutput(result, 'Daemon stopped.');
  });

  test('lists pair sessions separately from working agents', async () => {
    const working = await createTask(ctx, 'Working task', 'Some work');
    const paired = await createTask(ctx, 'Paired task', 'Some pairing');
    setTaskStatus(ctx.root, working, 'working');
    setTaskStatus(ctx.root, paired, 'pairing');

    const result = await ctx.lazy(['daemon', 'stop', '--yes']);
    expectSuccess(result);
    expectOutput(result, '1 task agent is working');
    expectOutput(result, '1 pair session is open');
    // A pair session is NOT resumed by anything — that is the whole point of
    // reporting it apart from an agent turn.
    expectOutput(result, 'nothing resumes them');
  });

  test('always names the sessions it cannot see', async () => {
    const taskId = await createTask(ctx, 'Working task', 'Some work');
    setTaskStatus(ctx.root, taskId, 'working');

    const result = await ctx.lazy(['daemon', 'stop', '--yes']);
    expectSuccess(result);
    // An inventory that quietly omits a class is worse than an honest gap.
    expectOutput(result, 'Not tracked, so not listed above');
    expectOutput(result, 'lazy pair` on main');
  });

  test('--yes skips the prompt but still warns', async () => {
    const taskId = await createTask(ctx, 'Working task', 'Some work');
    setTaskStatus(ctx.root, taskId, 'working');

    const result = await ctx.lazy(['daemon', 'stop', '--yes'], {
      env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'decline' },
    });
    expectSuccess(result);
    expectOutput(result, 'This stop affects live sessions:');
    expectOutput(result, 'Proceeding without confirmation');
    // Declining is what the prompt WOULD have returned — --yes means it was
    // never asked, so the stop must go through anyway.
    expectOutput(result, 'Daemon stopped.');
  });

  test('non-TTY warns and proceeds without hanging', async () => {
    const taskId = await createTask(ctx, 'Working task', 'Some work');
    setTaskStatus(ctx.root, taskId, 'working');

    // No --yes and no TTY: must never block a non-interactive caller.
    const result = await ctx.lazy(['daemon', 'stop']);
    expectSuccess(result);
    expectOutput(result, 'This stop affects live sessions:');
    expectOutput(result, 'Proceeding without confirmation');
    expectOutput(result, 'Daemon stopped.');
  });

  test('declining at the prompt leaves the daemon running', async () => {
    const taskId = await createTask(ctx, 'Working task', 'Some work');
    setTaskStatus(ctx.root, taskId, 'working');

    const result = await ctx.lazy(['daemon', 'stop'], {
      env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'decline' },
    });
    expectSuccess(result);
    expectOutput(result, 'Aborted.');
    expectOutputExcludes(result, 'Daemon stopped.');

    const status = await ctx.lazy(['daemon', 'status']);
    expectOutput(status, 'Daemon is running.');
  });

  test('restart is not quieter than stop', async () => {
    const taskId = await createTask(ctx, 'Working task', 'Some work');
    setTaskStatus(ctx.root, taskId, 'working');

    const result = await ctx.lazy(['daemon', 'restart', '--yes']);
    expectSuccess(result);
    // INVARIANT: a restart IS a stop with extra steps and has exactly the same
    // blast radius, so it must warn in its own terms — never silently.
    expectOutput(result, 'This restart affects live sessions:');
    expectOutput(result, '1 task agent is working');
    expectOutput(result, 'Daemon started');
  });

  test('declining a restart leaves the daemon running and untouched', async () => {
    const taskId = await createTask(ctx, 'Working task', 'Some work');
    setTaskStatus(ctx.root, taskId, 'working');

    const before = await ctx.lazy(['daemon', 'status']);
    const beforePid = before.stdout.match(/PID:\s+(\d+)/)?.[1];
    expect(beforePid).toBeTruthy();

    const result = await ctx.lazy(['daemon', 'restart'], {
      env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'decline' },
    });
    expectSuccess(result);
    expectOutput(result, 'Aborted.');

    const after = await ctx.lazy(['daemon', 'status']);
    expectOutput(after, 'Daemon is running.');
    // Same process: a declined restart must not have stopped anything.
    expect(after.stdout).toContain(`PID:     ${beforePid}`);
  });

  // --- the three branches the report is built on --------------------------
  //
  // proxyLive, builder enumeration and incompleteReason decide WHAT the warning
  // says, and each of them can only be exercised by a daemon/runner state a
  // happy-path stop never reaches. They are driven directly here rather than
  // through the CLI for that reason.

  /** Run `fn` with console.log captured, returning everything it printed. */
  async function captured(fn: () => unknown): Promise<string> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await fn();
    } finally {
      console.log = original;
    }
    return lines.join('\n');
  }

  /** Run `fn` with config resolution pinned to the test project's lazy.toml. */
  async function withPinnedConfig<T>(fn: () => Promise<T>): Promise<T> {
    const unpin = pinConfig(ctx.root);
    try {
      return await fn();
    } finally {
      unpin();
    }
  }

  function inventory(overrides: Partial<DaemonStopInventory> = {}): DaemonStopInventory {
    return {
      builders: [],
      working: [],
      pairing: [],
      proxyLive: false,
      buildersUnknown: false,
      ...overrides,
    };
  }

  /** Put a `docker` on PATH that answers only `ps`, listing `names`. */
  async function fakeDockerPs(names: string[]): Promise<string> {
    const binDir = join(ctx.root, '.fake-bin');
    await mkdir(binDir, { recursive: true });
    const script = [
      '#!/usr/bin/env bash',
      'if [ "${1:-}" = "ps" ]; then',
      ...names.map(n => `  printf '%s\\n' '${n}'`),
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n');
    const path = join(binDir, 'docker');
    await writeFile(path, script);
    await chmod(path, 0o755);
    return binDir;
  }

  test('states the proxy consequence for builders and for pair sessions', async () => {
    const out = await captured(() => printDaemonStopInventory(inventory({
      builders: ['lazy-builder-abc123'],
      pairing: [{ label: 'paired-task', goal: 'Pair on it' }],
      proxyLive: true,
    }), 'stop'));

    expect(out).toContain('1 builder session is live');
    expect(out).toContain('lazy-builder-abc123');
    expect(out).toContain('their next request fails');
    expect(out).toContain('Exit and relaunch each builder');
    expect(out).toContain('1 pair session is open');
    expect(out).toContain('left on a dead address');
  });

  test('says nothing about the proxy when it is configured off', async () => {
    const out = await captured(() => printDaemonStopInventory(inventory({
      builders: ['lazy-builder-abc123'],
      proxyLive: false,
    }), 'stop'));

    // Without the proxy, surviving children talk to the model directly and are
    // genuinely unaffected — claiming otherwise would be a false alarm.
    expect(out).toContain('1 builder session is live');
    expect(out).not.toContain('Exit and relaunch each builder');
  });

  // INVARIANT: an unreachable daemon must NEVER be read as "no proxy".
  //
  // This is the task's motivating scenario: `daemon stop` is what people reach
  // for when the daemon is WEDGED, and proxyLive was originally derived from a
  // live health round-trip — so on a wedged daemon it silently fell to false and
  // every stranded-child consequence went unprinted, in exactly the case the
  // warning exists for. The proxy is on unless config disables it, so config is
  // the baseline and only a daemon that ANSWERS may downgrade it.
  test('still states the proxy consequence when the daemon cannot be reached', async () => {
    await ctx.lazy(['daemon', 'stop', '--yes']);

    // Without the pin, loadConfig walks UP from cwd and reads lazy's own
    // lazy.toml under `bun test`, so the project under test is never consulted
    // (see test/helpers/pin-config.ts).
    const inv = await withPinnedConfig(() => collectDaemonStopInventory(ctx.root));

    expect(inv.proxyLive).toBe(true);
    const out = await captured(() => printDaemonStopInventory({ ...inv, builders: ['lazy-builder-abc123'] }, 'stop'));
    expect(out).toContain('Exit and relaunch each builder');
  });

  // INVARIANT: builder enumeration is independent of the storage lookup.
  //
  // The two once ran sequentially under ONE budget, so a storage lookup that
  // stalled — the likeliest thing on the wedged daemon this command exists for —
  // consumed the whole budget and builder enumeration never ran at all. The
  // report then printed no builders AND no note saying it could not see any,
  // i.e. it silently claimed a zero it had never looked for. That is the one
  // thing this inventory must never do.
  //
  // The stall is real, not simulated: a socket that accepts the connection and
  // never answers is exactly what a wedged daemon looks like to a client.
  test('reports builders as unknown when the storage lookup stalls', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const after = before.replace(
      'type = "docker"',
      'type = "dangerously-host-process-without-any-isolation"',
    );
    expect(after).not.toBe(before);
    await writeFile(configPath, after);

    // Private daemon dir so the fake socket cannot collide with this suite's
    // real test daemon (or with the developer's own ~/.lazy/daemon).
    const baseDir = await makeDaemonBaseDir();
    const unpinBase = pinDaemonBaseDir(baseDir);
    let server: ReturnType<typeof Bun.listen> | undefined;
    let inv: DaemonStopInventory;
    try {
      await mkdir(getDaemonDir(ctx.root), { recursive: true });
      await writeFile(getTokenPath(ctx.root), 'fake-token-for-a-wedged-daemon');
      // Accepts, then never replies — the client hangs until our deadline.
      server = Bun.listen({ unix: getSocketPath(ctx.root), socket: { data() {}, open() {} } });

      inv = await withPinnedConfig(() => collectDaemonStopInventory(ctx.root));
    } finally {
      server?.stop(true);
      unpinBase();
      await rm(baseDir, { recursive: true, force: true });
    }

    expect(inv.incompleteReason).toContain('timed out');
    expect(inv.buildersUnknown).toBe(true);

    const out = await captured(() => printDaemonStopInventory(inv, 'stop'));
    // The report must never imply zero builders it did not verify.
    expect(out).toContain("builder sessions on this project's runner");
    expect(out).toContain('This list is INCOMPLETE');
  });

  test('lists discovered builder containers on a docker project', async () => {
    const binDir = await fakeDockerPs(['lazy-builder-deadbee']);
    const taskId = await createTask(ctx, 'Working task', 'Some work');
    setTaskStatus(ctx.root, taskId, 'working');

    const result = await ctx.lazy(['daemon', 'stop', '--yes'], {
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
    });

    expectSuccess(result);
    expectOutput(result, '1 builder session is live');
    expectOutput(result, 'lazy-builder-deadbee');
    // Builders are the class that survives the stop — a different consequence
    // from an interrupted agent turn, and reported as such.
    expectOutput(result, 'NOT stopped and NOT resumed');
    expectOutput(result, 'Daemon stopped.');
  });

  test('distinguishes the causes of an incomplete inventory', () => {
    // A transport failure and an error RESPONSE are different problems: one says
    // restart the daemon, the other says look at what it reported.
    expect(describeStorageFailure(null)).toContain('unreachable');
    const answered = describeStorageFailure(new RpcApplicationError(500, 'storage lock busy'));
    expect(answered).toContain('returned an error');
    expect(answered).toContain('500');
    expect(answered).toContain('storage lock busy');
    expect(answered).not.toContain('unreachable');
    expect(describeStorageFailure(new Error('socket closed'))).toContain('socket closed');
  });

  test('an incomplete inventory warns even when nothing was enumerated', async () => {
    // Nothing enumerated but the enumeration itself failed: staying silent here
    // would report "nothing is live" on the strength of a lookup that never ran.
    const out = await captured(() => confirmDaemonStop(
      inventory({ incompleteReason: 'the daemon is unreachable' }),
      'stop',
      true,
    ));
    expect(out).toContain('This stop affects live sessions:');
    expect(out).toContain('This list is INCOMPLETE — the daemon is unreachable');

    // …but a genuinely empty inventory still stays silent.
    const quiet = await captured(() => confirmDaemonStop(inventory(), 'stop', true));
    expect(quiet).toBe('');
  });
});
