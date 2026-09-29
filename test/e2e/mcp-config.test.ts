/**
 * Tests for MCP config file writing (~/.claude.json).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync, writeFileSync } from 'fs';

// writeMcpConfig resolves HOME through getHome() ($HOME first), so each test
// points HOME at a throwaway directory. INVARIANT: this suite never reads or
// writes the real ~/.claude.json. It used to — saving, deleting and restoring
// the file of whoever ran it — which briefly cut any live agent or builder
// sharing that HOME off from its lazy tools.

describe('MCP config', () => {
  let home: string;
  let claudeConfigPath: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'lazy-mcp-config-home-'));
    claudeConfigPath = join(home, '.claude.json');
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  test('creates ~/.claude.json with lazy MCP server entry', async () => {
    const { writeMcpConfig } = await import('../../src/mcp/config');
    await writeMcpConfig({ command: 'lazy-agent', args: ['mcp', '--task-id', 'test-task-uuid', '--worktree', '/test/worktree'] });

    expect(existsSync(claudeConfigPath)).toBe(true);
    const content = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
    expect(content.mcpServers).toBeDefined();
    expect(content.mcpServers['lazy']).toBeDefined();
    expect(content.mcpServers['lazy'].command).toBe('lazy-agent');
    expect(content.mcpServers['lazy'].args).toEqual(['mcp', '--task-id', 'test-task-uuid', '--worktree', '/test/worktree']);
  });

  test('preserves existing config entries', async () => {
    // Write a pre-existing config
    const existingConfig = {
      someExistingSetting: true,
      mcpServers: {
        'other-server': {
          command: 'other',
          args: ['--flag'],
        },
      },
    };
    writeFileSync(claudeConfigPath, JSON.stringify(existingConfig));

    const { writeMcpConfig } = await import('../../src/mcp/config');
    await writeMcpConfig({ command: 'lazy-agent', args: ['mcp', '--task-id', 'test-uuid', '--worktree', '/work'] });

    const content = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));

    // Original settings preserved
    expect(content.someExistingSetting).toBe(true);
    expect(content.mcpServers['other-server']).toBeDefined();
    expect(content.mcpServers['other-server'].command).toBe('other');

    // Lazy MCP server added
    expect(content.mcpServers['lazy']).toBeDefined();
    expect(content.mcpServers['lazy'].command).toBe('lazy-agent');
  });

  test('updates existing lazy entry', async () => {
    // Write a config with an old lazy entry
    const existingConfig = {
      mcpServers: {
        'lazy': {
          command: 'lazy-agent',
          args: ['mcp', '--task-id', 'old-uuid', '--worktree', '/old/path'],
        },
      },
    };
    writeFileSync(claudeConfigPath, JSON.stringify(existingConfig));

    const { writeMcpConfig } = await import('../../src/mcp/config');
    await writeMcpConfig({ command: 'lazy-agent', args: ['mcp', '--task-id', 'new-uuid', '--worktree', '/new/path'] });

    const content = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
    expect(content.mcpServers['lazy'].args).toEqual(['mcp', '--task-id', 'new-uuid', '--worktree', '/new/path']);
  });
});
