/**
 * Tests for MCP config file writing (~/.claude.json).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

// We test the writeMcpConfig function by importing it directly
// and manipulating the home directory via env.
// Note: writeMcpConfig uses homedir() which reads the real home.
// We'll test it by reading the actual ~/.claude.json before and after.

describe('MCP config', () => {
  const claudeConfigPath = join(homedir(), '.claude.json');
  let originalContent: string | null = null;

  beforeEach(() => {
    // Save original config if it exists
    if (existsSync(claudeConfigPath)) {
      originalContent = readFileSync(claudeConfigPath, 'utf-8');
    } else {
      originalContent = null;
    }
  });

  afterEach(() => {
    // Restore original config
    if (originalContent !== null) {
      writeFileSync(claudeConfigPath, originalContent);
    } else if (existsSync(claudeConfigPath)) {
      unlinkSync(claudeConfigPath);
    }
  });

  test('creates ~/.claude.json with lazy MCP server entry', async () => {
    // Remove existing config
    if (existsSync(claudeConfigPath)) {
      unlinkSync(claudeConfigPath);
    }

    const { writeMcpConfig } = await import('../../src/mcp/config');
    writeMcpConfig({ command: 'lazy-agent', args: ['mcp', '--task-id', 'test-task-uuid', '--worktree', '/test/worktree'] });

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
    writeMcpConfig({ command: 'lazy-agent', args: ['mcp', '--task-id', 'test-uuid', '--worktree', '/work'] });

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
    writeMcpConfig({ command: 'lazy-agent', args: ['mcp', '--task-id', 'new-uuid', '--worktree', '/new/path'] });

    const content = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
    expect(content.mcpServers['lazy'].args).toEqual(['mcp', '--task-id', 'new-uuid', '--worktree', '/new/path']);
  });
});
