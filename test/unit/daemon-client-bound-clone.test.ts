/**
 * `DaemonClient.create` resolving a bound clone's login record ahead of the
 * local marker files (design doc §4.7, §7.2 task 9's ONE seam).
 *
 * This is unit-level and in-process on purpose: `DaemonClient.create` is the
 * whole of the change everything above it (RemoteStorage, the typed RPC
 * wrappers, every `lazy_*` tool) rides on, so pinning IT directly proves the
 * seam without needing a CLI subprocess or a real project layout. `LAZY_TEST`
 * is irrelevant here — that flag only short-circuits `tryRemoteStorage`, one
 * layer up, never `DaemonClient.create` itself.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { DaemonClient, buildDaemonRpcRequest } from '../../src/daemon/client';
import { writeTeamsLogin, clearTeamsLogin } from '../../src/teams/login';

describe('DaemonClient.create — bound clone (design doc §4.7)', () => {
  let dir: string;
  let undoBaseDir: () => void;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-bound-clone-'));
    undoBaseDir = pinDaemonBaseDir(dir);
  });

  afterEach(async () => {
    undoBaseDir();
    await rm(dir, { recursive: true, force: true });
  });

  test('a bound clone points at the Teams proxy route, carrying the CLI ApiToken', async () => {
    await writeTeamsLogin(dir, {
      teamsUrl: 'https://teams.example.com',
      token: 'lz_cli_token_abc',
      project: 'acme/lazy-toy',
      projectId: '42',
    });

    const client = await DaemonClient.create(dir);
    expect(client).not.toBeNull();

    // The request shape a bound clone actually sends: the proxy route from
    // the design doc, ending in exactly one `/rpc/<command>` segment (not
    // duplicated by the base URL already including it), bearing the token
    // `lazy login` stored — never a locally-minted daemon token.
    const { url, options } = buildDaemonRpcRequest(
      (client as unknown as { target: string }).target,
      (client as unknown as { token: string }).token,
      'list',
      dir,
      {},
    );
    expect(url).toBe('https://teams.example.com/api/projects/acme/lazy-toy/rpc/list');
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer lz_cli_token_abc');
  });

  test('an unbound clone falls back to the local marker-file path unchanged', async () => {
    // No login written — readTeamsLogin resolves null, and with no local
    // marker/token files either, create() must still return null rather than
    // throwing or inventing a target.
    const client = await DaemonClient.create(dir);
    expect(client).toBeNull();
  });

  test('logging out returns a bound clone to the local path', async () => {
    await writeTeamsLogin(dir, {
      teamsUrl: 'https://teams.example.com',
      token: 'lz_cli_token_abc',
      project: 'acme/lazy-toy',
      projectId: '42',
    });
    expect(await DaemonClient.create(dir)).not.toBeNull();

    await clearTeamsLogin(dir);

    // Back to "no daemon reachable" — there is no local daemon in this temp
    // dir either, which is the correct answer once the binding is gone.
    expect(await DaemonClient.create(dir)).toBeNull();
  });
});
