/**
 * A clone bound to Lazy Teams must not choose a new task's agent from its own
 * lazy.toml — that file is the repository's copy, not the configuration the
 * Teams daemon runs on. Only explicit and inherited choices are sent.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { writeTeamsLogin } from '../../src/teams/login';
import { agentToSend, isBoundClone } from '../../src/cli/helpers';

describe('agent choice in a bound clone', () => {
  let root: string;
  let baseDir: string;
  let undoBaseDir: () => void;
  const savedConfig = process.env.LAZY_CONFIG;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-bound-agent-')));
    baseDir = await mkdtemp(join(tmpdir(), 'lazy-bound-agent-daemon-'));
    undoBaseDir = pinDaemonBaseDir(baseDir);
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    const configPath = join(root, 'lazy.toml');
    await writeFile(configPath, '[credentials]\nbackend = "file"\n');
    process.env.LAZY_CONFIG = configPath;
  });

  afterEach(async () => {
    undoBaseDir();
    if (savedConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = savedConfig;
    await rm(root, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  test('an unbound clone sends every choice, including its own default', async () => {
    expect(await isBoundClone(root)).toBe(false);
    expect(await agentToSend({ agentId: 'claude-complex', source: 'default' }, root)).toBe('claude-complex');
  });

  // INVARIANT: in a bound clone the local default and [agent.by_type] are never
  // sent — the daemon resolves them from Teams' configuration. Sending them put
  // a profile Teams never had onto a Teams task (claude-complex, 2026-10-06).
  test('a bound clone sends only explicit and inherited choices', async () => {
    await writeTeamsLogin(root, {
      teamsUrl: 'https://teams.example.com', token: 'tok-value', project: 'acme/fabricate', projectId: '11',
    });
    expect(await isBoundClone(root)).toBe(true);
    expect(await agentToSend({ agentId: 'claude-complex', source: 'default' }, root)).toBeUndefined();
    expect(await agentToSend({ agentId: 'claude-complex', source: 'by_type' }, root)).toBeUndefined();
    expect(await agentToSend({ agentId: 'security', source: 'explicit' }, root)).toBe('security');
    expect(await agentToSend({ agentId: 'codex', source: 'inherit' }, root)).toBe('codex');
  });
});
