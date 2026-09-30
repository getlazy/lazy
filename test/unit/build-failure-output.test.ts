import { describe, expect, test } from 'bun:test';
import { extractBuildFailureOutput } from '../../src/capture/claude';
import { waitForInterveningBuildOutput } from '../../src/upgrade/interactive-prompt';
import { BackgroundImageBuild } from '../../src/upgrade/background-image-build';

describe('extractBuildFailureOutput', () => {
  // INVARIANT: a failed BuildKit build shows the failing step's own output, not just the closing Dockerfile excerpt. The compiler error is what the human must fix.
  test('shows the failing step output even when it is beyond the last 10 lines', () => {
    const lines = ['#49 DONE 1.0s', '#50 [12/12] RUN cargo build --locked'];
    for (let i = 0; i < 30; i++) lines.push(`#50 ${i}.0 compiling crate${i}`);
    lines.push('#50 31.0 error[E0308]: mismatched types');
    lines.push('#50 ERROR: process "cargo build" did not complete successfully: exit code: 101');
    for (let i = 0; i < 12; i++) lines.push(` 74${i} | Dockerfile excerpt`);
    lines.push('ERROR: failed to build: failed to solve');
    const out = extractBuildFailureOutput(lines.join('\n'));
    expect(out).toContain('error[E0308]: mismatched types');
    expect(out).toContain('#50 ERROR: process');
    expect(out).not.toContain('Dockerfile excerpt');
  });

  test('ignores interleaved lines of other parallel steps', () => {
    const out = extractBuildFailureOutput([
      '#7 0.5 unrelated step noise',
      '#50 1.0 error[E0308]: mismatched types',
      '#8 2.0 another parallel step',
      '#50 ERROR: process "cargo build" failed: exit code: 101',
    ].join('\n'));
    expect(out).toContain('error[E0308]');
    expect(out).not.toContain('unrelated');
    expect(out).not.toContain('parallel');
  });

  test('falls back when the failing step printed nothing but status lines', () => {
    const raw = ['#50 DONE 0.0s', '#50 ERROR: boom', 'tail line'].join('\n');
    expect(extractBuildFailureOutput(raw)).toContain('tail line');
  });

  test('real BuildKit shape: timestamped step lines interleaved with another step, status lines dropped', () => {
    const out = extractBuildFailureOutput([
      '#49 [11/12] RUN something else',
      '#50 [12/12] RUN cargo build --locked',
      '#50 CACHED',
      '#49 1.20 other step output',
      '#50 12.34 error[E0425]: cannot find value `x` in this scope',
      '#49 DONE 2.0s',
      '#50 12.40 DONE 0.1s',
      '#50 12.50 error: could not compile `lazy`',
      '#50 ERROR: process "/bin/bash -o pipefail -c cargo build --locked" did not complete successfully: exit code: 101',
      ' 744 | >>> RUN cargo build --locked',
    ].join('\n'));
    expect(out).toContain('12.34 error[E0425]');
    expect(out).toContain('12.50 error: could not compile');
    expect(out).toContain('#50 ERROR: process');
    expect(out).not.toContain('#49');
    expect(out).not.toContain('other step output');
    expect(out).not.toMatch(/CACHED/);
    expect(out).not.toContain('DONE 0.1s');
    expect(out).not.toContain('Dockerfile');
    expect(out).not.toContain('>>> RUN');
  });

  test('falls back to the last 10 lines for unparseable output', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    expect(extractBuildFailureOutput(raw).split('\n')).toHaveLength(10);
  });
});

describe('waitForInterveningBuildOutput', () => {
  // INVARIANT: a failed background build aborts the upgrade before any "Image build finished" prompt.
  test('throws when the build failed', async () => {
    const build = new BackgroundImageBuild('t-upgrade', {
      build: async () => { throw new Error('Container build failed with exit code 1'); },
      canonicalTags: async () => [],
      tag: async () => {},
      untag: async () => true,
      now: () => Date.now(),
    });
    await build.awaitSettled();
    await expect(waitForInterveningBuildOutput(build)).rejects.toThrow('Container build failed');
  });
});
