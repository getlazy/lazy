/**
 * Force cursor-agent onto HTTP/1.1 for its agent stream.
 *
 * WHY THIS IS LOAD-BEARING, not a tuning knob: cursor-agent opens its agent
 * stream with a connect-rpc transport pinned to `httpVersion: "2"` unless the
 * CLI's `network.useHttp1ForAgent` setting is true. Two things follow from
 * leaving it false, and both defeat this task:
 *
 *  1. lazy's proxy is a `Bun.serve` listener, which speaks HTTP/1.1 only —
 *     cleartext HTTP/2 (h2c) against it fails with a protocol error (verified
 *     with a node:http2 client). The agent stream would simply not connect.
 *  2. On the HTTP/2 path the CLI resolves the agent stream's URL from the
 *     SERVER-supplied `agentUrlConfig` rather than the configured endpoint —
 *     i.e. it would route around lazy's proxy entirely, silently.
 *
 * There is no environment variable for it; the setting lives in
 * `~/.cursor/cli-config.json`. Written per turn for the same reason the MCP
 * config is: in a container that file lives on ephemeral filesystem and a
 * relaunch starts with nothing.
 *
 * The write is a MERGE, never a replace — on host-process runs this is the
 * user's real CLI config (CLAUDE.md: no hidden destructive side effects).
 */

import { join } from 'path';
import { getHome } from '../utils/home';
import { readFileSafe, writeFile, ensureDir } from '../utils/fs';
import { parseMergeTarget } from '../mcp/config';

interface CursorCliConfig {
  network?: { useHttp1ForAgent?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

/** Path of the cursor CLI config lazy merges into. */
export function cursorCliConfigPath(): string {
  return join(getHome(), '.cursor', 'cli-config.json');
}

/**
 * Merge `network.useHttp1ForAgent = true` into `~/.cursor/cli-config.json`.
 *
 * Returns true when the file was changed (so the caller can log it once —
 * touching a user-visible config silently would be a hidden side effect).
 */
export async function ensureCursorHttp1Config(): Promise<boolean> {
  const configPath = cursorCliConfigPath();
  await ensureDir(join(getHome(), '.cursor'));

  let config: CursorCliConfig = {};
  const existing = await readFileSafe(configPath);
  if (existing) {
    config = parseMergeTarget<CursorCliConfig>(existing, configPath);
  }

  if (config.network?.useHttp1ForAgent === true) return false;

  config.network = { ...(config.network ?? {}), useHttp1ForAgent: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return true;
}
