/**
 * Per-project agent API keys — resolved at LAUNCH time, never frozen into the
 * daemon's environment.
 *
 * WHY THIS EXISTS: the Cursor key used to be read from `process.env` only,
 * i.e. the daemon's env captured at daemon start. A keyless daemon could only
 * be fixed by restarting it — unacceptable DX. Resolution now happens per
 * launch, in this order:
 *
 *   1. The agent's env var (e.g. CURSOR_API_KEY) — an explicit override.
 *   2. `~/.lazy/daemon/<project-slug>/agent-credentials.json` — per-project,
 *      mode 0600, written by `lazy system agent set-key <id>`.
 *
 * WHY THE DAEMON DIR AND NOT `<project>/.lazy/`: every task container mounts
 * the whole project root read-only (`buildSupervisorDockerArgs` in
 * src/capture/claude.ts: `-v <repoRoot>:<repoRoot>:ro`), so a key stored under
 * the project root is readable by EVERY agent of EVERY task on the project —
 * 0600 protects against other host users, not against the container. The
 * per-project daemon dir is never mounted into a container, and already holds
 * the daemon auth `token` and the per-identity MCP tokens for exactly this
 * reason (see src/daemon/paths.ts, MCP_TOKENS_FILE).
 *
 * NOT lazy.toml either: lazy.toml is a committed file, and secrets must never
 * land in a committed file.
 *
 * `launchTask` re-reads everything per launch, so a key set once takes effect
 * on the very next launch with zero daemon involvement.
 */

import { join } from 'path';
import { readFile, writeFile, mkdir, chmod, unlink } from 'fs/promises';
import { getDaemonDir } from '../daemon/paths';
import { logger } from '../utils/logger';

/** Env var each API-key-capable agent reads its key from. */
export const AGENT_KEY_ENV: Record<string, string> = {
  cursor: 'CURSOR_API_KEY',
};

/** True when the agent authenticates via an API key lazy can manage. */
export function agentSupportsApiKey(agentId: string): boolean {
  return agentId in AGENT_KEY_ENV;
}

const CREDENTIALS_FILENAME = 'agent-credentials.json';

/** ~/.lazy/daemon/<project-slug>/agent-credentials.json */
export function credentialsPath(lazyRoot: string): string {
  return join(getDaemonDir(lazyRoot), CREDENTIALS_FILENAME);
}

/**
 * Pre-move home: `<project>/.lazy/agent-credentials.json`. Read once, migrated,
 * and DELETED — leaving it behind would keep a live secret inside the tree every
 * task container mounts.
 */
function legacyCredentialsPath(lazyRoot: string): string {
  return join(lazyRoot, '.lazy', CREDENTIALS_FILENAME);
}

interface CredentialsFile {
  [agentId: string]: { api_key?: string };
}

function parseCredentials(raw: string, path: string): CredentialsFile {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as CredentialsFile)
      : {};
  } catch (err) {
    // Found but broken is an error the human must see — a malformed
    // credentials file silently treated as "no key" would send them chasing
    // the wrong problem (auth) instead of the real one (bad JSON).
    throw new Error(
      `failed to parse ${path}: ${err instanceof Error ? err.message : err}. ` +
      `Fix or delete the file, then re-run \`lazy system agent set-key <agent>\`.`,
    );
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `failed to read ${path}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function writeCredentialsFile(lazyRoot: string, file: CredentialsFile): Promise<string> {
  const path = credentialsPath(lazyRoot);
  await mkdir(getDaemonDir(lazyRoot), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  // writeFile's mode only applies on creation — tighten an existing file too.
  await chmod(path, 0o600);
  return path;
}

/**
 * Migrate a pre-move `<project>/.lazy/agent-credentials.json` into the daemon
 * dir and remove the in-repo original. Entries already in the new file win —
 * a key set since the move is the current one. Best effort on the unlink: if
 * the old file cannot be removed we say so loudly, because the whole point of
 * the move is that it must not stay behind.
 */
async function migrateLegacyCredentials(lazyRoot: string, current: CredentialsFile): Promise<CredentialsFile> {
  const legacyPath = legacyCredentialsPath(lazyRoot);
  const raw = await readFileOrNull(legacyPath);
  if (raw === null) return current;

  const legacy = parseCredentials(raw, legacyPath);
  const merged: CredentialsFile = { ...legacy, ...current };
  await writeCredentialsFile(lazyRoot, merged);

  try {
    await unlink(legacyPath);
    logger.warn(
      `Moved agent credentials out of the repository: ${legacyPath} → ${credentialsPath(lazyRoot)}. ` +
      `The old location was inside the project root, which every task container mounts read-only.`,
    );
  } catch (err) {
    logger.warn(
      `Copied agent credentials to ${credentialsPath(lazyRoot)} but FAILED to remove the old ` +
      `in-repo file ${legacyPath}: ${err instanceof Error ? err.message : err}. ` +
      `Delete it by hand — every task container can read it.`,
    );
  }
  return merged;
}

async function readCredentialsFile(lazyRoot: string): Promise<CredentialsFile> {
  const path = credentialsPath(lazyRoot);
  const raw = await readFileOrNull(path);
  const current = raw === null ? {} : parseCredentials(raw, path);
  return migrateLegacyCredentials(lazyRoot, current);
}

/**
 * Resolve an agent's API key: env var override first, then the per-project
 * credentials file. Returns null when neither source has one.
 */
export async function resolveAgentApiKey(
  lazyRoot: string,
  agentId: string,
): Promise<{ value: string; source: 'env' | 'file' } | null> {
  const envVar = AGENT_KEY_ENV[agentId];
  if (!envVar) return null;

  const fromEnv = process.env[envVar];
  if (fromEnv) return { value: fromEnv, source: 'env' };

  const file = await readCredentialsFile(lazyRoot);
  const fromFile = file[agentId]?.api_key;
  if (fromFile) return { value: fromFile, source: 'file' };

  return null;
}

/**
 * Persist an agent's API key to the per-project credentials file (mode 0600).
 * Returns the path written, for the CLI to report.
 */
export async function writeAgentApiKey(lazyRoot: string, agentId: string, key: string): Promise<string> {
  if (!agentSupportsApiKey(agentId)) {
    throw new Error(`Agent "${agentId}" does not use an API key lazy can store.`);
  }
  if (!key.trim()) {
    throw new Error('Refusing to store an empty API key.');
  }
  const file = await readCredentialsFile(lazyRoot);
  file[agentId] = { ...file[agentId], api_key: key.trim() };
  return writeCredentialsFile(lazyRoot, file);
}

/** Remove an agent's stored key. Returns true when one was present. */
export async function clearAgentApiKey(lazyRoot: string, agentId: string): Promise<boolean> {
  const file = await readCredentialsFile(lazyRoot);
  if (!file[agentId]?.api_key) return false;
  delete file[agentId];
  await writeCredentialsFile(lazyRoot, file);
  return true;
}
