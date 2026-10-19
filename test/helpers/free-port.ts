// A loopback port that is NOT listening, for "nothing is there" targets (a
// dead upstream). Best-effort: the port is released before this returns, so in
// principle the OS can reissue it to someone else. Use it ONLY for dead-port
// targets, never to pick a port a server will bind: bind `port: 0` and read the
// assigned port back from the returned server (`server.port`) instead.
export function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error('freePort: OS did not assign a port to the probe server');
  return port;
}
