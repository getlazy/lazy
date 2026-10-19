/**
 * The MCP door's confirmation for launching on lazy's default runner image
 * while the project's own image is not ready: the same two-step
 * `confirmation_code` protocol every MCP confirmation uses.
 */
import { describe, test, expect } from 'bun:test';
import { confirmDefaultImageForMcp } from '../../src/mcp/tools';
import type { RunnerImageAnswer } from '../../src/daemon/rpc-fallback';

const notReady = async (): Promise<RunnerImageAnswer> => ({
  ready: false,
  description: "The project's runner image lazy-custom-abc:0.91 (from Dockerfile.lazy) is still building.",
  project: { state: 'building', imageName: 'lazy-custom-abc:0.91', defaultImage: 'lazy-runner:0.91' },
  task: { needsConfirmation: true, banner: null },
});
const ready = async (): Promise<RunnerImageAnswer> => ({
  ready: true, description: 'ready', project: { state: 'ready' }, task: { needsConfirmation: false, banner: null },
});

function codeFrom(err: unknown): string {
  const m = String(err instanceof Error ? err.message : err).match(/confirmation_code: "([^"]+)"/);
  if (!m) throw new Error(`no confirmation code in: ${String(err)}`);
  return m[1]!;
}

describe('lazy_start / lazy_unblock / lazy_resume default-image confirmation', () => {
  // INVARIANT: the first call launches nothing and hands back a code; only a
  // second call echoing that code confirms the default image.
  test('first call refuses with a code; echoing it confirms', async () => {
    let first: unknown;
    try {
      await confirmDefaultImageForMcp({}, 'task-a', 'lazy_start', notReady);
    } catch (err) {
      first = err;
    }
    expect(String(first)).toContain('Nothing was launched');
    const code = codeFrom(first);
    expect(await confirmDefaultImageForMcp({ confirmation_code: code }, 'task-a', 'lazy_start', notReady))
      .toEqual({ useDefaultImage: true });
    // Single-use: one confirmation cannot be replayed for later launches.
    await expect(confirmDefaultImageForMcp({ confirmation_code: code }, 'task-a', 'lazy_start', notReady))
      .rejects.toThrow(/confirmation_code/);
  });

  test('a made-up code, or one for another task, does not confirm', async () => {
    await expect(confirmDefaultImageForMcp({ confirmation_code: 'di-bogus' }, 'task-a', 'lazy_start', notReady))
      .rejects.toThrow(/confirmation_code/);
    let first: unknown;
    try { await confirmDefaultImageForMcp({}, 'task-a', 'lazy_unblock', notReady); } catch (err) { first = err; }
    await expect(confirmDefaultImageForMcp({ confirmation_code: codeFrom(first) }, 'task-b', 'lazy_unblock', notReady))
      .rejects.toThrow(/confirmation_code/);
  });

  test('no confirmation needed: the argument is ignored and nothing changes', async () => {
    expect(await confirmDefaultImageForMcp({}, 'task-a', 'lazy_resume', ready)).toEqual({});
    expect(await confirmDefaultImageForMcp({ confirmation_code: 'x' }, 'task-a', 'lazy_resume', ready)).toEqual({});
  });
});
