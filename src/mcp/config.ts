/**
 * Write MCP server configuration and tool permissions for Claude Code.
 *
 * Claude Code reads ~/.claude.json at startup to discover MCP servers
 * and ~/.claude/settings.json for tool permissions.
 *
 * The user's .mcp.json in the worktree is NEVER touched.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface ClaudeConfig {
  mcpServers?: Record<string, {
    command: string;
    args?: string[];
  }>;
  [key: string]: unknown;
}

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  [key: string]: unknown;
}

/**
 * Write the lazy MCP server entry to ~/.claude.json.
 *
 * Merges with any existing config (preserves other MCP servers and settings).
 * If the file doesn't exist, creates it with just the lazy MCP server entry.
 *
 * @param mcpServerConfig - The command and args for the MCP server, provided by the Runner.
 */
export function writeMcpConfig(mcpServerConfig: { command: string; args: string[] }): void {
  const claudeConfigPath = join(homedir(), '.claude.json');

  let config: ClaudeConfig = {};

  // Read existing config if present
  if (existsSync(claudeConfigPath)) {
    try {
      const content = readFileSync(claudeConfigPath, 'utf-8');
      config = JSON.parse(content);
    } catch {
      // Malformed JSON — overwrite with fresh config
      config = {};
    }
  }

  // Ensure mcpServers object exists
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  // Write the lazy MCP server entry
  config.mcpServers['lazy'] = {
    command: mcpServerConfig.command,
    args: mcpServerConfig.args,
  };

  writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Pre-approve lazy MCP tools in Claude Code's settings.
 *
 * Claude Code asks for permission the first time each MCP tool is called.
 * Since we control the lazy MCP server, all lazy tools should be pre-approved
 * to avoid noisy permission prompts during agent work.
 *
 * Writes tool entries as `mcp__lazy__<tool_name>` to ~/.claude/settings.json.
 * Merges with existing settings, removing stale lazy tool entries first.
 *
 * @param toolNames - Tool names to approve (e.g., ['lazy_search', 'lazy_show', ...])
 */
export function writeToolPermissions(toolNames: string[]): void {
  const claudeDir = join(homedir(), '.claude');
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, 'settings.json');

  let settings: ClaudeSettings = {};

  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch {
      settings = {};
    }
  }

  if (!settings.permissions) {
    settings.permissions = {};
  }

  // Start from existing allow list, removing stale lazy tool entries
  const existing = (settings.permissions.allow ?? []).filter(
    (entry: string) => !entry.startsWith('mcp__lazy__'),
  );

  // Add all current lazy tools
  const lazyEntries = toolNames.map(name => `mcp__lazy__${name}`);

  settings.permissions.allow = [...existing, ...lazyEntries];

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
