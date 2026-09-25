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
import { readFile, writeFile, mkdir, chmod, unlink, rename } from 'fs/promises';
import { getDaemonDir } from '../daemon/paths';
import { logger } from '../utils/logger';
import { isProvider, type CredentialKind, type CredentialName } from '../credentials/providers';
import { credentialPresence, locateCredential, resolveCredential } from '../credentials/store';
import { NO_CREDENTIAL } from '../config/agent-profiles';

/** Env var each API-key-capable agent reads its key from. */
export const AGENT_KEY_ENV: Record<string, string> = {
  cursor: 'CURSOR_API_KEY',
  codex: 'OPENAI_API_KEY',
};

/**
 * Credential-store provider each key-capable agent draws from, where the two
 * vocabularies differ. Cursor's agent id doubles as its provider id; codex is
 * the AGENT while `openai` is the PROVIDER being paid (the same credential
 * pi's OpenAI backend and the proxy's openai upstream use). Absent entries
 * fall back to the agent id itself.
 */
const AGENT_CREDENTIAL_PROVIDER: Record<string, string> = {
  codex: 'openai',
};

/** The credential-store provider backing an agent's API key. */
export function agentCredentialProvider(agentId: string): string {
  return AGENT_CREDENTIAL_PROVIDER[agentId] ?? agentId;
}

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
  const dir = getDaemonDir(lazyRoot);
  await mkdir(dir, { recursive: true });

  // Same-directory temp + rename: atomic replace and no torn JSON if we crash
  // mid-write. writeFile's mode applies on creation only, so the temp is born
  // at 0600; chmod after rename covers an existing target with loose perms.
  const tmpPath = join(dir, `.agent-credentials.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(file, null, 2) + '\n';
  try {
    await writeFile(tmpPath, payload, { mode: 0o600 });
    await rename(tmpPath, path);
    await chmod(path, 0o600);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch (unlinkErr) {
      const code = (unlinkErr as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // The write/rename error is what the human needs — warn about the
        // leftover temp so they can remove it, then re-throw the original.
        logger.warn(
          `failed to clean up temp credentials file ${tmpPath} after write error: ` +
          `${unlinkErr instanceof Error ? unlinkErr.message : unlinkErr}. Remove it by hand if it remains.`,
        );
      }
    }
    throw err;
  }
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
 * Resolve an agent's API key: env var override first, then the credential store
 * (`lazy auth set <provider>`), then the per-project credentials file. Returns
 * null when no source has one.
 *
 * The store sits BETWEEN env and file deliberately. Env stays the explicit
 * override it has always been; the store is the newer, OS-protected home a user
 * who ran `lazy auth set cursor` expects to win; and the file remains as the
 * pre-store location `lazy system agent set-key` still writes, so nobody's
 * existing key stops working. The two writers are converging, not competing —
 * until then a stored credential simply takes precedence over the older file.
 */
export async function resolveAgentApiKey(
  lazyRoot: string,
  agentId: string,
): Promise<{ value: string; source: 'env' | 'store' | 'file' } | null> {
  const envVar = AGENT_KEY_ENV[agentId];
  if (!envVar) return null;

  // For a PROVIDER, env-then-store is `resolveCredential`'s rule and this must
  // not spell it a second time: it is the one place that knows a value the
  // daemon hydrated out of the store is not an env override (a copy of the
  // store made at startup used to shadow every later `lazy auth set cursor` for
  // the life of the daemon), and that a backend which has stopped answering
  // keeps that copy alive rather than failing the launch. See
  // ../credentials/hydrated-env.ts and ../credentials/store.ts.
  const provider = agentCredentialProvider(agentId);
  if (isProvider(provider)) {
    const resolved = await resolveCredential(lazyRoot, provider);
    if (resolved) return { value: resolved.value, source: resolved.source };
  } else {
    // An agent whose key is not a provider lazy knows has no store entry to
    // consult; its env var is the only override there is.
    const fromEnv = process.env[envVar];
    if (fromEnv?.trim()) return { value: fromEnv, source: 'env' };
  }

  const file = await readCredentialsFile(lazyRoot);
  const fromFile = file[agentId]?.api_key;
  if (fromFile) return { value: fromFile, source: 'file' };

  return null;
}

/**
 * Resolve the credential an agent PROFILE bills, for a harness that carries its
 * own key (codex, cursor). Env var for the credential NAME → the credential
 * store → the legacy per-agent file. Null when no source has one.
 *
 * Why not {@link resolveAgentApiKey}: that one answers "the key for this
 * HARNESS", which stops being the same question the moment a profile names its
 * own credential. `[agents.work-codex] credential = "work-openai"` and the
 * built-in `codex` profile both run the codex harness and must resolve
 * DIFFERENT keys — and the proxy already bills them separately (it resolves the
 * profile's slot, never the harness's), so a launch check keyed by harness would
 * pass on a key the request will not be sent with.
 *
 * The legacy file is consulted ONLY when the profile's credential is the one
 * that file is about — the provider `lazy system agent set-key <harness>` used
 * to write under. Otherwise a named credential would silently inherit the
 * harness's key, launch, and then 401 upstream: exactly the divergence this
 * function exists to close.
 */
export async function resolveProfileCredential(
  lazyRoot: string,
  profile: { name: string; harness: string; credential: CredentialName },
): Promise<{ value: string; source: 'env' | 'store' | 'file' } | null> {
  // An upstream that authenticates nobody has nothing to resolve. Callers check
  // this too (there is no key to REQUIRE), but answering null here keeps the
  // function total rather than making `none` an error case.
  if (profile.credential === NO_CREDENTIAL) return null;

  const resolved = await resolveCredential(lazyRoot, profile.credential);
  if (resolved) return { value: resolved.value, source: resolved.source };

  if (agentCredentialProvider(profile.harness) === profile.credential) {
    const file = await readCredentialsFile(lazyRoot);
    const fromFile = file[profile.harness]?.api_key;
    if (fromFile) return { value: fromFile, source: 'file' };
  }
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

/** Where a profile's credential was found — the handle only, never the secret. */
export interface CredentialLocation {
  present: boolean;
  /**
   * `env` — a variable in the inspected environment; `store` — the credential
   * store's index; `file` — the per-agent key file `lazy system agent set-key`
   * writes; null when absent.
   */
  source: 'env' | 'store' | 'file' | null;
  /** The env var NAME, the store backend id, or the key file's path. Null when absent. */
  via: string | null;
  /**
   * Which FORM of the credential is in effect — `oauth` (a subscription) or
   * `api-key` (a metered key) — or null when that is not knowable.
   *
   * Reported because on a provider that issues both, this is the difference
   * between spending a subscription someone has already paid for and spending
   * metered credit, and nothing else a user checks before launching says which
   * one they are on. Known only for the STORE, whose non-secret index records it;
   * an env var carries a bare value with no kind attached, and the key file holds
   * an API key by construction (`api-key`).
   */
  kind: CredentialKind | null;
  /**
   * DEGRADED: the credential store cannot be read, so requests are being served
   * the copy the daemon loaded at startup while the stored secret has moved on.
   * Carried so a report cannot say "from the keychain" about a value no request
   * is actually using — the same flag the resolver returns.
   */
  stale?: boolean;
}

/**
 * WHERE the credential a set of profiles bills is present — the report-side
 * twin of {@link resolveProfileCredential}, in the same order (environment →
 * store → agent key file), answering without ever reading a secret out of an
 * OS keychain.
 *
 * Why a twin rather than the resolver: the resolver opens the store's backend,
 * and on macOS a Keychain read can block on an unlock prompt. The daemon
 * answers `lazy doctor`'s credential-state RPC from a process that usually has
 * no GUI session to answer one, so presence comes from the non-secret index —
 * the line the daemon credential gate already draws (see
 * ../credentials/store.ts). The agent key file is a plain 0600 file and is
 * consulted under the resolver's own rule: only when the credential IS the
 * provider that file was written under, for one of the harnesses billing it.
 *
 * Keep the two in step. A source this reports must be one the resolver would
 * hand a launch, or doctor prints a checkmark for a key no turn can use — and
 * the reverse would report a working setup as broken.
 *
 * @param harnesses - The harnesses of the profiles billing this credential;
 *                    decides whether the agent key file is consulted at all.
 */
export async function locateProfileCredential(
  lazyRoot: string,
  credential: CredentialName,
  harnesses: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialLocation> {
  if (credential === NO_CREDENTIAL) return { present: false, source: null, via: null, kind: null };

  const located = await locateCredential(lazyRoot, credential, env);
  if (located) {
    // The kind comes from the store's non-secret index, so reporting it still
    // opens no backend. An env-sourced credential has no kind to report: the
    // variable carries a bare value and says nothing about its form.
    //
    // ...except on the DEGRADED path, where the resolver has already said which
    // kind is being served and the index describes a record the backend will
    // not hand over. Reading the index unconditionally there printed the new
    // entry's kind beside "store UNREADABLE" — a report describing one
    // credential while every request spends another.
    if (located.stale) return { present: true, ...located, kind: located.kind ?? null };
    const stored = located.source === 'store' ? await credentialPresence(lazyRoot, credential) : null;
    return { present: true, ...located, kind: stored?.kind ?? null };
  }

  const keyed = harnesses.filter((harness) => agentCredentialProvider(harness) === credential);
  if (keyed.length > 0) {
    const file = await readCredentialsFile(lazyRoot);
    if (keyed.some((harness) => file[harness]?.api_key)) {
      // That file holds API keys by construction — `lazy system agent set-key`
      // is the only writer, and it refuses anything else.
      return { present: true, source: 'file', via: credentialsPath(lazyRoot), kind: 'api-key' };
    }
  }
  return { present: false, source: null, via: null, kind: null };
}

/**
 * The OTHER way to pay for this harness, when the profile's own slot is empty —
 * or '' when there is no other way.
 *
 * Only codex has two: a metered OpenAI API key, and a ChatGPT Plus/Pro
 * subscription. They are different credentials at different hosts, so a launch
 * refusal that named only the slot the profile happens to point at would tell a
 * user with a live ChatGPT subscription to go and buy API credit. Appended to
 * that refusal rather than folded into it, because the slot's own remedy is
 * still the direct answer: this is the alternative, not a correction.
 */
export function alternativeCredentialHint(harness: string, credential: string): string {
  if (harness !== 'codex' || credential === 'chatgpt') return '';
  return (
    `\n\nOr run this task on a ChatGPT Plus/Pro subscription instead of a metered API key:\n` +
    `  codex login            (or: codex login --device-auth, on a headless host)\n` +
    `  lazy auth import codex-subscription\n` +
    `  lazy start <task> --agent codex-subscription\n` +
    `  # see https://docs.getlazy.dev/credentials`
  );
}
