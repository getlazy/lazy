/**
 * The reach of the token `lazy login` hands to git, proven with REAL git
 * against local HTTP servers rather than by reading the config back: what
 * matters is which requests carry the header, not what the file says.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertGitSafeToken,
  configureMachineGitAuth,
  machineGitIncludePath,
  removeMachineGitAuth,
  renderGitAuthInclude,
} from '../../src/teams/git-bearer';

const TOKEN = 'aaaa.bbbb.cccc';

interface Recorder {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  auth: Array<string | null>;
}

function recorder(handler?: (req: Request) => Response | undefined): Recorder {
  const auth: Array<string | null> = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      auth.push(req.headers.get('authorization'));
      return handler?.(req) ?? new Response('no', { status: 404 });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}`, auth };
}

describe('machine-level git auth', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const servers: Recorder[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-machine-git-'));
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'LAZY_DAEMON_BASE_DIR', 'HOME']) saved[k] = process.env[k];
    // Never the real ~/.gitconfig.
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.LAZY_DAEMON_BASE_DIR = join(dir, 'daemon');
    process.env.HOME = dir;
    await writeFile(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Someone\n');
  });

  afterEach(async () => {
    for (const r of servers.splice(0)) r.server.stop(true);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function lsRemote(url: string): Promise<number> {
    const proc = Bun.spawn(['git', 'ls-remote', url], {
      cwd: dir, stdout: 'ignore', stderr: 'ignore',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return await proc.exited;
  }

  // INVARIANT: the token goes to the exact install origin, once, and nowhere
  // else — not another port on the same host, not a redirect target. A token
  // that leaks to a second host is a stolen login.
  test('only the exact origin gets the header, exactly once, and redirects are not followed', async () => {
    const other = recorder();
    servers.push(other);
    const install = recorder((req) => {
      if (new URL(req.url).pathname.startsWith('/redirect')) {
        return new Response(null, { status: 302, headers: { location: `${other.url}/x.git/info/refs?service=git-upload-pack` } });
      }
      return undefined;
    });
    servers.push(install);

    const result = await configureMachineGitAuth(install.url, TOKEN);
    expect(result.addedInclude).toBe(true);
    expect(result.globalConfigFile).toBe(process.env.GIT_CONFIG_GLOBAL!);

    await lsRemote(`${install.url}/git/acme/api.git`);
    expect(install.auth[0]).toBe(`Bearer ${TOKEN}`);

    await lsRemote(`${other.url}/git/acme/api.git`);
    expect(other.auth.every((a) => a === null)).toBe(true);

    install.auth.length = 0;
    await lsRemote(`${install.url}/redirect/x.git`);
    expect(install.auth[0]).toBe(`Bearer ${TOKEN}`);
    // followRedirects=false: git never even asked the redirect target.
    expect(other.auth.length).toBe(1);
  });

  // INVARIANT: a clone bound by an older login (header in its LOCAL config,
  // which git reads after the user-level one) still sends exactly one
  // Authorization header once the machine logs in. Two are refused by the install.
  test('a clone with an older clone-local header sends exactly one header after machine login', async () => {
    const install = recorder();
    servers.push(install);
    const repo = join(dir, 'clone');
    await mkdir(repo);
    const git = (...args: string[]) => Bun.spawn(['git', ...args], { cwd: repo, env: process.env, stdout: 'ignore', stderr: 'ignore' }).exited;
    await git('init', '-q');
    // Where an older login put it: <daemon base>/<slug>/teams-git-auth.inc.
    const legacy = join(process.env.LAZY_DAEMON_BASE_DIR!, 'clone-1234abcd', 'teams-git-auth.inc');
    await mkdir(join(legacy, '..'), { recursive: true });
    await writeFile(legacy, `[http "${install.url}/"]\n\textraHeader = Authorization: Bearer old.old.old\n`);
    await git('config', '--local', '--add', 'include.path', legacy);

    const result = await configureMachineGitAuth(install.url, TOKEN);
    expect(result.retiredCloneHeaders).toBe(1);
    await expect(stat(legacy)).rejects.toThrow();

    const proc = Bun.spawn(['git', 'ls-remote', `${install.url}/git/acme/api.git`], {
      cwd: repo, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    await proc.exited;
    expect(install.auth[0]).toBe(`Bearer ${TOKEN}`);
  });

  test('the user config holds only the path; the file is 0600 in a 0700 dir; logout removes both', async () => {
    const install = recorder();
    servers.push(install);
    await configureMachineGitAuth(install.url, TOKEN);
    // A repeat login does not add a second entry.
    expect((await configureMachineGitAuth(install.url, TOKEN)).addedInclude).toBe(false);

    const userConfig = await readFile(process.env.GIT_CONFIG_GLOBAL!, 'utf-8');
    expect(userConfig).not.toContain(TOKEN);
    expect(userConfig.match(/path = /g)).toHaveLength(1);
    const file = machineGitIncludePath(install.url);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(file, '..'))).mode & 0o777).toBe(0o700);

    expect(await removeMachineGitAuth(install.url)).toBe(process.env.GIT_CONFIG_GLOBAL!);
    expect(await readFile(process.env.GIT_CONFIG_GLOBAL!, 'utf-8')).not.toContain(file);
    await expect(stat(file)).rejects.toThrow();
    // Idempotent: nothing left to remove.
    expect(await removeMachineGitAuth(install.url)).toBeNull();
  });

  test('the section names the origin only: scheme, host and port, never a wildcard', () => {
    const text = renderGitAuthInclude('https://r.example.com', TOKEN);
    expect(text).toContain('[http "https://r.example.com/"]');
    expect(text).not.toContain('*');
    expect(renderGitAuthInclude('http://127.0.0.1:3000', TOKEN)).toContain('[http "http://127.0.0.1:3000/"]');
  });

  // INVARIANT: lazy uses the address exactly as typed — the include rewrites nothing, so an http:// URL stays http://
  // (never silently moved to https), and the token goes to the typed origin only.
  test('the include rewrites no URL, for either scheme', async () => {
    for (const url of ['https://r.example.com', 'http://r.example.com']) {
      const text = renderGitAuthInclude(url, TOKEN);
      expect(text).not.toContain('insteadOf');
      expect(text).toContain('followRedirects = false');
    }
    const resolved = async (url: string) => {
      const proc = Bun.spawn(['git', 'ls-remote', '--get-url', url], { cwd: dir, stdout: 'pipe', stderr: 'ignore', env: process.env });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.trim();
    };
    await configureMachineGitAuth('https://r.example.com', TOKEN);
    expect(await resolved('http://r.example.com/git/a/b.git')).toBe('http://r.example.com/git/a/b.git');
    await removeMachineGitAuth('https://r.example.com');
  });

  // INVARIANT: a value from the network never gets to write git config syntax.
  test('a token that could break out of the config value is refused', () => {
    for (const bad of ['a b', 'a\nb', 'a"b', 'a;b', 'a#b', 'a\\b', '[x]', '']) {
      expect(() => assertGitSafeToken(bad)).toThrow();
    }
    expect(() => assertGitSafeToken('lz_abc-DEF_123')).not.toThrow();
    expect(() => assertGitSafeToken('eyJh.eyJz.c2ln')).not.toThrow();
  });
});
