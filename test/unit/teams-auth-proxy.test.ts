import { describe, test, expect } from 'bun:test';
import { gatherProxyEvidence, looksLikeAuthProxy } from '../../src/teams/auth-proxy';
import { DaemonClient, boundCloneFailure } from '../../src/daemon/client';
import { TeamsRequestError } from '../../src/teams/device-auth';

const U = 'https://t.example.com/api/cli/device/code';
async function verdict(res: Response) {
  return looksLikeAuthProxy(await gatherProxyEvidence(res), U);
}
const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { 'content-type': 'text/html', ...(init.headers ?? {}) } });

describe('looksLikeAuthProxy', () => {
  // INVARIANT: only sign-in evidence is called a proxy; every other non-JSON page keeps "check the address".
  test('recognises sign-in pages, challenges and ngrok OAuth codes', async () => {
    expect(await verdict(html('<a href="https://accounts.google.com/o/oauth2">x</a>'))).toBe(true);
    expect(await verdict(html('', { status: 407 }))).toBe(true);
    expect(await verdict(html('', { status: 302, headers: { location: '/login' } }))).toBe(true);
    expect(await verdict(html('x', { status: 401, headers: { 'www-authenticate': 'Basic' } }))).toBe(true);
    expect(await verdict(html('x', { headers: { 'ngrok-error-code': 'ERR_NGROK_302' } }))).toBe(true);
  });
  test('does not call a plain page, JSON, or ngrok offline page a sign-in proxy', async () => {
    expect(await verdict(html('<html>Hello</html>'))).toBe(false);
    expect(await verdict(new Response('{"error":"x"}', { status: 401, headers: { 'content-type': 'application/json' } }))).toBe(false);
    expect(await verdict(html('Tunnel offline ERR_NGROK_3200 ngrok oauth', { status: 404, headers: { 'ngrok-error-code': 'ERR_NGROK_3200' } }))).toBe(false);
  });
});

describe('bound clone behind a sign-in proxy', () => {
  test('rpc throws the proxy message, and boundCloneFailure leaves it alone', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => html('<html>Continue with Google</html>') });
    try {
      const client = DaemonClient.fromTarget(`http://127.0.0.1:${server.port}/api/projects/a/b`, 'tok');
      client.teams = { url: `http://127.0.0.1:${server.port}`, project: 'a/b' };
      const err = (await client.rpc('list', 'a/b').catch((e) => e)) as Error;
      expect(err).toBeInstanceOf(TeamsRequestError);
      expect(err.message).toContain('authenticating proxy');
      expect(boundCloneFailure(client.teams, err)).toBe(err);
    } finally {
      server.stop(true);
    }
  });
});
