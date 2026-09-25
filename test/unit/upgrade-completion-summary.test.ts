/**
 * Upgrade completion summary — the final block printed after image builds.
 *
 * INVARIANT: human-facing commands must not end silently after long work.
 * The completion block is the last stdout write so it survives scrollback
 * from docker build progress and earlier interactive prompts.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  printFullUpgradeCompletionSummary,
  printImageRefreshCompletionSummary,
  readPreviousDaemonVersion,
} from '../../src/upgrade/completion-summary';
import { getDaemonDir } from '../../src/daemon/paths';
import { resetColorCache } from '../../src/render/theme';

describe('upgrade completion summary', () => {
  let testDir: string;
  let baseDir: string;
  let savedBaseDir: string | undefined;
  let lines: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-upgrade-summary-'));
    baseDir = mkdtempSync(join(tmpdir(), 'lazy-upgrade-summary-daemon-'));
    savedBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
    resetColorCache();
    lines = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
      originalLog(...args);
    };
  });

  afterEach(() => {
    console.log = originalLog;
    if (savedBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = savedBaseDir;
    rmSync(testDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });

  test('readPreviousDaemonVersion returns the stored version', async () => {
    mkdirSync(getDaemonDir(testDir), { recursive: true });
    writeFileSync(
      join(getDaemonDir(testDir), 'daemon-last-version.json'),
      JSON.stringify({ version: '0.22.1000' }) + '\n',
    );

    await expect(readPreviousDaemonVersion(testDir)).resolves.toBe('0.22.1000');
  });

  test('readPreviousDaemonVersion returns null when no marker exists', async () => {
    await expect(readPreviousDaemonVersion(testDir)).resolves.toBeNull();
  });

  test('printFullUpgradeCompletionSummary includes version transition and rebuild details', async () => {
    await printFullUpgradeCompletionSummary({
      previousVersion: '0.22.1000',
      currentVersion: '0.22.1141',
      imageTags: ['lazy-runner:0.22.1141', 'lazy-runner:latest'],
      imageBuildSeconds: 42,
      agentBinaryProvenance: {
        buildSourcePath: '/home/dev/lazy',
        buildBranch: 'main',
        buildSha: 'abc1234',
        buildDirty: false,
      },
      daemonRestarted: true,
      interruptedTaskCount: 2,
      builderSessionCount: 1,
      interactiveSessionCount: 0,
    });

    const output = lines.join('\n');
    expect(output).toContain('Upgrade complete');
    expect(output).toContain('0.22.1000 → 0.22.1141');
    expect(output).toContain('lazy-runner:0.22.1141');
    expect(output).toContain('rebuilt in 42s');
    expect(output).toContain('rebuilt agent binary (verified)');
    expect(output).toContain('built from');
    expect(output).toContain('restarted with version 0.22.1141');
    expect(output).toContain('2 interrupted tasks will auto-resume');
    expect(output).toContain('1 builder session will resume in place');
  });

  test('printImageRefreshCompletionSummary states non-disruptive next steps', () => {
    printImageRefreshCompletionSummary({
      currentVersion: '0.22.1141',
      imageTags: ['lazy-runner:0.22.1141', 'lazy-runner:latest'],
    });

    const output = lines.join('\n');
    expect(output).toContain('Image refresh complete');
    expect(output).toContain('not restarted');
    expect(output).toContain('were NOT touched');
    expect(output).toContain('lazy upgrade');
  });
});
