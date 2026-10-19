/**
 * Pre-origin-keyed (host-only) Teams logins and the git includes they wrote:
 * migration follows the scheme the login was USED on, and an http include
 * carrying this machine's https token is retired.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setCredential, getStoredCredential } from '../../src/credentials/store';
import { machineLoginRoot, readMachineToken, storedOriginToken, writeMachineLogin } from '../../src/teams/machine-login';
import { machineGitAuthDir, retireMisissuedGitIncludes } from '../../src/teams/git-bearer';

const HOST = 'teams.example.test:3000';

describe('legacy Teams machine logins', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-legacy-login-'));
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'LAZY_DAEMON_BASE_DIR', 'HOME', 'LAZY_CONFIG']) saved[k] = process.env[k];
    // The file backend, never the developer's real keychain.
    await writeFile(join(dir, 'lazy.toml'), '[credentials]\nbackend = "file"\n');
    process.env.LAZY_CONFIG = join(dir, 'lazy.toml');
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.LAZY_DAEMON_BASE_DIR = join(dir, 'daemon');
    process.env.HOME = dir;
    await writeFile(process.env.GIT_CONFIG_GLOBAL, '');
    await mkdir(machineGitAuthDir(), { recursive: true });
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const legacyInclude = (scheme: string, token: string) => writeFile(
    join(machineGitAuthDir(), `${HOST.replace(/[^A-Za-z0-9.-]/g, '_')}.inc`),
    `[http "${scheme}://${HOST}/"]\n\textraHeader =\n\textraHeader = Authorization: Bearer ${token}\n`,
  );

  // INVARIANT: a host-keyed login an http-only install wrote keeps working
  // over http. Reading every legacy record as https made it silently vanish.
  test('a legacy login whose include was used over http also answers http', async () => {
    await setCredential(machineLoginRoot(), { provider: `teams:${HOST}`, kind: 'api-key', secret: 'lz_plain' });
    await legacyInclude('http', 'lz_plain');
    expect(await readMachineToken(`http://${HOST}`)).toBe('lz_plain');
    expect(await storedOriginToken(`http://${HOST}`)).toBe('lz_plain');
  });

  // INVARIANT: an http include does not prove an http login — an older
  // `lazy clone http://…` rewrote https logins' includes to http. The legacy
  // record keeps answering https, and an http migration never deletes it.
  test('a rewritten http include never takes the https login away', async () => {
    await setCredential(machineLoginRoot(), { provider: `teams:${HOST}`, kind: 'api-key', secret: 'lz_plain' });
    await legacyInclude('http', 'lz_plain');
    expect(await readMachineToken(`http://${HOST}`)).toBe('lz_plain');
    expect(await getStoredCredential(machineLoginRoot(), `teams:${HOST}`)).not.toBeNull();
    expect(await readMachineToken(`https://${HOST}`)).toBe('lz_plain');
  });

  test('with no include a legacy login still stands for https only', async () => {
    await setCredential(machineLoginRoot(), { provider: `teams:${HOST}`, kind: 'api-key', secret: 'lz_plain' });
    expect(await readMachineToken(`http://${HOST}`)).toBeNull();
    expect(await readMachineToken(`https://${HOST}`)).toBe('lz_plain');
  });

  // INVARIANT: an http include carrying the token this machine holds for the
  // same host over https is the plaintext leak an older `lazy clone http://`
  // left; it is retired even though a plain token names no issuer. A plain
  // http token that is not the https one is a genuine http login and stays.
  test('a plain-token http include carrying the https token is retired; a genuine one stays', async () => {
    await writeMachineLogin(`https://${HOST}`, 'lz_https');
    const leaking = join(machineGitAuthDir(), `http_${HOST.replace(/[^A-Za-z0-9.-]/g, '_')}.inc`);
    await writeFile(leaking, `[http "http://${HOST}/"]\n\textraHeader = Authorization: Bearer lz_https\n`);
    expect(await retireMisissuedGitIncludes(storedOriginToken)).toEqual([`http://${HOST}`]);
    await expect(stat(leaking)).rejects.toThrow();

    await writeFile(leaking, `[http "http://${HOST}/"]\n\textraHeader = Authorization: Bearer lz_other\n`);
    expect(await retireMisissuedGitIncludes(storedOriginToken)).toEqual([]);
    expect((await stat(leaking)).isFile()).toBe(true);
  });
});
