/**
 * INVARIANT: a turn that could not register the lazy MCP tools must NOT run.
 *
 * This is the reversal of a swallow that cost days of diagnosis. `prepareTurnMcp`
 * used to catch a failed MCP config write and log "Non-fatal: Claude Code will
 * work without MCP tools (they just won't be available)", then run the turn
 * anyway. A task agent in the wild did a full turn with ZERO `lazy_*` tools: it
 * could not read task history, record follow-ups, or reach any lazy state, and
 * the only trace was one warn line inside the container's supervisor log — which
 * is exactly where nobody looks.
 *
 * The failure now fails the turn, and this suite is the end-to-end proof of
 * that. It has to live at the fake-binary seam: every other e2e suite replaces
 * `launchSupervisorAsync` wholesale via the `--preload` module mock, so no test
 * there can ever reach the real supervisor's MCP setup. Here the daemon spawns a
 * real `lazy supervise`, which really writes the config and really decides
 * whether to launch the agent.
 *
 * The injected failure is a HOME whose `.claude.json` is a directory:
 * `writeMcpConfig` targets that exact path, so the write fails the way it would
 * for a real unwritable config, without stubbing anything in `src/`.
 *
 * Do not relax these assertions into "logs a warning". The whole point is that
 * the human sees it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

describe('a turn with no lazy MCP tools fails loud', () => {
  let ctx: TestContext;
  let brokenHome: string;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;

  beforeEach(async () => {
    // The daemon runs with a different HOME than this process (below), and
    // ~/.lazy/daemon is HOME-derived. Pin the base dir for EVERY process in the
    // context — daemon and CLI alike — so the two agree on where the daemon
    // lives and neither goes near the developer's real ~/.lazy.
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);

    brokenHome = await mkdtemp(join(tmpdir(), 'lazy-broken-home-'));
    // A DIRECTORY where writeMcpConfig expects to write a file.
    await mkdir(join(brokenHome, '.claude.json'), { recursive: true });

    ctx = await setupTestLazy({ fakeClaude: true, daemonEnv: { HOME: brokenHome } });
  });

  afterEach(async () => {
    // Reap the daemon BEFORE unpinning: cleanup resolves its pidfile through
    // LAZY_DAEMON_BASE_DIR, so unpinning first leaves the daemon running.
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    restoreDaemonBaseDir = undefined;
    await removeDaemonBaseDir(daemonBaseDir);
    await rm(brokenHome, { recursive: true, force: true });
  });

  test('the agent is never launched, and the failure reaches the task', async () => {
    const taskId = await createTask(ctx, 'MCP setup must fail loud', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ result: 'should never run', sessionId: 'never' }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    await ctx.lazy(['wait', taskId]);

    // THE assertion: the agent process was never started. A swallowed failure
    // would show a real `-p` turn invocation here, running toolless.
    const invocations = await ctx.claudeInvocations();
    expect(invocations.filter(i => i.argv.includes('-p'))).toHaveLength(0);

    // ...and the reason is visible to the human, naming what went wrong rather
    // than a bare "command failed".
    const show = await ctx.lazy(['show', taskId]);
    const text = show.stdout + show.stderr;
    expect(text).toContain('Could not register the lazy MCP tools');
    // Actionable, per CLAUDE.md: which task, where it ran, and the real cause.
    expect(text).toContain(taskId);
    expect(text).toContain('Container/host:');
    expect(text).toContain('EISDIR');
    // It landed in a state the human sees, with the failure recorded as a turn
    // rather than only in a container log.
    expect(text).toContain('interrupted');
  }, 120_000);
});
