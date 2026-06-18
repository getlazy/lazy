import { describe, test, expect } from 'bun:test';
import { tryBindTcpPort } from '../../src/server';

// INVARIANT: the daemon's TCP server (web dashboard + /mcp + /rpc) binds to
// loopback (127.0.0.1) by DEFAULT. The dashboard is unauthenticated, so a
// default of 0.0.0.0 would expose it to every machine on the LAN. Remote
// binding must be an explicit, deliberate opt-in. See docs/reviews finding S2.
describe('tryBindTcpPort bind interface', () => {
  const handler = async () => new Response('ok');

  test('binds to 127.0.0.1 by default when no hostname is given', () => {
    // port 0 = pick an ephemeral free port, so this never collides with a
    // developer's running daemon.
    const result = tryBindTcpPort(0, handler, 1);
    expect(result).not.toBeNull();
    try {
      expect(result!.server.hostname).toBe('127.0.0.1');
    } finally {
      result!.server.stop(true);
    }
  });

  test('opt-in: explicit hostname changes the bind address', () => {
    const result = tryBindTcpPort(0, handler, 1, '0.0.0.0');
    expect(result).not.toBeNull();
    try {
      expect(result!.server.hostname).toBe('0.0.0.0');
    } finally {
      result!.server.stop(true);
    }
  });
});
