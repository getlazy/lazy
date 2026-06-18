import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ActivityMonitor, parseSupervisorLogLine } from '../../src/cli/activity-monitor';
import { createRunnerFromType } from '../../src/runner';

describe('parseSupervisorLogLine', () => {
  test('formats phase transitions', () => {
    expect(parseSupervisorLogLine('[01:23] [supervisor] Phase: work')).toBe('Agent working...');
    expect(parseSupervisorLogLine('[01:23] [supervisor] Phase: work_done')).toBe('Agent finished');
    expect(parseSupervisorLogLine('[01:23] [supervisor] Phase: merge_and_fix')).toBe('Syncing with upstream...');
    expect(parseSupervisorLogLine('[01:23] [supervisor] Phase: merge_and_fix_done')).toBe('Upstream sync complete');
    expect(parseSupervisorLogLine('[01:23] [supervisor] Phase: post_turn_sync')).toBe('Post-turn sync...');
    expect(parseSupervisorLogLine('[01:23] [supervisor] Phase: post_turn_sync_done')).toBe('Post-turn sync complete');
    expect(parseSupervisorLogLine('[01:23] [supervisor] Phase: retrying')).toBe('Retrying after error...');
  });

  test('hides internal phases', () => {
    expect(parseSupervisorLogLine('[01:23] [supervisor] Phase: writing_response')).toBeNull();
    expect(parseSupervisorLogLine('[01:23] [supervisor] Phase: reading_command')).toBeNull();
  });

  test('formats work module messages', () => {
    expect(parseSupervisorLogLine('[01:23] [work] Running Claude Code (resume)...')).toBe('Agent starting...');
    expect(parseSupervisorLogLine('[01:23] [work] Running Claude Code...')).toBe('Agent starting...');
    expect(parseSupervisorLogLine('[01:23] [work] Claude Code completed. Parsing response...')).toBe('Agent finished, processing response...');
    expect(parseSupervisorLogLine('[01:23] [work] Retry 2: Running Claude Code...')).toBe('Retry 2: Running Claude Code...');
    expect(parseSupervisorLogLine('[01:23] [work] Success after 3 retries.')).toBe('Success after 3 retries.');
  });

  test('hides noisy work messages', () => {
    expect(parseSupervisorLogLine('[01:23] [work] Response captured. Session: abcdef12...')).toBeNull();
  });

  test('hides supervisor startup noise', () => {
    expect(parseSupervisorLogLine('[00:00] [supervisor] Found git ✓')).toBeNull();
    expect(parseSupervisorLogLine('[00:00] [supervisor] Found claude ✓')).toBeNull();
    expect(parseSupervisorLogLine('[00:00] [supervisor] Starting. Protocol dir: /tmp/proto')).toBeNull();
    expect(parseSupervisorLogLine('[00:00] [supervisor] Worktree: /tmp/worktree')).toBeNull();
    expect(parseSupervisorLogLine('[00:00] [supervisor] Waiting for command...')).toBeNull();
    expect(parseSupervisorLogLine('[00:01] [supervisor] Received command: unblock for task abc')).toBeNull();
    expect(parseSupervisorLogLine('[05:30] [supervisor] Turn complete. Command consumed.')).toBeNull();
    expect(parseSupervisorLogLine('[05:30] [supervisor] Tagged HEAD as turn/abc/post-work/def')).toBeNull();
  });

  test('passes through error messages', () => {
    const errorLine = '[01:23] [supervisor] Error handling command: something failed';
    expect(parseSupervisorLogLine(errorLine)).toBe('[supervisor] Error handling command: something failed');
  });

  test('returns null for empty lines', () => {
    expect(parseSupervisorLogLine('')).toBeNull();
    expect(parseSupervisorLogLine('   ')).toBeNull();
  });

  test('handles lines without timestamp prefix', () => {
    expect(parseSupervisorLogLine('[supervisor] Phase: work')).toBe('Agent working...');
  });
});

// INVARIANT: ActivityMonitor must discover the agent's JSONL via the runner's
// own session-log location — NOT a hard-coded sandbox path. For a host-process
// runner that means the real host HOME. This guards against the regression
// where the loop dashboard shows no agent activity for host-runner tasks.
describe('ActivityMonitor (runner-driven discovery)', () => {
  let worktree: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-am-wt-'));
    fakeHome = await mkdtemp(join(tmpdir(), 'lazy-am-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(worktree, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  test('drains tool-call activity from the host-runner session log', async () => {
    const runner = createRunnerFromType('dangerously-host-process-without-any-isolation');
    const projDir = runner.agentSessionProjectDir(worktree);
    await mkdir(projDir, { recursive: true });

    const entry = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/index.ts' } }],
      },
    });
    await writeFile(join(projDir, 'sess.jsonl'), entry + '\n', 'utf-8');

    const monitor = new ActivityMonitor(runner, worktree, 'task1234');
    // start() kicks an immediate async poll; give it a beat to read the file.
    monitor.start(50);
    await Bun.sleep(120);
    monitor.stop();

    const lines = monitor.drain();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.activity.includes('Reading') && l.activity.includes('index.ts'))).toBe(true);
  });
});
