/**
 * Client side of the traffic stream: what it prints when it CANNOT stream.
 *
 * The rendering path is covered by proxy-activity-renderer.test.ts and the real
 * end-to-end path by test/e2e/watch-proxy-traffic.test.ts. What is left — and
 * what actually burned a user — is the failure path: a header promising traffic
 * above a screen that never fills. Whatever goes wrong, the stream says so.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';

afterAll(async () => { await restoreMockedModules(); });

/** Fast backoff so a retry path costs milliseconds, not 23 real seconds. */
const FAST_RETRIES = [1, 1, 1];

async function startStream(
  rpc: (...args: unknown[]) => Promise<unknown>,
  retryDelaysMs: number[] = FAST_RETRIES,
) {
  await mockModule('../../src/daemon/client', () => ({
    tryRpc: rpc,
    // The real module exports this and the stream treats it as terminal.
    NotALazyProjectError: class NotALazyProjectError extends Error {},
  }));
  // Imported AFTER the mock is installed so it binds to the mocked client.
  const { streamProxyActivity } = await import('../../src/cli/proxy-activity-stream');
  const lines: string[] = [];
  const handle = streamProxyActivity({
    includeTask: false,
    write: (line) => lines.push(line),
    retryDelaysMs,
  });
  return { lines, handle };
}

async function runStream(rpc: () => Promise<unknown>): Promise<string[]> {
  const { lines, handle } = await startStream(rpc);
  await handle.done;
  return lines;
}

describe('streamProxyActivity failure reporting', () => {
  // A daemon started before traffic streaming existed answers 404 to the
  // command. Reported quietly, the user sees the `net>` header and then an
  // empty screen for the whole turn and concludes the feature is broken —
  // which is exactly what happened in the field for a different reason.
  test('a daemon that predates traffic streaming fails loud, naming the fix', async () => {
    const lines = await runStream(() => {
      throw new Error('Unknown RPC command: watchProxyActivity');
    });
    const text = lines.join('\n');
    expect(text).toContain('predates traffic streaming');
    expect(text).toContain('lazy daemon restart');
  });

  // A watch runs for hours; a daemon restart or one dropped connection inside
  // that span is normal. Treating the first one as terminal silenced the
  // load-bearing half of the screen for the rest of the session while
  // supervisor lines kept scrolling — indistinguishable from an idle agent.
  test('a transient transport failure is retried, not treated as fatal', async () => {
    let calls = 0;
    const { lines, handle } = await startStream(async () => {
      calls++;
      if (calls === 1) throw new Error('connection refused\nstack line that must not be printed');
      // The second window opens and stays open until stop() aborts it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {};
    });
    while (calls < 2) await new Promise((r) => setTimeout(r, 5));
    handle.stop();
    await handle.done;

    expect(lines.join('\n')).toContain('reconnecting');
    expect(lines.join('\n')).not.toContain('stack line');
    expect(lines.join('\n')).not.toContain('stopped after');
  });

  test('retries are bounded — a daemon that stays gone is reported once', async () => {
    const lines = await runStream(async () => {
      throw new Error('connection refused\nstack line that must not be printed');
    });
    const text = lines.join('\n');
    expect(text).toContain('connection refused');
    expect(text).not.toContain('stack line');
    expect(text).toContain(`stopped after ${FAST_RETRIES.length} reconnect attempts`);
    // One "interrupted" notice and one final line — not one per attempt.
    expect(lines).toHaveLength(2);
  });

  // stop() must ABORT the in-flight window, not merely stop re-subscribing:
  // without that, `lazy watch` printed "Task X is no longer running" and then
  // sat there for the rest of a 120s window still emitting traffic lines.
  test('stop() abandons the in-flight window promptly and prints nothing after', async () => {
    const box: { emit?: (payload: unknown) => void } = {};
    const { lines, handle } = await startStream(async (
      _command: unknown,
      _params: unknown,
      observers: unknown,
      signal: unknown,
    ) => {
      const obs = observers as { onProgress?: (e: unknown) => void };
      box.emit = (payload: unknown) => obs.onProgress?.({
        kind: 'activity', channel: 'proxy', payload,
      });
      // A real window ends when its timer fires OR the signal aborts.
      await new Promise<void>((resolve) => {
        (signal as AbortSignal).addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    });

    while (!box.emit) await new Promise((r) => setTimeout(r, 5));
    handle.stop();
    // An event already in the transport buffer when stop() ran must not paint:
    // watch has just told the user the task is finished.
    box.emit({
      kind: 'open', id: 'late', seq: 1, ts: Date.now(), role: 'agent',
      taskId: 't', backend: 'proxy', method: 'POST', path: '/v1/messages', model: null,
    });
    await handle.done;
    expect(lines).toEqual([]);
  });

  // null = the daemon RPC path is bypassed. Returning without a word would
  // leave the caller waiting on a stream that will never produce a line.
  test('a bypassed daemon RPC path is reported rather than spun on', async () => {
    const lines = await runStream(async () => null);
    expect(lines.join('\n')).toContain('bypassed');
  });
});
