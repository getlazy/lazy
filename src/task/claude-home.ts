/**
 * Task-sandbox persistence for `$HOME/.claude.json`.
 *
 * Claude Code reads onboarding state, theme, folder trust, and MCP discovery
 * from `~/.claude.json` at the HOME root. Task containers mount
 * `<worktree>/.lazy-task-sandbox/.claude` at `/home/user/.claude`, but until
 * this module that file's SIBLING `~/.claude.json` lived on the container's
 * ephemeral filesystem — so every pair (and every fresh container) replayed the
 * first-run wizard and could not reuse UI state written during earlier turns.
 *
 * The sandbox copy is the source of truth. New supervisor containers bind-mount
 * it at `/home/user/.claude.json`; `prepareTurnMcp` then merges the lazy MCP
 * entry into that same file each turn. Pairing on a container that predates the
 * mount still works: `activateTaskClaudeConfig` copies the sandbox file onto
 * the ephemeral path before MCP wiring runs.
 *
 * CREDENTIALS NEVER CROSS THIS BOUNDARY. The host's `~/.claude.json` may seed
 * preference fields (theme, onboarding completion) on first write; oauth tokens
 * and API keys stay out. Task agents authenticate through the proxy placeholder
 * env vars, same as today.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { getHome } from '../utils/home';
import { pathExists, readFileSafe } from '../utils/fs';
import { SANDBOX_DIR } from '../utils/sandbox';

/** Sandbox-relative filename — mounted to `/home/user/.claude.json`. */
export const TASK_CLAUDE_CONFIG_BASENAME = '.claude.json';

/**
 * Non-credential keys safe to copy from the human's host `~/.claude.json` when
 * seeding a task sandbox for the first time. Everything else is dropped.
 */
export const TASK_CLAUDE_PREFERENCE_KEYS = [
  'hasCompletedOnboarding',
  'theme',
  'lastSelectedModel',
  'lastActiveModel',
] as const;

export function taskSandboxClaudeConfigPath(sandboxPath: string): string {
  return join(sandboxPath, TASK_CLAUDE_CONFIG_BASENAME);
}

export function taskSandboxPathForWorktree(worktreePath: string): string {
  return join(worktreePath, SANDBOX_DIR);
}

/**
 * Pull only UI preference fields out of a host config document.
 *
 * Pure so the allowlist is testable. Deliberately omits `mcpServers` — lazy
 * injects its own entry per turn and a host MCP list must not ride into the
 * container wholesale.
 */
export function extractClaudePreferenceSeed(
  base: Record<string, unknown>,
): Record<string, unknown> {
  const seed: Record<string, unknown> = {};
  for (const key of TASK_CLAUDE_PREFERENCE_KEYS) {
    if (base[key] !== undefined) seed[key] = base[key];
  }
  // Pairing is never the first-run moment — skip the wizard even when the host
  // has no config yet (brand-new lazy user pairing before running a turn).
  if (seed.hasCompletedOnboarding === undefined) {
    seed.hasCompletedOnboarding = true;
  }
  return seed;
}

/**
 * Resolve the base document for a task's sandbox `~/.claude.json`.
 *
 * The persisted sandbox file is authoritative once it exists. On first launch we
 * seed from the human's real config (preferences only); after that, re-seeding
 * from the host would discard answers Claude Code wrote inside the container.
 */
export async function resolveTaskClaudeConfigBase(
  persistedPath: string,
  hostConfigPath: string,
  onWarn: (message: string) => void,
): Promise<Record<string, unknown>> {
  const persisted = await readJsonObject(persistedPath, onWarn);
  if (persisted) return persisted;

  const host = await readJsonObject(hostConfigPath, onWarn);
  return extractClaudePreferenceSeed(host ?? {});
}

/**
 * Ensure the sandbox holds a seeded `~/.claude.json` before a container launch
 * or pair exec. Idempotent — safe on every `setupSandbox` call.
 */
export async function ensureTaskClaudeConfig(sandboxPath: string): Promise<string> {
  const path = taskSandboxClaudeConfigPath(sandboxPath);
  if (await pathExists(path)) return path;

  const base = await resolveTaskClaudeConfigBase(
    path,
    join(getHome(), '.claude.json'),
    () => { /* first-write path: absent host config is normal */ },
  );
  await writeFile(path, JSON.stringify(base, null, 2) + '\n');
  return path;
}

/**
 * Make the in-container `$HOME/.claude.json` match the sandbox copy.
 *
 * When the sandbox file is bind-mounted at `/home/user/.claude.json` this is a
 * no-op. Older containers that predate the mount still get the seeded state by
 * copying onto the ephemeral path before `prepareTurnMcp` runs.
 */
export async function activateTaskClaudeConfig(worktreePath: string): Promise<void> {
  const sandboxPath = taskSandboxPathForWorktree(worktreePath);
  const persistedPath = await ensureTaskClaudeConfig(sandboxPath);
  const containerPath = join(getHome(), '.claude.json');

  if (persistedPath === containerPath) return;

  const content = await readFileSafe(persistedPath);
  if (!content) {
    throw new Error(
      `Task Claude config is missing at ${persistedPath} after ensureTaskClaudeConfig — cannot pair.`,
    );
  }
  await writeFile(containerPath, content);
}

/**
 * Fold whatever Claude Code wrote to `$HOME/.claude.json` back into the sandbox
 * copy after a pairing session ends.
 *
 * `mcpServers.lazy` is dropped on the way through — it names this launch's
 * `--daemon-config` path, which is deleted when the session ends. It is
 * re-derived on every turn by `prepareTurnMcp`.
 */
export async function persistTaskSessionClaudeConfig(
  worktreePath: string,
  onWarn: (message: string) => void,
): Promise<boolean> {
  const sandboxPath = taskSandboxPathForWorktree(worktreePath);
  const persistedPath = taskSandboxClaudeConfigPath(sandboxPath);
  const containerPath = join(getHome(), '.claude.json');

  const session = await readJsonObject(containerPath, onWarn);
  if (!session) return false;

  const servers = { ...((session.mcpServers as Record<string, unknown>) ?? {}) };
  delete servers.lazy;
  const next: Record<string, unknown> = { ...session };
  if (Object.keys(servers).length > 0) next.mcpServers = servers;
  else delete next.mcpServers;

  try {
    await writeFile(persistedPath, JSON.stringify(next, null, 2) + '\n');
    return true;
  } catch (err) {
    onWarn(
      `Could not persist task Claude config to ${persistedPath}: ${(err as Error).message}. ` +
      `Onboarding/model choices from this pairing session may be re-prompted next launch.`,
    );
    return false;
  }
}

async function readJsonObject(
  path: string,
  onWarn: (message: string) => void,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    onWarn(`Could not read ${path}: ${(err as Error).message}. Continuing without it.`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      onWarn(`${path} is not a JSON object. Continuing without it.`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    onWarn(`Could not parse ${path}: ${(err as Error).message}. Continuing without it.`);
    return null;
  }
}
