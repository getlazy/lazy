import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { managedRepositoryHostChecks, defaultRunCommand, type RunCommand } from '../../src/doctor/managed-repository-host';
import type { ResolvedConfig } from '../../src/config';

function cfg(driver: string): ResolvedConfig {
  return { remote: { driver, git_remote: 'origin' } } as unknown as ResolvedConfig;
}

async function sh(argv: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(argv, { cwd, stdout: 'ignore', stderr: 'pipe' });
  if ((await p.exited) !== 0) throw new Error(`${argv.join(' ')}: ${await new Response(p.stderr).text()}`);
}

// A runner with no forge CLI on it, whatever the test machine has installed —
// the shape of the Teams daemon image, which ships git and no gh/glab.
const noForgeCli: RunCommand = (argv, cwd) =>
  argv[0] === 'gh' || argv[0] === 'glab'
    ? Promise.resolve({ exitCode: 127, stdout: '', stderr: `binary '${argv[0]}' not found` })
    : defaultRunCommand(argv, cwd);

describe('managed repository-host check', () => {
  let dir: string;
  let repo: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-managed-host-')));
    const bare = join(dir, 'remote.git');
    repo = join(dir, 'clone');
    await sh(['git', 'init', '--bare', '-q', bare], dir);
    await sh(['git', 'init', '-q', repo], dir);
    await sh(['git', 'remote', 'add', 'origin', bare], repo);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  // INVARIANT: on a Teams daemon, a reachable remote with no forge CLI is NOT a
  // failure. The daemon image ships git and no gh; git authenticates through the
  // fleet's credential helper, so failing on `gh` told members a working
  // repository was unreachable.
  test('git reachable + no gh: passes, with a warning about API features only', async () => {
    const checks = await managedRepositoryHostChecks(cfg('github'), repo, noForgeCli, { GH_TOKEN: 'x' });
    expect(checks.filter(c => c.state === 'fail')).toEqual([]);
    expect(checks[0]).toMatchObject({ state: 'ok', what: 'Git can reach and authenticate to remote origin' });
    const api = checks.find(c => c.what.startsWith('GitHub API features'));
    expect(api?.state).toBe('warn');
    expect(api && 'reason' in api ? api.reason : '').toContain('gh CLI is not installed');
  });

  // INVARIANT: ls-remote proves read access only, and a public repository
  // answers it anonymously — so a missing forge token must FAIL, or the check
  // reports a host "reachable" that pushes and accepts cannot authenticate to.
  test('missing token fails the push credential even when the remote reads', async () => {
    const checks = await managedRepositoryHostChecks(cfg('gitlab'), repo, noForgeCli, {});
    expect(checks[0]?.state).toBe('ok');
    const push = checks.find(c => c.what === 'Git push credential');
    expect(push?.state).toBe('fail');
    expect(push && 'reason' in push ? push.reason : '').toContain('GITLAB_TOKEN');
    const api = checks.find(c => c.what.startsWith('GitLab API features'));
    expect(api?.state).toBe('warn');
  });

  test('with the forge CLI and token present, the driver rows are kept, failures as warnings', async () => {
    const withCli: RunCommand = (argv, cwd) =>
      argv[0] === 'gh' ? Promise.resolve({ exitCode: 0, stdout: 'gh 2', stderr: '' }) : defaultRunCommand(argv, cwd);
    const checks = await managedRepositoryHostChecks(cfg('github'), repo, withCli, { GH_TOKEN: 'x' }, async () => [
      { state: 'warn', what: 'Public repo: PR comment sync disabled', reason: 'r' },
      { state: 'fail', what: 'GitHub authentication', reason: 'Run: gh auth login' },
    ]);
    expect(checks.find(c => c.what.startsWith('GitHub API features'))?.state).toBe('ok');
    expect(checks.find(c => c.what === 'Public repo: PR comment sync disabled')?.state).toBe('warn');
    expect(checks.find(c => c.what === 'GitHub authentication')?.state).toBe('warn');
    expect(checks.filter(c => c.state === 'fail')).toEqual([]);
  });

  test('driver rows are not consulted when the forge CLI is missing', async () => {
    let called = false;
    await managedRepositoryHostChecks(cfg('github'), repo, noForgeCli, { GH_TOKEN: 'x' }, async () => { called = true; return []; });
    expect(called).toBe(false);
  });

  test('unreachable remote fails', async () => {
    const broken = join(dir, 'broken');
    await sh(['git', 'init', '-q', broken], dir);
    await sh(['git', 'remote', 'add', 'origin', join(dir, 'nope.git')], broken);
    const checks = await managedRepositoryHostChecks(cfg('github'), broken, noForgeCli, { GH_TOKEN: 'x' });
    expect(checks[0]?.state).toBe('fail');
  });

  test('no remote configured fails', async () => {
    const bare = join(dir, 'noremote');
    await sh(['git', 'init', '-q', bare], dir);
    const checks = await managedRepositoryHostChecks(cfg('github'), bare, noForgeCli, {});
    expect(checks).toEqual([expect.objectContaining({ state: 'fail', what: 'Git remote origin' })]);
  });
});
