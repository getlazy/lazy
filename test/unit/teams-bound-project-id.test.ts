/**
 * A bound clone's RPC calls through Lazy Teams carry the id of the project it
 * bound to (`X-Lazy-Teams-Project-Id`), beside the `team/project` address in
 * the path.
 *
 * INVARIANT: the address alone cannot say which project a clone meant — a
 * project or team can be renamed and its old address taken by a DIFFERENT
 * project. Teams resolves the bound project by this id and refuses rather than
 * serve whoever holds the address now; a call without it is an older `lazy`.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { DaemonClient, TEAMS_PROJECT_ID_HEADER, teamsProjectHeaders } from '../../src/daemon/client';

describe('the bound project id header', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test('is sent on every call of a bound client, and never by an unbound one', async () => {
    const seen: (string | null)[] = [];
    server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers.get(TEAMS_PROJECT_ID_HEADER));
        return Response.json({ ok: true });
      },
    });
    const target = `http://127.0.0.1:${server.port}/api/projects/acme/lazy-toy`;

    const bound = DaemonClient.fromTarget(target, 'tok');
    bound.teams = { url: `http://127.0.0.1:${server.port}`, project: 'acme/lazy-toy', projectId: '17' };
    await bound.rpc('list', '/p');

    const unbound = DaemonClient.fromTarget(target, 'tok');
    await unbound.rpc('list', '/p');

    expect(seen).toEqual(['17', null]);
  });

  test('is omitted for a binding that recorded no id', () => {
    expect(teamsProjectHeaders({ url: 'https://t', project: 'a/b' })).toEqual({});
    expect(teamsProjectHeaders(null)).toEqual({});
  });
});
