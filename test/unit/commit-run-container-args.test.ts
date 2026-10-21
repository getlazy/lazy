/**
 * A commit run's container (src/daemon/commit-run-container.ts).
 *
 * INVARIANT: a run's container holds NO agent credential and nothing of lazy's
 * agent machinery — no Claude/Anthropic token or base URL, no other agent's
 * key, no daemon MCP config or token, no protocol dir, no lazy-agent binary, no
 * agent home. It runs code from any pushed branch, and the feature's promise
 * is that such code has no route to anybody's model credential; so each
 * property is asserted on the argv itself.
 *
 * INVARIANT: it is never named `lazy-…` — the sweeps that treat a `^lazy-`
 * container as a task supervisor must not touch it — and it carries the
 * labels its own sweep finds it by.
 */

import { describe, test, expect } from 'bun:test';
import { buildRunContainerDockerArgs, removeRunContainers, RUN_NETWORK_SPEC, type RunContainerArgsParams } from '../../src/daemon/commit-run-container';
import { isolatedNetworkCreateArgs } from '../../src/daemon/member-container';
import { AGENT_KEY_ENV } from '../../src/agent/credentials';
import { RUN_CONTAINER_LABEL, runContainerName } from '../../src/run/identity';
import { PROJECT_LABEL } from '../../src/runner/docker-runner';

const ROOT = '/projects/demo';
const WORKTREE = '/projects/demo/.lazy/worktrees/lazy-run-main';
const PARAMS: RunContainerArgsParams = {
  binary: 'docker',
  name: runContainerName(ROOT, 'main'),
  imageName: 'lazy-runner:test',
  repoRoot: ROOT,
  runId: 'run-uuid-1',
  worktreePath: WORKTREE,
  network: RUN_NETWORK_SPEC.name,
  gitMountArgs: [
    '-v', '/projects/demo/.git:/projects/demo/.git:ro',
    '-v', '/projects/demo/.git/objects:/projects/demo/.git/objects',
    '-v', '/projects/demo/.git/worktrees/lazy-run-main:/projects/demo/.git/worktrees/lazy-run-main',
    '-v', '/copies/dotgit:/projects/demo/.lazy/worktrees/lazy-run-main/.git:ro',
  ],
  adoptPaths: [WORKTREE, '/projects/demo/.git/worktrees/lazy-run-main', '/projects/demo/.git/objects'],
  readOnlyPaths: [`${WORKTREE}/.git`],
  publishArgs: ['-p', '127.0.0.1:0:3000', '-p', '127.0.0.1:0:5173'],
  customMountArgs: [],
  runArgs: [],
  envArgs: ['--env-file', '/daemon/task-env-launch/x.env', '-e', 'LAZY_TASK_ENV_KEYS=DATABASE_URL'],
  gitConfigEnv: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: `${WORKTREE}/.lazy-task-sandbox/task-files.exclude` },
};

function envKeys(argv: string[]): string[] {
  const keys: string[] = [];
  argv.forEach((a, i) => { if (a === '-e') keys.push((argv[i + 1] ?? '').split('=')[0]!); });
  return keys;
}

function mountTargets(argv: string[]): string[] {
  const targets: string[] = [];
  argv.forEach((a, i) => { if (a === '-v') targets.push((argv[i + 1] ?? '').split(':')[1] ?? ''); });
  return targets;
}

describe('the run container argv', () => {
  const argv = buildRunContainerDockerArgs(PARAMS);
  const text = argv.join('\n');

  // INVARIANT: no credential of any agent, and no route to the proxy that
  // spends one. These are exactly what a task container carries and a run's
  // must not.
  test('carries no agent credential and no proxy base URL', () => {
    const forbidden = [
      'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
      'LAZY_DAEMON_CONFIG', 'LAZY_MCP_TOKEN', ...Object.values(AGENT_KEY_ENV),
    ];
    for (const key of forbidden) {
      expect(envKeys(argv)).not.toContain(key);
      expect(text).not.toContain(`${key}=`);
    }
  });

  // INVARIANT: none of the agent machinery is mounted — no protocol dir (the
  // supervisor's command channel), no lazy-agent, no agent home, no daemon MCP
  // config.
  test('mounts no protocol dir, no lazy-agent, no agent home, no MCP config', () => {
    const targets = mountTargets(argv);
    expect(targets.some((t) => t.startsWith('/lazy-protocol'))).toBe(false);
    expect(targets).not.toContain('/usr/local/bin/lazy-agent');
    expect(targets.some((t) => t.startsWith('/home/user/.claude'))).toBe(false);
    expect(text).not.toContain('mcp-config');
    expect(text).not.toContain('--add-host');
  });

  // INVARIANT: never `lazy-` named; found by its own label and the project's.
  test('is named outside the supervisor sweep prefix and carries its labels', () => {
    const name = argv[argv.indexOf('--name') + 1]!;
    expect(name.startsWith('lazy-')).toBe(false);
    expect(name.startsWith('lazyrun-main-')).toBe(true);
    expect(argv).toContain(`${PROJECT_LABEL}=${ROOT}`);
    expect(argv).toContain(`${RUN_CONTAINER_LABEL}=run-uuid-1`);
  });

  // INVARIANT: its own network, with inter-container traffic off — no turn
  // reaches a run's ports and no run a turn's.
  test('joins its own network, created with inter-container traffic off', () => {
    expect(argv[argv.indexOf('--network') + 1]).toBe('lazy-runs');
    const create = isolatedNetworkCreateArgs('docker', RUN_NETWORK_SPEC);
    expect(create).toContain('com.docker.network.bridge.enable_icc=false');
    expect(create).toContain('lazy.run-network=1');
    expect(create.at(-1)).toBe('lazy-runs');
    expect(buildRunContainerDockerArgs({ ...PARAMS, network: null })).not.toContain('--network');
  });

  test('publishes the root config ports and mounts the checkout over the read-only repo', () => {
    expect(text).toContain('127.0.0.1:0:3000');
    expect(text).toContain('127.0.0.1:0:5173');
    expect(argv).toContain(`${ROOT}:${ROOT}:ro`);
    expect(argv).toContain(`${WORKTREE}:${WORKTREE}`);
    // .lazy/ masked, as in every container lazy runs on a checkout.
    expect(argv).toContain('--tmpfs');
    expect(argv[argv.indexOf('-w') + 1]).toBe(WORKTREE);
  });

  test("passes the run's own environment and the delivered-files exclude, and idles", () => {
    expect(argv).toContain('--env-file');
    expect(envKeys(argv)).toContain('GIT_CONFIG_KEY_0');
    expect(argv).toContain('GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new');
    expect(argv.at(-1)).toContain('exec sleep infinity');
    // The image comes right before the command.
    expect(argv[argv.indexOf('lazy-runner:test') + 1]).toBe('sh');
  });
});

describe('the run container sweep', () => {
  // INVARIANT: the sweep removes only run containers — a name that is not
  // `lazyrun-` (a task supervisor, a member terminal) is never touched, even
  // if a listing returned it.
  test('removes run containers only', async () => {
    const removed: string[] = [];
    const out = await removeRunContainers(ROOT, 'docker', {
      list: async () => 'lazyrun-main-0123abcd\nlazy-some-task\nlazymember-abc-123\nlazyrun-sha-1a2b3c4d5e6f-0123abcd\n',
      remove: async (_b, name) => { removed.push(name); },
    });
    expect(out.removed).toBe(2);
    expect(removed.sort()).toEqual(['lazyrun-main-0123abcd', 'lazyrun-sha-1a2b3c4d5e6f-0123abcd']);
  });
});
