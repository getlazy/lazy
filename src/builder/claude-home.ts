/**
 * What the builder container sees at `$HOME/.claude/.credentials.json` and
 * `$HOME/.claude.json`.
 *
 * ── The credential store: why the builder must NOT see the host's ────────────
 *
 * The builder receives the daemon's credential as `CLAUDE_CODE_OAUTH_TOKEN`,
 * exactly like a task agent. Inside Claude Code that env var outranks the stored
 * `~/.claude/.credentials.json` record unconditionally, and the record it
 * synthesises from the env var carries `refreshToken: null`:
 *
 *     TU = memo(async () => {
 *       if (env.CLAUDE_CODE_OAUTH_TOKEN) return fs();   // env wins, always
 *       ... otherwise read ~/.claude/.credentials.json
 *     });
 *     fs = () => ({ accessToken: env.CLAUDE_CODE_OAUTH_TOKEN, refreshToken: null, ... });
 *
 * That `refreshToken: null` is what makes the 401-recovery path dangerous. On
 * ANY upstream 401, Claude Code takes the "no refresh token" branch, reads the
 * credential store off disk, and — if it finds a *different* access token there
 * — OVERWRITES the process env with it and declares itself recovered:
 *
 *     let stored = (await store.readAsync())?.claudeAiOauth;
 *     if (stored?.accessToken && stored.accessToken !== failedToken) {
 *       if (env.CLAUDE_CODE_OAUTH_TOKEN) process.env.CLAUDE_CODE_OAUTH_TOKEN = stored.accessToken;
 *       ... // telemetry: tengu_oauth_401_recovered_from_disk
 *       return true;
 *     }
 *
 * The builder used to mount the human's real `~/.claude` — including their
 * `.credentials.json`, whose `claudeAiOauth.accessToken` is a short-lived OAuth
 * token that nothing refreshes when the human authenticates by env var. So a
 * single transient 401 permanently swapped the builder's good daemon credential
 * for the host's stale one. Every subsequent request then failed with "401 OAuth
 * access token has expired", and the second 401 found nothing new on disk and
 * fell through to a `/login` prompt — while task agents, whose sandbox `.claude`
 * has no credential store at all, kept running fine on the same daemon token.
 *
 * That asymmetry — a readable host credential store, builder-only — was the one
 * structural difference between the two roles. We close it by shadowing just
 * that file with a neutral store, the same deeper-bind trick `projects-isolation`
 * uses for `~/.claude/projects`. The rest of `~/.claude` (settings, commands,
 * agents, plugins) stays mounted and shared.
 *
 * Nothing is lost: with the env var set, the host store was never used for
 * authentication in the first place, and a `/login` performed inside the
 * container used to mutate the human's real host credential record — a hidden
 * side effect of running a container.
 *
 * ── `~/.claude.json`: why it must persist ───────────────────────────────────
 *
 * `~/.claude.json` holds non-credential UI/account state: onboarding completion,
 * theme, per-project trust ("do you trust the files in this folder?"), the last
 * chosen model, MCP server approvals. The builder mounts a MERGED copy of it,
 * because lazy has to inject its own `mcpServers.lazy` entry without editing the
 * human's real file. That copy used to be a per-launch temp file, so every write
 * Claude Code made to it was discarded when the builder exited and the human
 * re-answered the same prompts on every launch. We keep the merge, but the
 * target is now a stable per-project file so the state survives.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * A syntactically valid credential store with no `claudeAiOauth` record.
 *
 * `{}` rather than an empty file on purpose: Claude Code's store read is
 * `JSON.parse`-based inside a try/catch, so an empty file would work but would
 * log a parse error on every read. `{}` parses cleanly and yields
 * `claudeAiOauth === undefined`, which is exactly the state a task agent's
 * sandbox `.claude` is in.
 */
export const NEUTRAL_CREDENTIAL_STORE = '{}\n';

/** Container path the neutral store shadows. */
export const CONTAINER_CREDENTIAL_STORE = '/home/user/.claude/.credentials.json';

/**
 * Write the neutral credential store the builder container mounts over the
 * host's, and return its host path.
 *
 * Per-launch and disposable: it exists only to occupy the mount point. It is
 * writable inside the container so an in-container `/login` still functions for
 * the life of that container — it just can no longer reach through to the
 * human's real credential record.
 *
 * @param tmpDir - Directory for per-launch builder temp files (`.lazy/tmp`)
 * @param builderId - Short builder session id, used to keep concurrent builders apart
 */
export async function writeNeutralCredentialStore(tmpDir: string, builderId: string): Promise<string> {
  const path = join(tmpDir, `builder-credentials-${builderId}.json`);
  await writeFile(path, NEUTRAL_CREDENTIAL_STORE);
  return path;
}

/** Path of the stable, persisted `~/.claude.json` the builder container mounts. */
export function builderClaudeConfigPath(dataDir: string): string {
  return join(dataDir, 'builder-claude-config.json');
}

/**
 * Merge lazy's MCP server entry into a `~/.claude.json` document.
 *
 * Pure so the precedence is testable: every other key of `base` is preserved
 * verbatim, sibling `mcpServers` entries are preserved, and only `mcpServers.lazy`
 * is (re-)written — it has to be refreshed on every launch because the daemon
 * config path it points at changes between runs.
 */
export function mergeBuilderClaudeConfig(
  base: Record<string, unknown>,
  mcpArgs: string[],
): Record<string, unknown> {
  return {
    ...base,
    mcpServers: {
      ...((base.mcpServers as Record<string, unknown>) ?? {}),
      lazy: { command: 'lazy-agent', args: mcpArgs },
    },
  };
}

/**
 * Resolve the base document for the builder's `~/.claude.json`.
 *
 * First launch has nothing persisted, so we seed from the human's real
 * `~/.claude.json` — that carries their theme, onboarding state and existing MCP
 * servers into the builder. After that the persisted file is authoritative: it
 * accumulates whatever Claude Code wrote inside the container, and re-seeding
 * from the host would throw that away, which is the bug this replaces.
 *
 * A file that exists but does not parse is NOT fatal here. This is derived UI
 * state, not the human's input, and the source it was derived from (the host
 * config) is still available — so a corrupt persisted copy falls back to a
 * re-seed and says so, rather than refusing to launch the builder.
 *
 * @param persistedPath - Stable per-project config (see `builderClaudeConfigPath`)
 * @param hostConfigPath - The human's real `~/.claude.json`
 * @param onWarn - Called with an actionable message when a file exists but is unreadable
 */
export async function resolveBuilderClaudeConfigBase(
  persistedPath: string,
  hostConfigPath: string,
  onWarn: (message: string) => void,
): Promise<Record<string, unknown>> {
  const persisted = await readJsonObject(persistedPath, onWarn);
  if (persisted) return persisted;
  return (await readJsonObject(hostConfigPath, onWarn)) ?? {};
}

async function readJsonObject(
  path: string,
  onWarn: (message: string) => void,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    // Absent is the normal first-launch condition — fall through to the caller's
    // next source. Anything else (a permission error, a directory) is not.
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
