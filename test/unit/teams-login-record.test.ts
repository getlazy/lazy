/**
 * Unit tests: writing and replacing a clone's Teams login record.
 *
 * The concern here is not the happy path (the e2e covers it) but what a clone is
 * left holding when the write cannot complete.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { getCredentialsPath } from '../../src/daemon/paths';
import { setCredential } from '../../src/credentials/store';
import { clearTeamsLogin, readTeamsLogin, writeTeamsLogin } from '../../src/teams/login';

describe('teams login record', () => {
  let projectRoot: string;
  let baseDir: string;
  let undoBaseDir: () => void;
  const savedConfig = process.env.LAZY_CONFIG;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-teams-login-'));
    baseDir = await mkdtemp(join(tmpdir(), 'lazy-teams-login-daemon-'));
    undoBaseDir = pinDaemonBaseDir(baseDir);
    const configPath = join(projectRoot, 'lazy.toml');
    await writeFile(configPath, '[credentials]\nbackend = "file"\n');
    process.env.LAZY_CONFIG = configPath;
  });

  afterEach(async () => {
    undoBaseDir();
    if (savedConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = savedConfig;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  test('a login replaces the previous one rather than accumulating', async () => {
    await writeTeamsLogin(projectRoot, {
      teamsUrl: 'https://teams.example.com',
      token: 'first-token-value',
      project: 'acme/api-server',
      projectId: '11',
    });
    await writeTeamsLogin(projectRoot, {
      teamsUrl: 'https://other.example.com',
      token: 'second-token-value',
      project: 'acme/web',
      projectId: '12',
    });

    const login = await readTeamsLogin(projectRoot);
    expect(login?.binding.project).toBe('acme/web');
    expect(login?.binding.teams_url).toBe('https://other.example.com');
  });

  // INVARIANT: save first, act second. The superseded login is deleted only once
  // the replacement is durably written. Deleting first left a locked keychain or
  // a disk error with NO login at all — the working binding destroyed, and the
  // token the install had just minted live and held by nobody.
  test('a failed write leaves the previous login intact', async () => {
    await writeTeamsLogin(projectRoot, {
      teamsUrl: 'https://teams.example.com',
      token: 'first-token-value',
      project: 'acme/api-server',
      projectId: '11',
    });

    // Make the secret backend unwritable: a directory where the file backend
    // expects its file is an I/O failure it cannot swallow.
    const secretsPath = getCredentialsPath(projectRoot);
    await rm(secretsPath, { force: true });
    await mkdir(secretsPath);

    await expect(writeTeamsLogin(projectRoot, {
      teamsUrl: 'https://other.example.com',
      token: 'second-token-value',
      project: 'acme/web',
      projectId: '12',
    })).rejects.toThrow();

    const login = await readTeamsLogin(projectRoot);
    expect(login?.binding.project).toBe('acme/api-server');
    expect(login?.binding.teams_url).toBe('https://teams.example.com');
  });

  // INVARIANT: logout can act on a store holding TWO logins. Every other path
  // refuses that state and tells the person to run `lazy logout` — so resolving
  // it through the same single-record read made logout throw the error naming
  // logout as the remedy, leaving no lazy command able to recover the clone.
  // The state is reachable: writeTeamsLogin writes before deleting, so a delete
  // that fails leaves two.
  test('logout clears a store holding two logins', async () => {
    await setCredential(projectRoot, {
      provider: 'teams:one.example.com',
      kind: 'api-key',
      secret: 'token-one-value',
      binding: {
        teams_url: 'https://one.example.com',
        project: 'acme/api-server',
        project_id: '11',
        bound_at: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    await setCredential(projectRoot, {
      provider: 'teams:two.example.com',
      kind: 'api-key',
      secret: 'token-two-value',
      binding: {
        teams_url: 'https://two.example.com',
        project: 'acme/web',
        project_id: '12',
        bound_at: new Date().toISOString(),
      },
    });

    // The wedged state, as every other command sees it.
    await expect(readTeamsLogin(projectRoot)).rejects.toThrow(/2 Teams logins/);

    const removed = await clearTeamsLogin(projectRoot);
    expect(removed?.removedCount).toBe(2);
    // The newest is what the person thinks they are logged in to.
    expect(removed?.binding.project).toBe('acme/web');

    // And the clone is recovered: the read that used to throw now says unbound.
    expect(await readTeamsLogin(projectRoot)).toBeNull();
    expect(await clearTeamsLogin(projectRoot)).toBeNull();
  });
});
