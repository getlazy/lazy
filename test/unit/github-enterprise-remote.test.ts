/**
 * GitHub Enterprise Server remotes must resolve to an owner/repo, and every
 * `gh` invocation derived from that must reach the GHES host rather than
 * github.com.
 *
 * The old parser hardcoded `github.com` in two regexes, so a GHES remote
 * yielded null: `--repo` was dropped from every gh call and lazy silently
 * relied on gh's own repo detection (which does work) — except for
 * isTargetBranchProtected, which needs the identifier and always returned
 * "not protected".
 */

import { describe, test, expect } from 'bun:test';
import { GitHubDriver, parseGitHubRemote } from '../../src/remote/github-driver';
import { remoteUrlPath } from '../../src/remote/remote-url';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import type { ResolvedConfig } from '../../src/config/types';
import type { DriverDeps, GhResult } from '../../src/remote/github-driver';
import type { GitResult } from '../../src/utils/git';
import type { Task } from '../../src/types';

const config: ResolvedConfig = {
  ...DEFAULT_CONFIG,
  remote: { ...DEFAULT_CONFIG.remote, driver: 'github', git_remote: 'origin' },
};

const DOT_COM = 'git@github.com:getlazy/lazy-dev.git';
const GHES = 'git@github.mycorp.com:team/app.git';

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'test-task-id',
    code: 'test-task',
    goal: 'Test goal',
    prompt: 'Test prompt',
    type: 'task',
    status: 'blocked',
    priority: 'normal',
    created_at: 0,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: {},
    pending_sync: 0,
    runner_type: null,
    tags: [],
    ...overrides,
  };
}

/**
 * A driver whose `git remote get-url` answers with `remoteUrl` and whose gh
 * calls are recorded. `gh` responses come from `ghHandler`, defaulting to a
 * benign empty-ish success.
 */
function makeDriver(remoteUrl: string, ghHandler?: (args: string[]) => GhResult) {
  const calls: string[][] = [];
  const deps: DriverDeps = {
    runGh: async (args) => {
      calls.push(args);
      return ghHandler?.(args) ?? { stdout: '', stderr: '', exitCode: 0 };
    },
    runGit: async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: remoteUrl, stderr: '', exitCode: 0 } as GitResult;
      }
      return { stdout: '', stderr: 'unexpected git call', exitCode: 1 } as GitResult;
    },
  };
  return { driver: new GitHubDriver(config, deps), calls };
}

describe('remoteUrlPath', () => {
  // parseGitHubRemote is built on this helper, added to src/remote/remote-url.ts
  // alongside the existing host extractors. Covered here rather than in
  // remote-url-host.test.ts because that suite belongs to the task that
  // introduced the module.
  test('returns the repo path for every remote shape, host-agnostically', () => {
    expect(remoteUrlPath('git@github.com:getlazy/lazy.git')).toBe('getlazy/lazy');
    expect(remoteUrlPath('git@github.mycorp.com:team/app.git')).toBe('team/app');
    expect(remoteUrlPath('https://github.com/getlazy/lazy.git')).toBe('getlazy/lazy');
    expect(remoteUrlPath('https://github.com/getlazy/lazy')).toBe('getlazy/lazy');
    expect(remoteUrlPath('ssh://git@ghe.example/team/app.git')).toBe('team/app');
    expect(remoteUrlPath('https://x-access-token:ghp_secret@github.com/o/r.git')).toBe('o/r');
    // Nested paths survive: GitLab subgroups are not this driver's concern, but
    // the helper is shared and must not flatten them.
    expect(remoteUrlPath('https://gitlab.com/group/sub/app.git')).toBe('group/sub/app');
  });

  test('trims trailing slashes and returns null when there is no path or host', () => {
    expect(remoteUrlPath('https://github.com/o/r/')).toBe('o/r');
    expect(remoteUrlPath('https://github.com/')).toBeNull();
    expect(remoteUrlPath('/srv/git/repo.git')).toBeNull();
    expect(remoteUrlPath('')).toBeNull();
  });
});

describe('parseGitHubRemote', () => {
  test('parses github.com in every remote shape', () => {
    for (const url of [
      'git@github.com:getlazy/lazy-dev.git',
      'git@github.com:getlazy/lazy-dev',
      'https://github.com/getlazy/lazy-dev.git',
      'https://github.com/getlazy/lazy-dev',
      'ssh://git@github.com/getlazy/lazy-dev.git',
      'https://x-access-token:ghp_secret@github.com/getlazy/lazy-dev.git',
    ]) {
      expect(parseGitHubRemote(url)).toEqual({
        host: 'github.com',
        ownerRepo: 'getlazy/lazy-dev',
        isDotCom: true,
      });
    }
  });

  test('parses a GitHub Enterprise Server host the same way', () => {
    for (const url of [
      'git@github.mycorp.com:team/app.git',
      'https://github.mycorp.com/team/app.git',
      'ssh://git@github.mycorp.com/team/app',
      'https://GitHub.MyCorp.com/team/app.git',
    ]) {
      expect(parseGitHubRemote(url)).toEqual({
        host: 'github.mycorp.com',
        ownerRepo: 'team/app',
        isDotCom: false,
      });
    }
    // A GHES install need not mention "github" at all.
    expect(parseGitHubRemote('https://git.internal.example/team/app.git')).toEqual({
      host: 'git.internal.example',
      ownerRepo: 'team/app',
      isDotCom: false,
    });
  });

  test('returns null when there is no host or no owner/repo pair', () => {
    expect(parseGitHubRemote('/srv/git/repo.git')).toBeNull();
    expect(parseGitHubRemote('')).toBeNull();
    // GitHub repos are exactly owner/repo — never nested, never bare.
    expect(parseGitHubRemote('https://github.com/getlazy')).toBeNull();
    expect(parseGitHubRemote('https://github.com/a/b/c')).toBeNull();
  });

  test('a subdomain of github.com is still github.com', () => {
    expect(parseGitHubRemote('https://www.github.com/o/r.git')?.isDotCom).toBe(true);
    // ...but a lookalike is not, and `notgithub.com` is simply another host.
    expect(parseGitHubRemote('https://notgithub.com/o/r.git')?.isDotCom).toBe(false);
  });
});

describe('the --repo identifier passed to gh', () => {
  // gh's --repo takes `[HOST/]OWNER/REPO` and resolves a bare owner/repo
  // against its DEFAULT host. A GHES repo must therefore carry its hostname.
  const runList = (calls: string[][]) =>
    calls.find(a => a[0] === 'run' && a[1] === 'list');

  test('github.com keeps the bare owner/repo it has always had', async () => {
    const { driver, calls } = makeDriver(DOT_COM, () => ({ stdout: '[]', stderr: '', exitCode: 0 }));
    await driver.getFailedCIJobs(makeTask(), 'lazy/branch');
    expect(runList(calls)).toContain('--repo');
    expect(runList(calls)).toContain('getlazy/lazy-dev');
  });

  test('a GHES remote is host-qualified so gh does not target github.com', async () => {
    const { driver, calls } = makeDriver(GHES, () => ({ stdout: '[]', stderr: '', exitCode: 0 }));
    await driver.getFailedCIJobs(makeTask(), 'lazy/branch');
    expect(runList(calls)).toContain('--repo');
    expect(runList(calls)).toContain('github.mycorp.com/team/app');
  });
});

describe('gh api host pinning', () => {
  // INVARIANT: `gh api` does NOT derive its host from the repository — it sends
  // every request to gh's default host (github.com unless GH_HOST or a single
  // configured host says otherwise). Only --hostname overrides that, so a GHES
  // remote must pass it or the request silently goes to github.com.
  const apiCalls = (calls: string[][]) => calls.filter(a => a[0] === 'api');

  test('github.com passes no --hostname, exactly as before', async () => {
    const { driver, calls } = makeDriver(DOT_COM, () => ({ stdout: '1', stderr: '', exitCode: 0 }));
    await driver.hasExternalApproval(makeTask({ metadata: { github_remote_ref_id: '7' } }));
    const api = apiCalls(calls);
    expect(api.length).toBeGreaterThan(0);
    for (const call of api) expect(call).not.toContain('--hostname');
    expect(api[0]).toEqual(['api', 'user', '--jq', '.login']);
  });

  test('a GHES remote pins --hostname on every gh api call', async () => {
    const { driver, calls } = makeDriver(GHES, () => ({ stdout: '1', stderr: '', exitCode: 0 }));
    await driver.hasExternalApproval(makeTask({ metadata: { github_remote_ref_id: '7' } }));
    const api = apiCalls(calls);
    expect(api.length).toBeGreaterThan(0);
    for (const call of api) {
      expect(call.slice(0, 3)).toEqual(['api', '--hostname', 'github.mycorp.com']);
    }
  });

  test('branch protection asks the GHES host about a bare owner/repo path', async () => {
    // The host travels as --hostname; putting it in the path would produce
    // `repos/github.mycorp.com/team/app/branches/...`, which is not an endpoint.
    const { driver, calls } = makeDriver(GHES);
    await driver.isTargetBranchProtected('main');
    const call = calls.find(a => a[0] === 'api');
    expect(call).toEqual([
      'api',
      '--hostname', 'github.mycorp.com',
      'repos/team/app/branches/main/protection',
      '--silent',
    ]);
  });

  test('branch protection on github.com is unchanged', async () => {
    const { driver, calls } = makeDriver(DOT_COM);
    await driver.isTargetBranchProtected('main');
    expect(calls.find(a => a[0] === 'api')).toEqual([
      'api',
      'repos/getlazy/lazy-dev/branches/main/protection',
      '--silent',
    ]);
  });
});

describe('canImport', () => {
  test('accepts PR URLs on github.com and on a GHES host', () => {
    const { driver } = makeDriver(DOT_COM);
    expect(driver.canImport('https://github.com/getlazy/lazy-dev/pull/12')).toBe(true);
    expect(driver.canImport('https://github.mycorp.com/team/app/pull/12')).toBe(true);
    expect(driver.canImport('http://github.internal/team/app/pull/3')).toBe(true);
  });

  test('rejects non-PR URLs and lookalike hosts', () => {
    const { driver } = makeDriver(DOT_COM);
    expect(driver.canImport('https://github.com/getlazy/lazy-dev/issues/12')).toBe(false);
    expect(driver.canImport('https://gitlab.com/team/app/-/merge_requests/12')).toBe(false);
    // Host, not substring: a github.com path segment elsewhere is not GitHub.
    expect(driver.canImport('https://evil.com/github.com/o/r/pull/1')).toBe(false);
  });
});

/**
 * `gh` keeps a separate login per host, so `gh auth status` exiting 0 only
 * proves gh is logged into SOME host. doctor used to report "GitHub
 * authentication ok" for a host nobody had ever run `gh auth login --hostname`
 * against, and the real failure surfaced much later as an opaque gh error
 * during PR creation.
 *
 * It fails in both directions: an Enterprise remote passing on a github.com
 * login (the reported bug), and a github.com remote passing on an
 * Enterprise-only login (its mirror). Every resolvable host is now pinned.
 */
describe('checkHealth authenticates against the remote host', () => {
  /**
   * A driver whose checkHealth passes every step by default, with gh responses
   * overridable per-call. `remoteUrl = null` simulates a repo with no remote.
   */
  function healthDriver(remoteUrl: string | null, ghHandler?: (args: string[]) => GhResult | undefined) {
    const calls: string[][] = [];
    const deps: DriverDeps = {
      runGh: async (args) => {
        calls.push(args);
        const custom = ghHandler?.(args);
        if (custom) return custom;
        if (args[0] === '--version') return { stdout: 'gh version 2.0.0', stderr: '', exitCode: 0 };
        if (args[0] === 'auth' && args[1] === 'status') return { stdout: 'Token scopes: repo', stderr: '', exitCode: 0 };
        if (args[0] === 'repo' && args[1] === 'view') return { stdout: JSON.stringify({ isPrivate: true }), stderr: '', exitCode: 0 };
        return { stdout: '', stderr: 'unexpected gh call', exitCode: 1 };
      },
      runGit: async (args) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return remoteUrl === null
            ? { stdout: '', stderr: 'error: No such remote', exitCode: 2 } as GitResult
            : { stdout: remoteUrl, stderr: '', exitCode: 0 } as GitResult;
        }
        return { stdout: '', stderr: 'unexpected git call', exitCode: 1 } as GitResult;
      },
    };
    return { driver: new GitHubDriver(config, deps), calls };
  }

  const authCall = (calls: string[][]) => calls.find(a => a[0] === 'auth' && a[1] === 'status');

  test('github.com is verified against github.com, and reads exactly as it always has', async () => {
    // INVARIANT: dot-com OUTPUT is unchanged while dot-com VERIFICATION is
    // host-scoped. The dot-com path is the overwhelmingly common one, so the
    // label carries no host suffix and the failure reason stays the terse
    // `Run: gh auth login` — the suffix and the longer --hostname remedy are
    // reserved for Enterprise. What changed is the argv, and with it the
    // truthfulness of the check: it no longer passes on a login to some other
    // host. Assert both halves; asserting the bare argv alone (as this test
    // first did) would encode the mirrored bug rather than guard anything.
    const { driver, calls } = healthDriver(DOT_COM);
    const checks = await driver.checkHealth();

    expect(authCall(calls)).toEqual(['auth', 'status', '--hostname', 'github.com']);
    expect(checks.map(c => c.what)).toEqual([
      'gh CLI installed',
      'GitHub authentication',
      'Token scopes',
      'Git remote origin',
      'Private repo: PR comment sync enabled',
    ]);
    expect(checks.every(c => c.state === 'ok')).toBe(true);
  });

  test('a github.com remote fails when gh is logged into an Enterprise host only', async () => {
    // The mirror of the reported bug, and the regression this pinning exists to
    // prevent: bare `gh auth status` exits 0 here (github.mycorp.com IS logged
    // in), so doctor used to go green on a dot-com remote gh cannot push to.
    // The wording stays terse — a github.com remote needs no host suffix and no
    // `--hostname` remedy — and no wrong-remote warning is emitted, because a
    // github.com remote is unambiguously GitHub.
    const { driver } = healthDriver(DOT_COM, (args) => {
      if (args[0] === 'auth' && args[1] === 'status') {
        return args.includes('--hostname')
          ? { stdout: '', stderr: 'You are not logged into any GitHub hosts on github.com', exitCode: 1 }
          : { stdout: 'github.mycorp.com\n  ✓ Logged in', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const checks = await driver.checkHealth();

    expect(checks.map(c => c.what)).toEqual(['gh CLI installed', 'GitHub authentication']);
    expect(checks[1]).toEqual({
      state: 'fail',
      what: 'GitHub authentication',
      reason: 'Run: gh auth login',
    });
  });

  test('a github.com subdomain is pinned as github.com, not verbatim', async () => {
    // `ssh.github.com` is a real GitHub endpoint (the port-443 SSH workaround),
    // and `gh` knows dot-com only as `github.com`. Pinning the literal subdomain
    // would fail a perfectly valid login.
    const { driver, calls } = healthDriver('git@ssh.github.com:getlazy/lazy-dev.git');
    const checks = await driver.checkHealth();

    expect(authCall(calls)).toEqual(['auth', 'status', '--hostname', 'github.com']);
    expect(checks.find(c => c.what.startsWith('GitHub authentication'))).toEqual({
      state: 'ok',
      what: 'GitHub authentication',
    });
  });

  test('a remote with no host at all falls back to the unscoped auth check', async () => {
    // A local path (`/srv/git/repo.git`) parses to no host, so there is nothing
    // to pin to. Same fallback as having no remote configured.
    const { driver, calls } = healthDriver('/srv/git/repo.git');
    const checks = await driver.checkHealth();

    expect(authCall(calls)).toEqual(['auth', 'status']);
    expect(checks.find(c => c.what.startsWith('GitHub authentication'))).toEqual({
      state: 'ok',
      what: 'GitHub authentication',
    });
  });

  test('a GHES remote pins the auth check to its own host', async () => {
    const { driver, calls } = healthDriver(GHES);
    const checks = await driver.checkHealth();

    expect(authCall(calls)).toEqual(['auth', 'status', '--hostname', 'github.mycorp.com']);
    const auth = checks.find(c => c.what.startsWith('GitHub authentication'));
    expect(auth).toEqual({ state: 'ok', what: 'GitHub authentication (github.mycorp.com)' });
  });

  test('a GHES host with no gh login fails by name, even though github.com is logged in', async () => {
    // The bug: bare `gh auth status` exits 0 here (github.com IS logged in), so
    // the check went green on a host gh cannot reach.
    const { driver } = healthDriver(GHES, (args) => {
      if (args[0] === 'auth' && args[1] === 'status') {
        return args.includes('--hostname')
          ? { stdout: '', stderr: 'You are not logged into any GitHub hosts on github.mycorp.com', exitCode: 1 }
          : { stdout: 'github.com\n  ✓ Logged in', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const checks = await driver.checkHealth();

    const auth = checks.find(c => c.what.startsWith('GitHub authentication'));
    expect(auth!.state).toBe('fail');
    expect(auth!.what).toBe('GitHub authentication (github.mycorp.com)');
    expect(auth!.reason).toContain('gh auth login --hostname github.mycorp.com');
    expect(auth!.reason).toContain("remote 'origin'");
  });

  test('token scopes are read from the GHES token, not from the github.com one', async () => {
    // Host-scoped `gh auth status` output is what step 3 parses, so a broad
    // github.com token no longer taints a minimal Enterprise token.
    const { driver } = healthDriver(GHES, (args) => {
      if (args[0] === 'auth' && args[1] === 'status') {
        return args.includes('--hostname')
          ? { stdout: 'github.mycorp.com\n  - Token scopes: repo', stderr: '', exitCode: 0 }
          : { stdout: 'github.com\n  - Token scopes: repo, admin:org', stderr: '', exitCode: 0 };
      }
      return undefined;
    });
    const checks = await driver.checkHealth();

    expect(checks.find(c => c.what === 'Token scopes')).toEqual({ state: 'ok', what: 'Token scopes' });
  });

  test('a non-GitHub host reports both the failed login and the wrong-remote warning', async () => {
    // Enterprise hostnames are arbitrary, so "not github.com" is the test — which
    // also catches driver = "github" pointed at something that is not GitHub.
    // That diagnosis would otherwise be unreachable behind the auth failure.
    const { driver } = healthDriver('git@gitlab.mycorp.com:team/app.git', (args) => {
      if (args[0] === 'auth' && args[1] === 'status') {
        return { stdout: '', stderr: 'not logged in', exitCode: 1 };
      }
      return undefined;
    });
    const checks = await driver.checkHealth();

    expect(checks.map(c => c.what)).toEqual([
      'gh CLI installed',
      'GitHub authentication (gitlab.mycorp.com)',
      'Git remote origin',
    ]);
    expect(checks[2]).toEqual({
      state: 'warn',
      what: 'Git remote origin',
      reason: 'Remote points to git@gitlab.mycorp.com:team/app.git, which does not appear to be GitHub',
    });
  });

  test('no remote falls back to the unscoped auth check', async () => {
    // Nothing to pin the check to — behave exactly as before and let the
    // "no remote configured" check carry the diagnosis.
    const { driver, calls } = healthDriver(null);
    const checks = await driver.checkHealth();

    expect(authCall(calls)).toEqual(['auth', 'status']);
    expect(checks.map(c => c.what)).toEqual([
      'gh CLI installed',
      'GitHub authentication',
      'Token scopes',
      'Git remote origin',
    ]);
    expect(checks[3].state).toBe('fail');
  });
});
