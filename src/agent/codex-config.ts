/**
 * Per-turn ~/.codex/config.toml for a codex agent turn.
 *
 * WHY LAZY OWNS THE WHOLE FILE: codex reads BOTH its model provider and its
 * MCP servers from this one TOML file, and both are load-bearing for lazy:
 *
 *  1. The provider block is the ONLY way to route codex through lazy's proxy —
 *     OPENAI_BASE_URL is ignored by the CLI (verified, 0.152.1). Without it a
 *     turn dials api.openai.com directly with no audit record.
 *  2. The `mcp_servers.lazy` entry is how the agent gets its lazy_* tools —
 *     the codex counterpart of ~/.claude.json / ~/.cursor/mcp.json.
 *
 * Cursor's JSON configs are MERGED because on host runs they are the user's
 * real files. This file is different: in a task container ~/.codex is the
 * per-task sandbox mount (see setupSandbox), born empty and written only by
 * lazy, so the honest model is a managed file rewritten every turn — a marker
 * comment declares that. If a config.toml exists WITHOUT the marker (a user's
 * real file on some future host surface, or something an agent wrote), the
 * write REFUSES and fails the turn rather than silently deleting whatever was
 * configured there — same "found but broken beats silent clobber" posture as
 * parseMergeTarget.
 *
 * `env_key = "OPENAI_API_KEY"` makes codex read the launch's JIT placeholder
 * from the environment and send it as the bearer token to lazy's proxy —
 * verified: with the block in place the env var alone authenticates the CLI
 * (no `codex login` needed), and a missing var fails the turn with codex's own
 * actionable message.
 *
 * The SAME block serves a ChatGPT-subscription turn, and that is why there is no
 * second shape here: codex bearers whatever `env_key` names, so the placeholder
 * travels identically and the proxy decides which real credential it stands for
 * (src/proxy/credential-deps.ts). Only `base_url` differs, and it arrives
 * already complete from the launch. Deliberately NOT `requires_openai_auth`,
 * codex's own ChatGPT switch: that one reads ~/.codex/auth.json, which would
 * mean materialising a login session inside the container — more moving parts
 * for no gain, and it makes the CLI try to refresh (and rotate) the host's token
 * from a filesystem that is thrown away at the end of the turn. Verified in both
 * shapes against codex-cli 0.152.1; see docs/codex-chatgpt-subscription.md.
 */

import { join } from 'path';
import { getHome } from '../utils/home';
import { readFileSafe, writeFile, ensureDir } from '../utils/fs';

/** First line of every lazy-managed config.toml — the rewrite consent marker. */
export const CODEX_CONFIG_MARKER = '# Managed by lazy — rewritten before every codex turn. Do not edit.';

/** Path of the codex config lazy manages. */
export function codexConfigPath(): string {
  return join(getHome(), '.codex', 'config.toml');
}

/**
 * TOML basic-string literal. JSON string escaping is a strict subset of
 * TOML's basic-string escaping (\", \\, \n, \t, \uXXXX are all valid TOML),
 * so JSON.stringify produces a correct TOML basic string.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export interface CodexTurnConfig {
  /**
   * The COMPLETE `base_url` codex dials — the CODEX_ENDPOINT_ENV value the
   * launch site computed, including whatever path prefix that upstream needs
   * (`/v1` for api.openai.com, none for the ChatGPT subscription backend). Used
   * verbatim: the launch is the only place that knows which upstream this
   * profile routes to. See src/proxy/codex-route.ts.
   */
  proxyBaseUrl: string;
  /** The lazy MCP server entry, provided by the Runner. */
  mcpServer: { command: string; args: string[] };
}

/** Render the full managed config.toml content. */
export function renderCodexConfig(config: CodexTurnConfig): string {
  const base = config.proxyBaseUrl.replace(/\/$/, '');
  return `${CODEX_CONFIG_MARKER}

model_provider = "lazy"

[model_providers.lazy]
name = "lazy audit proxy (OpenAI-compatible)"
base_url = ${tomlString(base)}
env_key = "OPENAI_API_KEY"
wire_api = "responses"

[mcp_servers.lazy]
command = ${tomlString(config.mcpServer.command)}
args = [${config.mcpServer.args.map(tomlString).join(', ')}]
`;
}

/**
 * Write the managed config.toml for this turn.
 *
 * Returns true when the file changed (so the caller can log it once). Throws
 * when an unmanaged config.toml is in the way — the caller fails the turn,
 * which is the same posture as prepareTurnMcp's other config writes.
 */
export async function writeCodexConfig(config: CodexTurnConfig): Promise<boolean> {
  const path = codexConfigPath();
  await ensureDir(join(getHome(), '.codex'));

  const next = renderCodexConfig(config);
  const existing = await readFileSafe(path);
  if (existing !== null && existing.trim() && !existing.startsWith(CODEX_CONFIG_MARKER)) {
    throw new Error(
      `${path} exists but was not written by lazy (missing the managed-file marker). ` +
      `Refusing to overwrite it — that would delete whatever is configured there. ` +
      `Move the file aside and retry; lazy rewrites its own copy before every codex turn.`,
    );
  }
  if (existing === next) return false;
  await writeFile(path, next, 'utf-8');
  return true;
}
