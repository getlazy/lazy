import { join } from 'path';
import { unlink } from 'fs/promises';
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

export async function deleteLegacyAgentCredentials(lazyRoot: string): Promise<void> {
  for (const path of [
    join(getDaemonDir(lazyRoot), 'agent-credentials.json'),
    join(lazyRoot, '.lazy', 'agent-credentials.json'),
  ]) {
    try {
      await unlink(path);
      logger.info(`Deleted obsolete plaintext agent credential file: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function resolveAgentApiKey(
  lazyRoot: string,
  agentId: string,
): Promise<{ value: string; source: 'env' | 'store' } | null> {
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

  return null;
}

/**
 * Resolve the credential an agent PROFILE bills, for a harness that carries its
 * own key (codex, cursor). Env var for the credential NAME → the credential
 * store. Null when no source has one.
 *
 * Why not {@link resolveAgentApiKey}: that one answers "the key for this
 * HARNESS", which stops being the same question the moment a profile names its
 * own credential. `[agents.work-codex] credential = "work-openai"` and the
 * built-in `codex` profile both run the codex harness and must resolve
 * DIFFERENT keys — and the proxy already bills them separately (it resolves the
 * profile's slot, never the harness's), so a launch check keyed by harness would
 * pass on a key the request will not be sent with.
 *
 */
export async function resolveProfileCredential(
  lazyRoot: string,
  profile: { name: string; harness: string; credential: CredentialName },
): Promise<{ value: string; source: 'env' | 'store' } | null> {
  // An upstream that authenticates nobody has nothing to resolve. Callers check
  // this too (there is no key to REQUIRE), but answering null here keeps the
  // function total rather than making `none` an error case.
  if (profile.credential === NO_CREDENTIAL) return null;

  const resolved = await resolveCredential(lazyRoot, profile.credential);
  if (resolved) return { value: resolved.value, source: resolved.source };

  return null;
}

/** Where a profile's credential was found — the handle only, never the secret. */
export interface CredentialLocation {
  present: boolean;
  /**
   * `env` — a variable in the inspected environment; `store` — the credential
   * store's index; null when absent.
   */
  source: 'env' | 'store' | null;
  setName?: string;
  /** The env var NAME or the store backend id. Null when absent. */
  via: string | null;
  /**
   * Which FORM of the credential is in effect — `oauth` (a subscription) or
   * `api-key` (a metered key) — or null when that is not knowable.
   *
   * Reported because on a provider that issues both, this is the difference
   * between spending a subscription someone has already paid for and spending
   * metered credit, and nothing else a user checks before launching says which
   * one they are on. Known only for the STORE, whose non-secret index records it;
   * an exported env var carries a bare value with no kind attached. A set
   * credential hydrated into the daemon's environment retains its recorded kind.
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
 * store), answering without ever reading a secret out of an
 * OS keychain.
 *
 * Why a twin rather than the resolver: the resolver opens the store's backend,
 * and on macOS a Keychain read can block on an unlock prompt. The daemon
 * answers `lazy doctor`'s credential-state RPC from a process that usually has
 * no GUI session to answer one, so presence comes from the non-secret index —
 * the line the daemon credential gate already draws.
 *
 * Keep the two in step. A source this reports must be one the resolver would
 * hand a launch, or doctor prints a checkmark for a key no turn can use — and
 * the reverse would report a working setup as broken.
 *
 */
export async function locateProfileCredential(
  lazyRoot: string,
  credential: CredentialName,
  _harnesses: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialLocation> {
  if (credential === NO_CREDENTIAL) return { present: false, source: null, via: null, kind: null };

  const located = await locateCredential(lazyRoot, credential, env);
  if (located) {
    // The kind comes from the store's non-secret index, so reporting it still
    // opens no backend. An env-sourced credential has no kind to report: the
    // variable carries a bare value and says nothing about its form.
    //
    // A degraded copy or a set credential loaded into the daemon's startup
    // environment already names the served kind. The current index can describe
    // a different credential, so never replace the loaded copy's metadata.
    if (located.stale || located.kind) return { present: true, ...located, kind: located.kind ?? null };
    const stored = located.source === 'store' ? await credentialPresence(lazyRoot, credential) : null;
    return { present: true, ...located, kind: stored?.kind ?? null };
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
