import { describe, expect, test } from 'bun:test';
import { buildDockerArgs, buildSupervisorDockerArgs } from '../../src/capture/claude';

const ROOT = '/repo';
const WORKTREE = '/repo/.lazy/worktrees/t1';

function supervisorArgs(): string[] {
  return buildSupervisorDockerArgs({
    binary: 'docker', containerName: 'lazy-task-1', imageName: 'lazy-runner:test', repoRoot: ROOT,
    sandbox: { permission_mode: 'bypass', worktreePath: WORKTREE, sandboxPath: '/sandbox' } as never,
    protocolDir: '/protocol', agentBinaryPath: '/usr/local/bin/lazy-agent', authEnvVars: [], customMountArgs: [],
    gitMountArgs: [], publishArgs: [], taskEnvArgs: [], runArgs: [], wrapperScript: 'echo hi',
  });
}

function oneShotArgs(): string[] {
  return buildDockerArgs({ permission_mode: 'bypass', worktreePath: WORKTREE, sandboxPath: '/sandbox' } as never,
    ['-p', 'x'], '/usr/local/bin/lazy-agent', 'lazy-runner:test', 'docker', ROOT);
}

describe('the project .lazy dir inside a task container', () => {
  // INVARIANT: every task container masks <root>/.lazy with an empty tmpfs and binds only its own worktree back. The read-only repo mount otherwise hands every agent the builder's Claude config (the human's MCP secrets), the proxy audit log and sibling worktrees.
  for (const [name, build] of [['supervisor', supervisorArgs], ['one-shot', oneShotArgs]] as const) {
    test(`${name} container masks .lazy and still binds its worktree`, () => {
      const args = build();
      const mask = args.indexOf('--tmpfs');
      expect(mask).toBeGreaterThan(-1);
      expect(args[mask + 1]).toStartWith('/repo/.lazy:');
      expect(args).toContain(`${WORKTREE}:${WORKTREE}`);
      // No bind mount other than the worktree exposes anything under .lazy.
      const binds = args.flatMap((a, i) => (a === '-v' ? [args[i + 1]!] : []));
      expect(binds.filter(b => b.split(':')[0]!.startsWith('/repo/.lazy'))).toEqual([`${WORKTREE}:${WORKTREE}`]);
    });
  }
});

describe('the .lazy mask on every container that reads the repo', () => {
  // INVARIANT: a member's Shell/Pair/Chat container has the same file view as a turn, .lazy/ hidden included. Pair runs an agent there.
  test('member container masks .lazy and binds its worktree back', async () => {
    const { buildMemberContainerDockerArgs } = await import('../../src/daemon/member-container');
    const wt = '/projects/demo/.lazy/worktrees/some-task';
    const argv = buildMemberContainerDockerArgs({
      binary: 'docker', name: 'm', imageName: 'img', repoRoot: '/projects/demo', taskId: 't', worktreePath: wt,
      homeDir: '/tmp/h', agentBinaryPath: '/a', gitMountArgs: [], adoptPaths: [], readOnlyPaths: [],
      customMountArgs: [], runArgs: [], credentialEnv: [],
    } as never);
    expect(argv[argv.indexOf('--tmpfs') + 1]).toStartWith('/projects/demo/.lazy:');
    expect(argv).toContain(`${wt}:${wt}`);
  });

  // INVARIANT: a read-only one-shot (lazy ask, lazy report) sees the project but never its .lazy/ dir.
  test('a read-only one-shot masks .lazy; one with no repo mount has nothing to mask', async () => {
    const { buildOneshotDockerArgs } = await import('../../src/runner/docker-runner');
    const common = {
      binary: 'docker', containerName: 'c', lazyRoot: '/projects/demo', agentStateHome: '/h/.claude',
      imageName: 'img', authEnvVars: [], harness: 'claude-code', prompt: 'p', model: 'm',
    };
    const ro = buildOneshotDockerArgs({ ...common, repoAccess: 'read-only', lazyDataDir: '/projects/demo/.lazy' });
    expect(ro[ro.indexOf('--tmpfs') + 1]).toStartWith('/projects/demo/.lazy:');
    expect(buildOneshotDockerArgs({ ...common, repoAccess: 'none', lazyDataDir: '/projects/demo/.lazy' })).not.toContain('--tmpfs');
  });

  test('the data dir is read off the worktree path, and nothing is guessed otherwise', async () => {
    const { dataDirOfWorktree } = await import('../../src/capture/lazy-dir-mask');
    expect(dataDirOfWorktree('/r', '/r/.lazy/worktrees/t')).toBe('/r/.lazy');
    expect(dataDirOfWorktree('/r', '/r/.workshop/worktrees/t')).toBe('/r/.workshop');
    expect(dataDirOfWorktree('/r', '/elsewhere/worktrees/t')).toBeNull();
    expect(dataDirOfWorktree('/r', '/r/other/worktrees/t')).toBeNull();
  });
});
