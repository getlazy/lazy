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
 * Who a `mcpServers.lazy` entry belongs to, read off the entry itself.
 *
 * A task entry names its task: every runner's `mcpServerConfig` writes
 * `--task-id <uuid>`, so the id IS the owner record and nothing extra is
 * stored. An entry with no `--task-id` is a builder's (the builder launch
 * writes `mcp --daemon-config …` / `--builder-config …`) or a human's own —
 * either way it is not a task supervisor's to replace.
 */
export type LazyMcpEntryOwner =
  | { kind: 'task'; taskId: string; worktree?: string }
  | { kind: 'other' };

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export function lazyMcpEntryOwner(entry: { args?: unknown }): LazyMcpEntryOwner {
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
  const taskId = argAfter(args, '--task-id');
  if (!taskId) return { kind: 'other' };
  return { kind: 'task', taskId, worktree: argAfter(args, '--worktree') };
}

/** A task supervisor found someone else's `mcpServers.lazy` in its HOME. */
export class ForeignMcpEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForeignMcpEntryError';
  }
}

/**
 * Write the lazy MCP server entry to ~/.claude.json.
 *
 * Merges with any existing config (preserves other MCP servers and settings).
 * If the file doesn't exist, creates it with just the lazy MCP server entry.
 *
 * REFUSES to replace an entry that is not a task's (see `lazyMcpEntryOwner`):
 * Claude Code reads ONE config per HOME, and on 2026-09-28 a supervisor that a
 * test run started inside a builder container rewrote that builder's entry to a
 * throwaway worktree — every lazy_* call the builder made afterwards failed
 * against a healthy daemon. A task's supervisor never has a reason to find a
 * builder's entry in its own HOME (task sandboxes never seed `mcpServers`), so
 * finding one means the HOME is shared with something live: fail the turn and
 * name both, never replace silently.
 *
 * Another TASK's entry is replaced. That is the host runner's ordinary shape —
 * successive tasks' turns in one HOME — and a concurrent task in the same HOME
 * is already refused on the serving side (`src/mcp/turn-identity.ts`).
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

  const existing = config.mcpServers['lazy'];
  const writer = lazyMcpEntryOwner(mcpServerConfig);
  if (existing && writer.kind === 'task' && lazyMcpEntryOwner(existing).kind === 'other') {
    throw new ForeignMcpEntryError(
      `${claudeConfigPath} already has a lazy MCP entry that is not a task's — ` +
      `${[existing.command, ...(existing.args ?? [])].join(' ')} — ` +
      `and task ${writer.taskId} refuses to replace it. It is most likely a builder's or your own, ` +
      `sharing this HOME with the task's supervisor; replacing it would cut that session off from lazy. ` +
      `Run the task's supervisor with its own HOME (a test harness must give every launch a private HOME), ` +
      `or remove the entry by hand if it is genuinely stale.`,
    );
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
 * Writes tool entries as `mcp__lazy__<tool_name>` to `<home>/.claude/settings.json`.
 * Merges with existing settings, removing stale lazy tool entries first.
 *
 * `home` is the home directory the LAUNCH mounts as /home/user — the file must
 * be written where the launched container will read it, which is only the host
 * user's home for the launch paths that mount it (launchBuilderInteractive,
 * launchBuilderHeadless). A launch that mounts a per-member home instead must
 * pass that home, or the permissions land somewhere nothing mounts and the
 * session starts prompting for every lazy tool — while silently rewriting the
 * host operator's real settings as a side effect.
 *
 * @param toolNames - Tool names to approve (e.g., ['lazy_search', 'lazy_show', ...])
 * @param home - Home directory to write under; defaults to the process user's home
 */
export async function writeToolPermissions(toolNames: string[], home: string = getHome()): Promise<void> {
  const claudeDir = join(home, '.claude');
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
