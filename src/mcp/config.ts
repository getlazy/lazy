/**
 * Write MCP server configuration and tool permissions for Claude Code.
 *
 * Claude Code reads ~/.claude.json at startup to discover MCP servers
 * and ~/.claude/settings.json for tool permissions.
 *
 * The user's .mcp.json in the worktree is NEVER touched.
 */

import { join } from 'path';
import { getHome } from '../utils/home';
import { pathExists, readFileSafe, writeFile, ensureDir } from '../utils/fs';

/**
 * Parse a config file lazy is about to MERGE ITS OWN ENTRY INTO.
 *
 * These are the user's real files on host-process runs (~/.claude.json,
 * ~/.cursor/mcp.json, ~/.claude/settings.json). A malformed one used to be
 * swallowed and replaced with `{}`, which silently deleted every other MCP
 * server and every permission the user had configured — a destructive edit
 * they would only discover much later, with no copy to restore from.
 *
 * Per CLAUDE.md's "found but broken" rule: missing falls through to defaults,
 * but present-and-unparseable is an error the human must see. `prepareTurnMcp`
 * fails the turn on a config-write error, so throwing here surfaces properly.
 */
export function parseMergeTarget<T>(content: string, path: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (err) {
    throw new Error(
      `${path} exists but is not valid JSON: ${err instanceof Error ? err.message : err}. ` +
      `Refusing to overwrite it — that would delete everything else configured there. ` +
      `Fix the JSON (or move the file aside) and retry.`,
    );
  }
}

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
export async function writeMcpConfig(mcpServerConfig: { command: string; args: string[] }): Promise<void> {
  const claudeConfigPath = join(getHome(), '.claude.json');

  let config: ClaudeConfig = {};

  // Read existing config if present
  const existingContent = await readFileSafe(claudeConfigPath);
  if (existingContent) {
    config = parseMergeTarget<ClaudeConfig>(existingContent, claudeConfigPath);
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

  await writeFile(claudeConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Write the lazy MCP server entry to ~/.cursor/mcp.json — Cursor's MCP
 * discovery file (same `mcpServers` shape as Claude's).
 *
 * Merges with any existing config, preserving other servers. In a task
 * container ~/.cursor is the sandbox mount (see setupSandbox), so this is
 * per-task state; on host-process runs it merges into the user's real
 * ~/.cursor/mcp.json exactly as the Claude path merges into ~/.claude.json.
 */
export async function writeCursorMcpConfig(mcpServerConfig: { command: string; args: string[] }): Promise<void> {
  const cursorDir = join(getHome(), '.cursor');
  await ensureDir(cursorDir);
  const configPath = join(cursorDir, 'mcp.json');

  let config: ClaudeConfig = {};
  const existingContent = await readFileSafe(configPath);
  if (existingContent) {
    config = parseMergeTarget<ClaudeConfig>(existingContent, configPath);
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  config.mcpServers['lazy'] = {
    command: mcpServerConfig.command,
    args: mcpServerConfig.args,
  };

  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
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
export async function writeToolPermissions(toolNames: string[]): Promise<void> {
  const claudeDir = join(getHome(), '.claude');
  await ensureDir(claudeDir);

  const settingsPath = join(claudeDir, 'settings.json');

  let settings: ClaudeSettings = {};

  const existingContent = await readFileSafe(settingsPath);
  if (existingContent) {
    // Same rule as the MCP configs above: this is the user's real settings
    // file on host runs, and a silent reset would drop every permission,
    // hook, and preference in it.
    settings = parseMergeTarget<ClaudeSettings>(existingContent, settingsPath);
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

  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}
