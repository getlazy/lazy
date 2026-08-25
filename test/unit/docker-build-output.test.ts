/**
 * Presentation helpers for streamed `docker build` output.
 *
 * These exist so a long build is visibly alive. Now that builds are unbounded
 * (see test/unit/docker-build-timeout.test.ts), a silent build is the only
 * thing that could still look like a hang — so what gets echoed matters.
 */

import { describe, test, expect } from 'bun:test';
import {
  isBuildProgressLine,
  splitLines,
  formatDuration,
  buildTimeoutMessage,
} from '../../src/capture/docker-build-output';

describe('isBuildProgressLine', () => {
  test('echoes BuildKit step headers and terminal states', () => {
    expect(isBuildProgressLine('#7 [3/9] RUN apt-get update')).toBe(true);
    expect(isBuildProgressLine('#7 DONE 4.1s')).toBe(true);
    expect(isBuildProgressLine('#7 CACHED')).toBe(true);
    expect(isBuildProgressLine('#7 ERROR: process did not complete')).toBe(true);
    expect(isBuildProgressLine('#1 [internal] load build definition')).toBe(true);
  });

  test('echoes classic-builder steps', () => {
    expect(isBuildProgressLine('Step 3/9 : RUN apt-get update')).toBe(true);
    expect(isBuildProgressLine('Successfully tagged lazy-runner:0.22')).toBe(true);
  });

  // The noise this filters out is the whole reason for filtering: a Dockerfile
  // that apt-installs a desktop stack emits thousands of these, and dumping
  // them makes the console useless rather than informative.
  test('suppresses per-step output and blank lines', () => {
    expect(isBuildProgressLine('#7 0.412 Get:1 http://deb.debian.org bookworm InRelease')).toBe(false);
    expect(isBuildProgressLine('  Setting up libfoo:amd64 (1.2-3) ...')).toBe(false);
    expect(isBuildProgressLine('')).toBe(false);
    expect(isBuildProgressLine('   ')).toBe(false);
  });
});

describe('splitLines', () => {
  test('holds back a partial trailing line', () => {
    const first = splitLines('#1 DONE 1s\n#2 [1/2] RU');
    expect(first.lines).toEqual(['#1 DONE 1s']);
    expect(first.remainder).toBe('#2 [1/2] RU');

    // The remainder must be prependable, or step headers get cut in half.
    const second = splitLines(first.remainder + 'N true\n');
    expect(second.lines).toEqual(['#2 [1/2] RUN true']);
    expect(second.remainder).toBe('');
  });
});

describe('formatDuration', () => {
  test('reads naturally at every scale', () => {
    expect(formatDuration(60)).toBe('60ms');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(90_000)).toBe('1m30s');
    expect(formatDuration(20 * 60_000)).toBe('20m');
  });
});

describe('buildTimeoutMessage', () => {
  // The defect this whole change fixes: a build lazy killed on a timer looked
  // like Docker failing. The message must make that impossible to misread.
  test('names lazy as the killer and the flag as the remedy', () => {
    const message = buildTimeoutMessage(20 * 60_000, 20 * 60_000);
    expect(message).toContain('lazy killed it');
    expect(message).toContain('Docker did not fail');
    expect(message).toContain('20m');
    expect(message).toContain('--timeout');
    expect(message).toContain('UNBOUNDED by');
    expect(message).toContain('build cache');
  });
});
