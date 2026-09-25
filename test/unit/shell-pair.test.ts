/**
 * Pair and Chat over the web-shell WebSocket (src/server/shell-pair.ts).
 *
 * The upgrader reuses the same PTY/exec path as a plain container shell; this
 * file pins the mode query and the 30s drop timeout the UI advertises. Full
 * lock/hands-off behaviour is the CLI's, reused rather than reimplemented.
 */

import { describe, test, expect } from 'bun:test';
import { parseShellSessionMode, WEB_PAIR_GRACE_MS } from '../../src/server/shell-pair';

describe('parseShellSessionMode', () => {
  test('only pair and chat are extra origins; anything else is a plain shell', () => {
    expect(parseShellSessionMode('pair')).toBe('pair');
    expect(parseShellSessionMode('chat')).toBe('chat');
    expect(parseShellSessionMode('shell')).toBe('shell');
    expect(parseShellSessionMode(null)).toBe('shell');
    expect(parseShellSessionMode('exec')).toBe('shell');
  });
});

describe('WEB_PAIR_GRACE_MS', () => {
  // A dropped WebSocket must not leave the task locked forever. The daemon
  // process is still alive after a drop, so the PID-based pairing lock would
  // never go stale on its own. 30s is what the Shell tab copy states.
  test('a dropped Pair connection releases the lock after 30 seconds', () => {
    expect(WEB_PAIR_GRACE_MS).toBe(30_000);
  });
});
