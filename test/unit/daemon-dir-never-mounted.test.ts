/**
 * INVARIANT — THE DAEMON STATE DIR IS NEVER MOUNTED INTO A CONTAINER.
 *
 * The daemon's `/rpc/*` surface authenticates with the single SHARED daemon
 * bearer token (`~/.lazy/daemon/<slug>/token`), and the per-identity MCP token
 * registry (`mcp-tokens.json`) sits in the same directory. Every anti-
 * impersonation guarantee that agent-mcp-token established rests on one fact:
 * an agent inside a container cannot READ that directory. If it could, it would
 * not need to impersonate anyone over `/mcp/:taskId/...` at all — it could lift
 * the shared token and call `/rpc/acceptTask` directly, or copy any other
 * task's (or the builder's) MCP token straight out of the registry, and the
 * whole per-task identity boundary would be worth nothing.
 *
 * `/rpc` auth is deliberately NOT rebuilt to defend against that. This test IS
 * the chosen defense: it derives the forbidden directory structurally from
 * src/daemon/paths.ts and asserts that every container launch path lazy has —
 * docker and podman, agent and builder — constructs a `-v` mount set that
 * exposes none of it.
 *
 * THE ONE PERMITTED EXCEPTION is a container's own daemon MCP config file:
 * a single regular file under `<daemonDir>/mcp/`, bind-mounted read-only by
 * absolute path, containing only that container's own token. A mount of the
 * `mcp/` DIRECTORY, of the daemon dir itself, or of any ancestor of it, is a
 * boundary break — a container that can list `mcp/` can read every other
 * identity's config.
 *
 * Do not relax this test. If a future change needs a new host path inside the
 * daemon dir visible to a container, that is a security review, not a test edit.
 */

import { describe, test, expect } from 'bun:test';
import { join, resolve, relative, isAbsolute } from 'path';
import { getDaemonDir, getMcpTokensPath, getTokenPath, getMcpConfigDir } from '../../src/daemon/paths';
import { buildDockerArgs, buildSupervisorDockerArgs } from '../../src/capture/claude';
import { buildBuilderDockerArgs } from '../../src/runner/docker-runner';
import { DAEMON_MCP_CONFIG_PREFIX } from '../../src/daemon/task-launcher';

/** A fixed project root — nothing here touches the filesystem. */
const PROJECT_ROOT = '/tmp/lazy-invariant-project';
const HOME = '/home/tester';
const CONTAINER_NAME = 'lazy-abc12345';
const BUILDER_NAME = `builder-1700000000000`;

/** Resolve the daemon dir the way production does, for a known HOME. */
function daemonPaths() {
  const previous = process.env.LAZY_DAEMON_BASE_DIR;
  process.env.LAZY_DAEMON_BASE_DIR = join(HOME, '.lazy', 'daemon');
  try {
    return {
      daemonDir: getDaemonDir(PROJECT_ROOT),
      tokenPath: getTokenPath(PROJECT_ROOT),
      registryPath: getMcpTokensPath(PROJECT_ROOT),
      mcpConfigDir: getMcpConfigDir(PROJECT_ROOT),
    };
  } finally {
    if (previous === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = previous;
  }
}

const { daemonDir, tokenPath, registryPath, mcpConfigDir } = daemonPaths();
/** The config a launch path is allowed to mount: one file, this container's own. */
const agentConfigPath = join(mcpConfigDir, `${DAEMON_MCP_CONFIG_PREFIX}${CONTAINER_NAME}.json`);
const builderConfigPath = join(mcpConfigDir, `${DAEMON_MCP_CONFIG_PREFIX}${BUILDER_NAME}.json`);

/** Every host-side mount source in a container argv (`-v src:dst[:opts]`). */
function mountSources(args: string[]): string[] {
  const sources: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-v') continue;
    const spec = args[i + 1];
    if (!spec) continue;
    const source = spec.split(':')[0]!;
    // An anonymous volume is just a container path — no host source at all.
    if (!isAbsolute(source) || !spec.includes(':')) continue;
    sources.push(source);
  }
  return sources;
}

/** True when `child` is inside `parent` (or is `parent`). */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The assertion itself. Throws a descriptive error naming the offending mount.
 * `allowedConfig` is the ONE daemon-dir path this launch may mount: the
 * container's own MCP config file.
 */
function assertNoDaemonDirExposure(args: string[], allowedConfig?: string): void {
  for (const source of mountSources(args)) {
    if (isWithin(source, daemonDir) && resolve(source) !== resolve(daemonDir)) {
      throw new Error(
        `mount source ${source} is an ANCESTOR of the daemon state dir ${daemonDir} — ` +
        `the container could read the shared daemon token and the MCP token registry`,
      );
    }
    if (!isWithin(daemonDir, source)) continue;
    if (allowedConfig && resolve(source) === resolve(allowedConfig)) continue;
    throw new Error(
      `mount source ${source} is inside the daemon state dir ${daemonDir}; ` +
      `the only permitted daemon-dir mount is a container's own MCP config file`,
    );
  }
}

/** Fixtures for the two agent launch paths. */
const sandbox = {
  worktreePath: `${PROJECT_ROOT}/.lazy/worktrees/task-a`,
  sandboxPath: `${PROJECT_ROOT}/.lazy/sandboxes/task-a`,
} as any;

function agentOneShotArgs(binary: string): string[] {
  return buildDockerArgs(
    sandbox,
    ['claude', '-p', 'do a thing'],
    '/usr/local/share/lazy-agent',
    'lazy-agent:latest',
    binary,
    PROJECT_ROOT,
    [{ key: 'ANTHROPIC_API_KEY', value: 'x' }],
  );
}

function supervisorArgs(binary: string, daemonConfigPath?: string): string[] {
  return buildSupervisorDockerArgs({
    binary,
    containerName: CONTAINER_NAME,
    imageName: 'lazy-agent:latest',
    repoRoot: PROJECT_ROOT,
    sandbox,
    protocolDir: `${PROJECT_ROOT}/.lazy/protocol/task-a`,
    agentBinaryPath: '/usr/local/share/lazy-agent',
    authEnvVars: [{ key: 'ANTHROPIC_API_KEY', value: 'x' }],
    customMountArgs: [],
    gitMountArgs: [
      '-v', `${PROJECT_ROOT}/.git:${PROJECT_ROOT}/.git:ro`,
      '-v', `${PROJECT_ROOT}/.git/objects:${PROJECT_ROOT}/.git/objects`,
      '-v', `${PROJECT_ROOT}/.git/worktrees/task-a:${PROJECT_ROOT}/.git/worktrees/task-a`,
    ],
    wrapperScript: 'sleep 1',
    daemonConfigPath,
  });
}

function builderArgs(binary: string, daemonConfigPath?: string): string[] {
  return buildBuilderDockerArgs({
    binary,
    builderId: 'a1b2c3d4',
    lazyRoot: PROJECT_ROOT,
    dataDir: `${PROJECT_ROOT}/.lazy`,
    // Builder scratch dir — outside the repo AND outside the daemon dir. This
    // test only cares that it never exposes daemon state; the scratch mount's
    // own contract lives in test/unit/builder-scratch-mount.test.ts.
    scratchDir: `${HOME}/.lazy/scratch/lazy-invariant-project-deadbeef`,
    containerConfigFile: `${PROJECT_ROOT}/.lazy/tmp/builder-container-a1b2c3d4.json`,
    agentBinaryPath: '/usr/local/share/lazy-agent',
    home: HOME,
    projectsHostDir: `${PROJECT_ROOT}/.lazy/builder-projects/a1b2c3d4`,
    neutralCredentialStore: `${PROJECT_ROOT}/.lazy/tmp/creds-a1b2c3d4.json`,
    mergedConfigFile: `${PROJECT_ROOT}/.lazy/builder-claude.json`,
    authEnvVars: [{ key: 'ANTHROPIC_API_KEY', value: 'x' }],
    imageName: 'lazy-agent:latest',
    promptFile: `${PROJECT_ROOT}/.lazy/tmp/builder-prompt-1.txt`,
    daemonConfigPath,
    claudeExtraArgs: [],
    debug: false,
  });
}

describe('no container launch path mounts the daemon state dir', () => {
  for (const binary of ['docker', 'podman']) {
    test(`${binary}: one-shot agent run`, () => {
      assertNoDaemonDirExposure(agentOneShotArgs(binary));
    });

    test(`${binary}: agent supervisor, with and without a daemon MCP config`, () => {
      assertNoDaemonDirExposure(supervisorArgs(binary));
      assertNoDaemonDirExposure(supervisorArgs(binary, agentConfigPath), agentConfigPath);
    });

    test(`${binary}: interactive builder, with and without a daemon MCP config`, () => {
      assertNoDaemonDirExposure(builderArgs(binary));
      assertNoDaemonDirExposure(builderArgs(binary, builderConfigPath), builderConfigPath);
    });

    // INVARIANT: the shared daemon token and the MCP token registry are the two
    // files whose exposure would collapse the whole identity boundary. Named
    // explicitly so a regression reads as what it is.
    test(`${binary}: neither the shared token file nor the MCP token registry is ever a mount source`, () => {
      const everyArgv = [
        agentOneShotArgs(binary),
        supervisorArgs(binary, agentConfigPath),
        builderArgs(binary, builderConfigPath),
      ];
      for (const argv of everyArgv) {
        for (const source of mountSources(argv)) {
          expect(resolve(source)).not.toBe(resolve(tokenPath));
          expect(resolve(source)).not.toBe(resolve(registryPath));
          expect(resolve(source)).not.toBe(resolve(mcpConfigDir));
          expect(resolve(source)).not.toBe(resolve(daemonDir));
        }
      }
    });
  }

  // INVARIANT: the permitted exception is exactly ONE FILE, mounted read-only.
  // A container that could write its config could point itself at another
  // daemon; a container that could list `mcp/` could read every other identity.
  test('the daemon MCP config is mounted as a single read-only file', () => {
    const cases: Array<[string[], string]> = [
      [supervisorArgs('docker', agentConfigPath), agentConfigPath],
      [builderArgs('docker', builderConfigPath), builderConfigPath],
    ];
    for (const [argv, config] of cases) {
      const specIndex = argv.findIndex(a => a.startsWith(`${config}:`));
      expect(specIndex).toBeGreaterThan(0);
      // Preceded by -v (a mount, not some other flag's value) and read-only.
      expect(argv[specIndex - 1]).toBe('-v');
      expect(argv[specIndex]).toBe(`${config}:${config}:ro`);
    }
  });

  // The assertion above must be able to FAIL — a green suite that cannot detect
  // the very thing it guards is worse than no suite. These are the four shapes a
  // real regression would take.
  test('the assertion detects each way the daemon dir could leak', () => {
    const leaks: Array<[string, string]> = [
      ['the daemon dir itself', daemonDir],
      ['the shared token file', tokenPath],
      ['the MCP token registry', registryPath],
      ['the MCP config directory', mcpConfigDir],
      ['an ancestor of the daemon dir', HOME],
      ["another identity's config", join(mcpConfigDir, `${DAEMON_MCP_CONFIG_PREFIX}lazy-other.json`)],
    ];
    for (const [what, source] of leaks) {
      const argv = [...supervisorArgs('docker', agentConfigPath), '-v', `${source}:${source}:ro`];
      let threw = false;
      try {
        assertNoDaemonDirExposure(argv, agentConfigPath);
      } catch {
        threw = true;
      }
      // Named in the assertion so a failure says WHICH leak went undetected.
      expect({ leak: what, detected: threw }).toEqual({ leak: what, detected: true });
    }
  });
});
