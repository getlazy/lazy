/**
 * Per-turn ~/.codex/config.toml for a codex agent turn.
 *
 * WHY LAZY OWNS THE WHOLE FILE: codex reads BOTH its model provider and its
 * MCP servers from this one TOML file, and both are load-bearing for lazy:
 *
 *  1. The provider block is the ONLY way to route codex through lazy's proxy —
 *     OPENAI_BASE_URL is ignored by the CLI (checked on 0.152.1, 2026-09). Without it a
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

import { dirname, join } from 'path';
import { getHome } from '../utils/home';
import { readFileSafe, writeFile, ensureDir } from '../utils/fs';

/** First line of every lazy-managed config.toml — the rewrite consent marker. */
export const CODEX_CONFIG_MARKER = '# Managed by lazy — rewritten before every codex turn. Do not edit.';

/**
 * Codex truncates the project doc (AGENTS.md) it injects at `project_doc_max_bytes`.
 * Checked against codex-cli 0.152.1 (2026-09; codex is not pinned): the key exists in the
 * binary's config schema, and `codex debug prompt-input` on a repo with a 100 KB
 * AGENTS.md carried exactly the first 32768 bytes by default (32 KiB) and the whole
 * file with `-c project_doc_max_bytes=200000`. A silent head-only read dropped most
 * of a large repo's instructions, so lazy raises the cap to 256 KiB for every
 * project: well above any sane instruction file, still a bound on prompt size.
 * Details: docs/codex-project-doc-cap.md. Set in the managed config rather than argv so exec, resume and the pairing TUI
 * all get it.
 */
export const CODEX_PROJECT_DOC_MAX_BYTES = 262144;

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
  /**
   * Directories codex must treat as UNTRUSTED (`[projects."<path>"]
   * trust_level = "untrusted"`) — a member's session on Lazy Teams passes the
   * task worktree. An untrusted project's own `.codex/` config layer and its
   * hooks are not loaded, and with an entry present codex never asks the
   * "trust this directory?" question, so a member cannot be talked into
   * loading configuration a turn wrote next to their credential. Accepted by
   * codex-cli 0.164.0 (an unknown value fails with "failed to load bootstrap
   * configuration"; "untrusted" loads).
   */
  untrustedProjects?: string[];
  /**
   * Instructions codex adds as a DEVELOPER message ahead of the conversation —
   * the builder's system prompt. Top-level `developer_instructions`, verified
   * against codex-cli 0.164.0 with `codex debug prompt-input` (the text appears
   * as its own developer message, after codex's base instructions). In the file
   * rather than `-c` on argv so a large prompt has no argv limit. Task turns
   * leave it unset: their prompt rides the `codex exec` input.
   */
  developerInstructions?: string;
  /**
   * How codex treats the lazy MCP server's tools. `approve` (the default, and
   * what every supervised turn uses — nobody is there to answer a prompt);
   * `prompt` only for an interactive builder the human started with
   * `--no-autonomous`, where asking first is the point.
   */
  toolsApproval?: 'approve' | 'prompt';
}

/**
 * Render the full managed config.toml content.
 *
 * `default_tools_approval_mode = "approve"` pre-approves every tool the lazy
 * MCP server advertises, so no turn ever stops on an approval prompt nobody
 * can answer (`codex exec` runs with approval policy `never`, under which an
 * unapproved MCP call is denied). It is a per-server key of codex's
 * `McpServerConfig`, values `auto | prompt | approve` (read off the
 * codex-cli 0.152.1 binary's config schema, and verified: the binary loads
 * "approve" and refuses an unknown value with "failed to load bootstrap
 * configuration"). Safe because the set of tools is lazy's choice per turn —
 * a read-only or review turn's server never advertises the write tools.
 *
 * `[features] plugins = false` turns off codex's curated plugin marketplace.
 * With it on, codex-cli (checked on 0.161.0, 2026-10) git-clones OpenAI's plugin
 * marketplace into `$CODEX_HOME/.tmp/plugins` at startup — and a task's
 * CODEX_HOME is `<worktree>/.lazy-task-sandbox/.codex`, so every turn planted a
 * nested repository that accept's nested-git gate (rightly) refused. Verified:
 * `codex exec -c features.plugins=true` creates `.tmp/plugins/.git` within
 * seconds, `=false` creates nothing under `.tmp`. Lazy's agents get their tools
 * from the lazy MCP server, never from codex plugins.
 */
export function renderCodexConfig(config: CodexTurnConfig): string {
  const base = config.proxyBaseUrl.replace(/\/$/, '');
  return `${CODEX_CONFIG_MARKER}

model_provider = "lazy"
project_doc_max_bytes = ${CODEX_PROJECT_DOC_MAX_BYTES}
${config.developerInstructions !== undefined ? `developer_instructions = ${tomlString(config.developerInstructions)}\n` : ''}
[model_providers.lazy]
name = "lazy audit proxy (OpenAI-compatible)"
base_url = ${tomlString(base)}
env_key = "OPENAI_API_KEY"
wire_api = "responses"

[mcp_servers.lazy]
command = ${tomlString(config.mcpServer.command)}
args = [${config.mcpServer.args.map(tomlString).join(', ')}]
default_tools_approval_mode = "${config.toolsApproval ?? 'approve'}"

[features]
plugins = false
${(config.untrustedProjects ?? []).map((dir) => `
[projects.${tomlString(dir)}]
trust_level = "untrusted"
`).join('')}`;
}

/**
 * Write the managed config.toml for this turn.
 *
 * Returns true when the file changed (so the caller can log it once). Throws
 * when an unmanaged config.toml is in the way — the caller fails the turn,
 * which is the same posture as prepareTurnMcp's other config writes.
 */
export async function writeCodexConfig(config: CodexTurnConfig, path: string = codexConfigPath()): Promise<boolean> {
  await ensureDir(dirname(path));

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
