/**
 * INVARIANT: only INPUT keeps a member's terminal open. A terminal printing
 * away — a dev server's log — with nobody at the keyboard is idle, and closes
 * after the idle limit; a resize (which a browser sends by itself) does not
 * count either. Counted as activity, output let a chatty process hold every
 * turn off the task for the full twelve-hour maximum.
 */

import { test, expect } from 'bun:test';
import { createShellRelayHandler, relayTerminalOutput } from '../../src/server/shell-ws';

function fakeSocket() {
  const touches: string[] = [];
  const writes: number[] = [];
  const data = {
    exec: { write: (b: Uint8Array) => { writes.push(b.byteLength); }, resize: async () => {} },
    idle: { touch: () => { touches.push('touch'); }, stop: () => {} },
  };
  return { ws: { data, sendBinary: () => 0 } as never, touches, writes };
}

test('terminal output and resizes never count as activity; keystrokes do', () => {
  const handler = createShellRelayHandler() as { message: (ws: unknown, m: string | Buffer) => void };
  const { ws, touches, writes } = fakeSocket();

  for (let i = 0; i < 100; i++) relayTerminalOutput(ws, new Uint8Array([65, 66]));
  handler.message(ws, JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  expect(touches).toEqual([]);

  handler.message(ws, Buffer.from('ls\r'));
  expect(touches).toEqual(['touch']);
  expect(writes).toEqual([3]);
});
