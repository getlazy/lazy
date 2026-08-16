/**
 * The builder's mounted `~/.claude.json` must be per-launch.
 *
 * THE INCIDENT this suite reproduces: the builder came up with its lazy MCP
 * server disconnected after every `lazy upgrade`. Its `~/.claude.json` named
 * `.../mcp/daemon-mcp-builder-1785961697275.json` while the file actually
 * bind-mounted into that container was `daemon-mcp-builder-1785961697122.json`
 * — two tokens minted 153 ms apart.
 *
 * MECHANISM: `mcpServers.lazy.args` carries a PER-LAUNCH `--daemon-config`
 * path, but the file holding it was stable per PROJECT and bind-mounted
 * read-write into every builder container of that project. A single-file bind
 * mount pins the inode, so a second launch rewriting that file in place is
 * immediately visible inside the first launch's container — which has a
 * different token file mounted. `lazy upgrade` stops every builder of a project
 * at once and each host wrapper relaunches off the same daemon-healthy poll,
 * milliseconds apart, so the collision is the normal case there rather than an
 * unlucky one.
 *
 * INVARIANT: preparing launch B must not change what launch A's container
 * reads. Anything else means a live builder can be pointed at a credential it
 * does not have and silently lose every lazy_* tool.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  builderClaudeConfigPath,
  builderClaudeSessionConfigPath,
  writeBuilderSessionClaudeConfig,
  persistBuilderSessionClaudeConfig,
} from '../../src/builder/claude-home';
import {
  assertDaemonMcpConfigMounted,
  preflightBuilderMcpConfig,
  daemonConfigPathFromClaudeConfig,
} from '../../src/builder/mcp-config-check';
import { buildBuilderDockerArgs } from '../../src/runner/docker-runner';
import { buildSupervisorDockerArgs } from '../../src/capture/claude';

describe('builder MCP config / mount agreement', () => {
  let dir: string;
  let dataDir: string;
  let tmpFiles: string;
  let hostConfig: string;
  const warnings: string[] = [];
  const onWarn = (m: string) => { warnings.push(m); };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-builder-mcp-'));
    dataDir = join(dir, '.lazy');
    tmpFiles = join(dataDir, 'tmp');
    await mkdir(tmpFiles, { recursive: true });
    hostConfig = join(dir, 'host-claude.json');
    await writeFile(hostConfig, JSON.stringify({ theme: 'dark' }));
    warnings.length = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Prepare one builder launch exactly as docker-runner does. */
  async function prepareLaunch(builderId: string, daemonConfigPath: string): Promise<string> {
    return writeBuilderSessionClaudeConfig({
      sessionPath: builderClaudeSessionConfigPath(tmpFiles, builderId),
      persistedPath: builderClaudeConfigPath(dataDir),
      hostConfigPath: hostConfig,
      mcpArgs: ['mcp', '--daemon-config', daemonConfigPath, '--worktree', dir],
      onWarn,
    });
  }

  // THE REPRODUCTION. Two builder launches of the same project, 153 ms apart —
  // the upgrade-relaunch shape. Before the fix both wrote
  // `<data>/builder-claude-config.json`, so this assertion failed with A's
  // container reading B's `--daemon-config` path.
  test('a second launch does not repoint the first launch\'s mounted config', async () => {
    const tokenA = join(dir, 'mcp', 'daemon-mcp-builder-1785961697122.json');
    const tokenB = join(dir, 'mcp', 'daemon-mcp-builder-1785961697275.json');

    const mountA = await prepareLaunch('aaaaaaaa', tokenA);
    const mountB = await prepareLaunch('bbbbbbbb', tokenB);

    expect(mountA).not.toBe(mountB);
    expect(daemonConfigPathFromClaudeConfig(JSON.parse(await readFile(mountA, 'utf-8')))).toBe(tokenA);
    expect(daemonConfigPathFromClaudeConfig(JSON.parse(await readFile(mountB, 'utf-8')))).toBe(tokenB);
  });

  // The mounted copy must not BE the persisted state file, or the point above is
  // reintroduced the moment someone reuses the persisted path as a mount source.
  test('the mounted copy is never the persisted state file', () => {
    expect(builderClaudeSessionConfigPath(tmpFiles, 'aaaaaaaa'))
      .not.toBe(builderClaudeConfigPath(dataDir));
  });

  // INVARIANT: the persisted file exists so onboarding/folder-trust/model
  // choices survive a relaunch. Making the mount per-launch must not cost that.
  test('state Claude Code wrote in the container is folded back into the persisted file', async () => {
    const mount = await prepareLaunch('aaaaaaaa', join(dir, 'mcp', 'a.json'));
    // Claude Code writing back inside the container.
    const inContainer = JSON.parse(await readFile(mount, 'utf-8'));
    inContainer.hasCompletedOnboarding = true;
    inContainer.theme = 'light';
    await writeFile(mount, JSON.stringify(inContainer));

    expect(await persistBuilderSessionClaudeConfig({
      sessionPath: mount,
      persistedPath: builderClaudeConfigPath(dataDir),
      onWarn,
    })).toBe(true);

    const persisted = JSON.parse(await readFile(builderClaudeConfigPath(dataDir), 'utf-8'));
    expect(persisted.hasCompletedOnboarding).toBe(true);
    expect(persisted.theme).toBe('light');
  });

  // INVARIANT: a per-launch `--daemon-config` path must never be persisted. The
  // token file is deleted when the session ends, so persisting the entry would
  // seed the NEXT launch with a dangling path — the same class of bug through a
  // different door.
  test('the persisted state never carries a per-launch daemon-config path', async () => {
    const mount = await prepareLaunch('aaaaaaaa', join(dir, 'mcp', 'a.json'));
    await persistBuilderSessionClaudeConfig({
      sessionPath: mount,
      persistedPath: builderClaudeConfigPath(dataDir),
      onWarn,
    });

    const persisted = JSON.parse(await readFile(builderClaudeConfigPath(dataDir), 'utf-8'));
    expect(daemonConfigPathFromClaudeConfig(persisted)).toBeNull();
    expect(JSON.stringify(persisted)).not.toContain('daemon-config');
  });

  test('sibling MCP servers survive the round trip; only the lazy entry is dropped', async () => {
    await writeFile(
      builderClaudeConfigPath(dataDir),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    );
    const mount = await prepareLaunch('aaaaaaaa', join(dir, 'mcp', 'a.json'));
    expect(JSON.parse(await readFile(mount, 'utf-8')).mcpServers.other).toEqual({ command: 'x' });

    await persistBuilderSessionClaudeConfig({
      sessionPath: mount,
      persistedPath: builderClaudeConfigPath(dataDir),
      onWarn,
    });
    const persisted = JSON.parse(await readFile(builderClaudeConfigPath(dataDir), 'utf-8'));
    expect(persisted.mcpServers).toEqual({ other: { command: 'x' } });
  });

  test('write-back with no session file leaves the persisted state alone', async () => {
    await writeFile(builderClaudeConfigPath(dataDir), JSON.stringify({ theme: 'dark' }));
    expect(await persistBuilderSessionClaudeConfig({
      sessionPath: join(tmpFiles, 'nope.json'),
      persistedPath: builderClaudeConfigPath(dataDir),
      onWarn,
    })).toBe(false);
    expect(JSON.parse(await readFile(builderClaudeConfigPath(dataDir), 'utf-8')).theme).toBe('dark');
  });
});

describe('builder MCP config fail-loud checks', () => {
  let dir: string;
  let token: string;
  let claudeConfig: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-builder-mcp-check-'));
    token = join(dir, 'daemon-mcp-builder-1.json');
    claudeConfig = join(dir, 'claude.json');
    await writeFile(token, JSON.stringify({ token: 't', target: 'http://x' }));
    await writeFile(claudeConfig, JSON.stringify({
      mcpServers: { lazy: { command: 'lazy-agent', args: ['mcp', '--daemon-config', token] } },
    }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('agreeing config and credential pass both checks', async () => {
    await assertDaemonMcpConfigMounted(token, claudeConfig);
    await preflightBuilderMcpConfig({ daemonConfigPath: token, claudeConfigPath: claudeConfig });
  });

  // INVARIANT: silence is the bug. A builder whose MCP server cannot start has
  // no lazy_* tools for the whole session and says so nowhere the human looks.
  test('a missing credential file errors, naming the path', async () => {
    await rm(token);
    await expect(assertDaemonMcpConfigMounted(token, claudeConfig)).rejects.toThrow(token);
    await expect(
      preflightBuilderMcpConfig({ daemonConfigPath: token, claudeConfigPath: claudeConfig }),
    ).rejects.toThrow(token);
  });

  test('a config naming a different credential errors with expected vs actual', async () => {
    const other = join(dir, 'daemon-mcp-builder-2.json');
    await writeFile(claudeConfig, JSON.stringify({
      mcpServers: { lazy: { command: 'lazy-agent', args: ['mcp', '--daemon-config', other] } },
    }));

    for (const run of [
      () => assertDaemonMcpConfigMounted(token, claudeConfig),
      () => preflightBuilderMcpConfig({ daemonConfigPath: token, claudeConfigPath: claudeConfig }),
    ]) {
      let message = '';
      try { await run(); } catch (err) { message = (err as Error).message; }
      expect(message).toContain(other);
      expect(message).toContain(token);
    }
  });

  test('a config with no lazy MCP entry errors rather than passing', async () => {
    await writeFile(claudeConfig, JSON.stringify({ theme: 'dark' }));
    await expect(
      preflightBuilderMcpConfig({ daemonConfigPath: token, claudeConfigPath: claudeConfig }),
    ).rejects.toThrow('no lazy MCP entry');
  });

  test('daemonConfigPathFromClaudeConfig tolerates every malformed shape', () => {
    expect(daemonConfigPathFromClaudeConfig(null)).toBeNull();
    expect(daemonConfigPathFromClaudeConfig({})).toBeNull();
    expect(daemonConfigPathFromClaudeConfig({ mcpServers: {} })).toBeNull();
    expect(daemonConfigPathFromClaudeConfig({ mcpServers: { lazy: {} } })).toBeNull();
    expect(daemonConfigPathFromClaudeConfig({ mcpServers: { lazy: { args: ['mcp'] } } })).toBeNull();
    // Flag present but no value after it.
    expect(daemonConfigPathFromClaudeConfig(
      { mcpServers: { lazy: { args: ['mcp', '--daemon-config'] } } },
    )).toBeNull();
  });
});

describe('container mounts agree with the config they are given', () => {
  const ROOT = '/repo';
  const HOME_DIR = '/home/human';
  const TOKEN = '/home/human/.lazy/daemon/slug/mcp/daemon-mcp-builder-1.json';

  // INVARIANT: the builder's `~/.claude.json` mount source must be the
  // per-launch copy the runner just wrote, and the credential it names must be
  // the one mounted alongside it. These two facts are the whole bug.
  test('builder: the mounted ~/.claude.json and the mounted credential are one launch\'s', () => {
    const sessionConfig = `${ROOT}/.lazy/tmp/builder-claude-a1b2c3d4.json`;
    const args = buildBuilderDockerArgs({
      binary: 'docker',
      builderId: 'a1b2c3d4',
      lazyRoot: ROOT,
      dataDir: `${ROOT}/.lazy`,
      scratchDir: `${HOME_DIR}/.lazy/scratch/p`,
      containerConfigFile: `${ROOT}/.lazy/tmp/builder-container-a1b2c3d4.json`,
      agentBinaryPath: '/usr/local/share/lazy-agent',
      home: HOME_DIR,
      neutralCredentialStore: `${ROOT}/.lazy/tmp/creds-a1b2c3d4.json`,
      mergedConfigFile: sessionConfig,
      authEnvVars: [],
      imageName: 'lazy-agent:latest',
      promptFile: `${ROOT}/.lazy/tmp/builder-prompt-1.txt`,
      daemonConfigPath: TOKEN,
      claudeExtraArgs: [],
      debug: false,
    });

    expect(args).toContain(`${sessionConfig}:/home/user/.claude.json`);
    expect(args).toContain(`${TOKEN}:${TOKEN}:ro`);
    // The per-launch copy carries the builder id, so no two launches share it.
    expect(sessionConfig).toContain('a1b2c3d4');
  });

  // INVARIANT: task agents are structurally immune to this bug and must stay so.
  // Their `/home/user/.claude.json` is NOT a host mount — it lives on the
  // container's own filesystem and is written per turn by the in-container
  // supervisor from LAZY_DAEMON_CONFIG (src/supervisor/mcp-setup.ts), which is
  // this container's own mounted path. There is no shared host file for a
  // second launch to clobber. If a future change starts mounting a host
  // ~/.claude.json into agent containers, this test fails and the builder's
  // per-launch discipline must be applied there too.
  test('agent: no host ~/.claude.json is mounted, and the credential path is the env var', () => {
    const args = buildSupervisorDockerArgs({
      binary: 'docker',
      containerName: 'lazy-task-a',
      imageName: 'lazy-agent:latest',
      repoRoot: ROOT,
      sandbox: {
        worktreePath: `${ROOT}/.lazy/worktrees/a`,
        sandboxPath: `${ROOT}/.lazy/worktrees/a/.lazy-task-sandbox`,
      } as never,
      protocolDir: `${ROOT}/.lazy/tmp/protocol-a`,
      agentBinaryPath: '/usr/local/share/lazy-agent',
      authEnvVars: [],
      customMountArgs: [],
      gitMountArgs: [],
      wrapperScript: 'sleep 1',
      daemonConfigPath: TOKEN,
    });

    expect(args.some(a => a.includes(':/home/user/.claude.json'))).toBe(false);
    expect(args).toContain(`${TOKEN}:${TOKEN}:ro`);
    expect(args).toContain(`LAZY_DAEMON_CONFIG=${TOKEN}`);
  });
});
