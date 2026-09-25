/**
 * The per-project credential store, keyed by credential NAME.
 *
 * A name is a provider (`anthropic`) or one a user picked (`work-openai`) — see
 * ./providers.ts. Everything here treats it as an opaque account name; only the
 * daemon credential gate cares which of the two it is.
 *
 * Two files, and the split between them is the whole design:
 *
 *   credential-index.json   NON-SECRET. Which credentials exist, of
 *                           which kind, in which backend, when it was written.
 *   <backend>               The secrets themselves — OS keychain, Secret
 *                           Service, or a 0600 file (see ./backends.ts).
 *
 * WHY SPLIT. Reading a secret out of the macOS Keychain can block on a GUI
 * unlock prompt. The daemon credential gate runs on EVERY daemon start,
 * including detached auto-starts with no terminal and no session to answer one,
 * and all it needs to know is whether a credential exists — the same
 * "presence, not validity" line ../daemon/credential-gate.ts already draws.
 * So presence is a plain JSON read that works offline and prompts for nothing,
 * and the secret is touched by the daemon at hydration — and after that only
 * when the INDEX says the entry has changed.
 *
 * That last clause is the whole of `resolveCredential`'s cheap path. Resolution
 * must prefer the store over the daemon's own hydrated copy, or a rotation
 * never takes effect; but the proxy resolves per REQUEST, so "prefer the store"
 * must not mean "open a keychain per request" — a subprocess each time, and a
 * read that can block on an unlock prompt in a daemon with no session to answer
 * one, which is the very thing this split exists to avoid. So a hydrated value
 * carries the index entry it came from (./hydrated-env.ts) and resolution
 * compares the INDEX: unchanged, serve the copy; changed, and only then read the
 * backend. Every write rewrites the entry, so nothing is missed.
 *
 * The index also makes the store SELF-DESCRIBING: `lazy auth list` and
 * `lazy doctor` can say "anthropic, oauth, macOS Keychain, set 3 days ago"
 * without reading a secret to do it.
 *
 * DISAGREEMENT IS AN ERROR, NOT A MISS. If the index says a provider has a
 * credential and the backend does not produce one (a keychain item deleted by
 * hand, a `~/.lazy` restored from a backup without the keyring), the read fails
 * loudly naming both. Returning null there would start a daemon whose every
 * request 401s, with nothing anywhere saying why.
 *
 * ONE EXCEPTION, and it is a deliberate one: a process that has ALREADY
 * hydrated this credential keeps serving its startup copy when the backend
 * later stops producing one, warning once and flagging the result `stale`
 * (`resolveCredential`, `locateCredential`). The trade is between a daemon that
 * MIGHT be spending a revoked credential and one that certainly cannot run a
 * turn, and the likeliest cause by far is neither theft nor revocation but a
 * login keychain or keyring that locked — routine over SSH, on a headless host,
 * and for a daemon started outside a desktop session, which is precisely the
 * environment hydration exists for. A deleted ITEM reads the same from here and
 * is covered by the same exception; a credential the user actually retires is
 * removed through `lazy auth rm`, which clears the INDEX entry, and resolution
 * answers null for that at once. The failure is never silent: it is in the log
 * the first time, and every report says `stale` for as long as it lasts.
 */

import { mkdir, readFile, writeFile, chmod, unlink } from 'fs/promises';
import { dirname } from 'path';
import { logger } from '../utils/logger';
import { getCredentialIndexPath } from '../daemon/paths';
import { loadConfig } from '../config/loader';
import {
  type BackendId,
  type BackendSelection,
  type CredentialBackend,
  backendById,
  resolveBackend,
} from './backends';
import {
  type CredentialKind,
  type CredentialName,
  envVarFor,
  credentialKinds,
  credentialLabel,
  credentialNeedsDaemonRestart,
} from './providers';
import {
  type HydratedFrom,
  clearStoreUnreadable,
  hydratedCopyFrom,
  isStoreUnreadable,
  markHydratedEnvValue,
  markStoreUnreadable,
  matchesHydratedEntry,
  storeUnreadableFor,
} from './hydrated-env';

/**
 * What a credential BINDS this clone to, when it binds it to anything.
 *
 * Today that is exactly one thing: a Teams login (design doc §4.3). The binding
 * IS the login record — not a second file and not a second concept — which is
 * what makes `lazy doctor` and a bare `lazy login` able to say where this clone
 * points without touching a secret, and what makes `lazy logout` unbinding the
 * clone the same act as deleting the credential.
 *
 * Non-secret by construction, because it lives in the index. Anything here is
 * readable by whatever can read the index; a value that must not be is a secret
 * and belongs in the backend.
 */
export interface CredentialBinding {
  /** The install this clone talks to, as the user typed it. */
  teams_url: string;
  /** `team/project` — the qualified slug, chosen explicitly at login. */
  project: string;
  /** The project's id on that install, which outlives a rename of the slug. */
  project_id: string;
  bound_at: string;
}

/** One credential's entry in the non-secret index. Never contains a secret. */
export interface CredentialIndexEntry {
  /**
   * Credential name — a provider (`anthropic`), or a user-chosen one
   * (`work-openai`). The field keeps its original spelling because it is the
   * on-disk format; an index written before named credentials existed reads
   * unchanged.
   */
  provider: CredentialName;
  kind: CredentialKind;
  /** Which backend holds the secret. Recorded so a later config change to
   *  `[credentials] backend` cannot make an existing credential unreadable. */
  backend: BackendId;
  /** Last few characters of the secret, for recognising WHICH key is stored.
   *  Empty for anything short enough that a suffix would be most of it. */
  hint: string;
  updatedAt: string;
  /** Present only for a credential that binds this clone to something. */
  binding?: CredentialBinding;
}

interface CredentialIndexFile {
  version: 1;
  credentials: CredentialIndexEntry[];
}

/** A resolved credential and where it came from. */
export interface ResolvedCredential {
  provider: CredentialName;
  kind: CredentialKind;
  value: string;
  source: 'env' | 'store';
  /** Set only when `source` is 'store'. */
  backend?: BackendId;
  /** The env var this credential is carried in. */
  envVar: string;
  /**
   * DEGRADED: this is the copy hydrated at startup, served because the backend
   * that holds the current secret cannot be read. The account is the store's,
   * but the VALUE may be the superseded one — a report saying plain "from the
   * keychain" here would name a source no request is being served from.
   */
  stale?: boolean;
}

/** Serializes read-modify-write cycles on the index within this process. */
let writeChain: Promise<unknown> = Promise.resolve();

function emptyIndex(): CredentialIndexFile {
  return { version: 1, credentials: [] };
}

/**
 * Last 4 characters, but only for a secret long enough that 4 characters are a
 * negligible fraction of it. A hint that is half the secret is not a hint.
 */
export function credentialHint(secret: string): string {
  return secret.length >= 16 ? secret.slice(-4) : '';
}

/**
 * Read the non-secret index.
 *
 * A missing file is the normal state of every install that has never run
 * `lazy auth set` — that is not an error. A file that EXISTS but will not parse
 * is: treating it as empty would tell a user with a stored credential that they
 * have none, and send them re-entering tokens instead of fixing one line of
 * JSON.
 */
export async function readCredentialIndex(projectRoot: string): Promise<CredentialIndexEntry[]> {
  const path = getCredentialIndexPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `Failed to read the credential index at ${path}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse the credential index at ${path}: ` +
      `${err instanceof Error ? err.message : String(err)}. ` +
      `Fix or delete the file, then re-run \`lazy auth set <provider>\`.`,
    );
  }

  const entries = (parsed as Partial<CredentialIndexFile>)?.credentials;
  if (!Array.isArray(entries)) return [];
  // Keep any entry that HAS a name. This deliberately no longer filters against
  // the provider vocabulary: a name outside it is now a NAMED credential
  // (`lazy auth set work-openai`), and dropping those would make every one of
  // them invisible to `lazy auth list` and unresolvable at request time — a 401
  // with nothing anywhere saying why, which is the failure the module header
  // rejects. A malformed entry is still skipped rather than crashing the read.
  return entries.filter(
    (entry): entry is CredentialIndexEntry =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as CredentialIndexEntry).provider === 'string' &&
      (entry as CredentialIndexEntry).provider.length > 0,
  );
}

/** The index entry for one credential, or null. Never reads a secret. */
export async function credentialPresence(
  projectRoot: string,
  provider: CredentialName,
): Promise<CredentialIndexEntry | null> {
  const entries = await readCredentialIndex(projectRoot);
  return entries.find((entry) => entry.provider === provider) ?? null;
}

async function writeIndex(projectRoot: string, entries: CredentialIndexEntry[]): Promise<void> {
  const path = getCredentialIndexPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const file: CredentialIndexFile = { version: 1, credentials: entries };
  // No secret in here, but it still describes the shape of a user's setup —
  // same 0600 posture as everything else in the daemon dir.
  await writeFile(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Serialize a read-modify-write against the index. */
async function mutateIndex<T>(
  projectRoot: string,
  fn: (entries: CredentialIndexEntry[]) => Promise<T> | T,
): Promise<T> {
  const run = writeChain.then(async () => fn(await readCredentialIndex(projectRoot)));
  writeChain = run.catch(() => {});
  return run;
}

/**
 * Which backend `[credentials] backend` selects for this project.
 *
 * Loaded lazily and only when a SECRET is being written or read — the presence
 * path never needs it, which is what keeps the gate free of config-dependent
 * failure modes it cannot act on.
 */
async function backendFor(
  projectRoot: string,
  selection?: BackendSelection,
): Promise<CredentialBackend> {
  if (selection) return resolveBackend(selection);
  const config = await loadConfig(projectRoot);
  return resolveBackend(config.credentials.backend);
}

/**
 * Store a credential for a provider, replacing any existing one.
 *
 * WRITE-THEN-VERIFY: the value is read back out of the backend before the index
 * records it. An OS keychain has several ways to accept a write and not serve it
 * back later (an ACL, a locked or non-default keyring), and every one of them
 * would otherwise surface hours later as a daemon that will not start. The cost
 * is one extra subprocess on a command a human runs by hand.
 */
export async function setCredential(
  projectRoot: string,
  input: { provider: CredentialName; kind: CredentialKind; secret: string; binding?: CredentialBinding },
  selection?: BackendSelection,
): Promise<CredentialIndexEntry> {
  const secret = input.secret.trim();
  if (!secret) {
    throw new Error(`Refusing to store an empty ${credentialLabel(input.provider)} credential.`);
  }
  // A newline inside the secret is rejected HERE, at the single write funnel,
  // rather than escaped in each backend. `security -i` reads COMMAND LINES from
  // stdin, so an embedded newline would end lazy's line and start a second
  // command of the attacker's choosing; and a credential containing a line
  // break is not a credential any provider issues. Both input paths (masked
  // prompt, piped stdin) are single-line today, so this is a closed door rather
  // than a fixed break — but a backend that quotes only quotes and backslashes
  // must never be the only thing standing between a pasted value and a shell.
  if (/[\r\n]/.test(secret)) {
    throw new Error(
      `Refusing to store a ${credentialLabel(input.provider)} credential containing a line break. ` +
      `No provider issues one, and it cannot be passed to the OS credential tools safely. ` +
      `Check what you pasted or piped in.`,
    );
  }
  if (!envVarFor(input.provider, input.kind)) {
    throw new Error(
      `${credentialLabel(input.provider)} has no '${input.kind}' credential form. ` +
      `Nothing would be able to use it.`,
    );
  }

  const backend = await backendFor(projectRoot, selection);
  await backend.set(projectRoot, input.provider, secret);

  const readBack = await backend.get(projectRoot, input.provider);
  if (readBack !== secret) {
    // DO NOT LEAVE THE BAD VALUE BEHIND. Write-then-verify keeps the INDEX
    // honest, but whatever the backend did accept is still sitting there — and
    // a partial write is not inert: one truncated ChatGPT session outlived the
    // command that wrote it and later 401'd every turn with "Unterminated
    // string", because an index entry from an earlier, good write still pointed
    // at it. Removing it turns that into the store's own loud "index says
    // stored, backend has nothing" error, which names the remedy.
    //
    // Best-effort by design: the failure may be a locked keychain that accepted
    // nothing, where this removes nothing and the throw below is the whole
    // answer. A cleanup that cannot run must not replace the real error.
    await backend.remove(projectRoot, input.provider).catch(() => {});
    throw new Error(
      `Stored the ${credentialLabel(input.provider)} credential in the ${backend.id} backend, but ` +
      `reading it straight back ${readBack === null ? 'found nothing' : 'returned a different value'}. ` +
      `The credential has NOT been recorded, because a daemon started against it would fail to ` +
      `authenticate with no explanation. Try \`[credentials] backend = "file"\` in lazy.toml, or ` +
      `keep using the ${envVarFor(input.provider, input.kind)} environment variable.`,
    );
  }

  return mutateIndex(projectRoot, async (entries) => {
    const previous = entries.find((e) => e.provider === input.provider);
    const entry: CredentialIndexEntry = {
      provider: input.provider,
      kind: input.kind,
      backend: backend.id,
      hint: credentialHint(secret),
      updatedAt: nextUpdatedAt(previous?.updatedAt),
      ...(input.binding ? { binding: input.binding } : {}),
    };
    await writeIndex(projectRoot, [...entries.filter((e) => e.provider !== input.provider), entry]);
    return entry;
  });
}

/**
 * A timestamp strictly later than the entry being replaced.
 *
 * Every write must MOVE the index entry: a daemon detects a rotation by
 * comparing the entry it hydrated from against the current one
 * (`matchesHydratedEntry`), and that tuple is only updatedAt, a 4-character
 * hint, kind and backend. Two writes in the same millisecond of secrets sharing
 * their last four characters would otherwise leave an identical entry, and the
 * daemon would keep serving the replaced secret with nothing saying why.
 */
function nextUpdatedAt(previous: string | undefined): string {
  const now = Date.now();
  const prev = previous ? Date.parse(previous) : NaN;
  return new Date(Number.isNaN(prev) || now > prev ? now : prev + 1).toISOString();
}

/**
 * Read a provider's stored secret, or null when the store holds none.
 *
 * The secret is read from the backend the INDEX records, not from whichever
 * backend the current config selects: changing `[credentials] backend` must not
 * make a credential that is sitting in the keychain invisible.
 */
export async function getStoredCredential(
  projectRoot: string,
  provider: CredentialName,
): Promise<{ value: string; kind: CredentialKind; backend: BackendId } | null> {
  const entry = await credentialPresence(projectRoot, provider);
  if (!entry) return null;

  const backend = backendById(entry.backend);
  const value = await backend.get(projectRoot, provider);
  if (value === null) {
    throw new Error(
      `The credential index says a ${credentialLabel(provider)} credential is stored in the ` +
      `${entry.backend} backend, but the backend did not return one.\n` +
      `  Either the store is LOCKED — a login keychain or keyring is not unlocked in this ` +
      `session, which is the usual answer over SSH, on a headless host, or for a daemon ` +
      `started outside a desktop login — or the item is GONE (a keychain edit, a home ` +
      `directory restored without its keyring).\n` +
      `  If it is locked, unlock it and retry: \`security unlock-keychain\` on macOS, or start ` +
      `a keyring for the session on Linux.\n` +
      `  If it is gone, re-store it with \`lazy auth set ${provider}\`, or drop the stale record ` +
      `with \`lazy auth rm ${provider}\`.`,
    );
  }
  return { value, kind: entry.kind, backend: entry.backend };
}

/**
 * Remove a backend item that the INDEX does not know about, if one is there.
 *
 * An orphan is what a failed write leaves: the secret reached the backend and
 * the index entry was never made, so no lazy command can name it any more —
 * `lazy auth rm` resolves through the index and finds nothing to do. Recovering
 * one used to mean `security delete-generic-password` by hand.
 *
 * REFUSES TO TOUCH A REAL CREDENTIAL. An index entry means a user stored this
 * deliberately, and nothing here may delete that; only the caller's own write
 * path uses this, for the name it is writing THROUGH (`lazy auth import
 * codex-subscription` storing into `chatgpt` cleans up a stale item under
 * `codex-subscription`). Best-effort and quiet: a backend that cannot answer is
 * not a reason to fail a write that otherwise worked.
 *
 * @returns true when an orphan was actually removed
 */
export async function purgeOrphanCredential(
  projectRoot: string,
  name: CredentialName,
): Promise<boolean> {
  if (await credentialPresence(projectRoot, name)) return false;
  try {
    const backend = await backendFor(projectRoot);
    return await backend.remove(projectRoot, name);
  } catch {
    // The backend is unavailable or the config will not load. Nothing is lost:
    // an orphan costs a stale item, and the caller's real work has succeeded.
    return false;
  }
}

/** Remove a provider's credential from both the backend and the index. */
export async function deleteCredential(projectRoot: string, provider: CredentialName): Promise<boolean> {
  const entry = await credentialPresence(projectRoot, provider);
  if (!entry) return false;

  // Remove the secret first. If the index write failed after the backend
  // removal we would be left with a stale index entry, which reads as a loud
  // error; the reverse order would leave an orphaned live secret nothing
  // mentions, which is worse.
  await backendById(entry.backend).remove(projectRoot, provider);

  return mutateIndex(projectRoot, async (entries) => {
    const remaining = entries.filter((e) => e.provider !== provider);
    if (remaining.length === 0) {
      // Leave no empty index behind — `lazy auth list` should describe a fresh
      // project and a fully-cleared one identically.
      await unlink(getCredentialIndexPath(projectRoot)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
    } else {
      await writeIndex(projectRoot, remaining);
    }
    return true;
  });
}

/** A usable value found in the environment, with where it came from. */
interface EnvCredential {
  envVar: string;
  kind: CredentialKind;
  value: string;
  /** The index entry this process hydrated it from, or null for a user export. */
  hydratedFrom: HydratedFrom | null;
}

/**
 * The environment value that OUTRANKS the store for this name, if any.
 *
 * A hydrated copy does not: it is this process's own reflection of the store
 * (see ./hydrated-env.ts), so counting it as a user export is what let a
 * startup-time copy shadow every later `lazy auth set`. A genuine export of a
 * LATER kind still wins over a hydrated earlier one, which is why this scans
 * every kind instead of stopping at the first value it sees.
 *
 * ONE CREDENTIAL IS EXEMPT, and for it the old rule is the accurate one. Where
 * `credentialNeedsDaemonRestart` holds — the Anthropic credential — the running
 * daemon does not resolve through here at all: `getAuthEnvVars` hands the proxy
 * and every launch the value out of the daemon's OWN ENVIRONMENT, so after
 * `lazy auth set anthropic` the startup copy really is what requests spend
 * until a restart. Preferring the store for it would not change one request; it
 * would only make `lazy doctor` and `getCredentialState` describe the new index
 * entry — including its `kind`, which is how a user tells a subscription from
 * metered credit — while the daemon went on billing the old one. Reporting and
 * serving must not diverge, so for that credential a hydrated copy stays the
 * env value it is.
 */
function envCredentialFor(
  provider: CredentialName,
  env: NodeJS.ProcessEnv,
): EnvCredential | null {
  const daemonEnvIsTruth = credentialNeedsDaemonRestart(provider);
  let hydratedHit: EnvCredential | null = null;
  for (const kind of credentialKinds(provider)) {
    const envVar = envVarFor(provider, kind);
    if (!envVar) continue;
    const value = env[envVar];
    if (!value || !value.trim()) continue;
    const from = daemonEnvIsTruth ? null : hydratedCopyFrom(provider, envVar, value);
    if (!from) return { envVar, kind, value, hydratedFrom: null };
    hydratedHit ??= { envVar, kind, value, hydratedFrom: from };
  }
  return hydratedHit;
}

/**
 * Serve the hydrated copy, described by the record the VALUE came from.
 *
 * On the normal path that is the current index entry — the copy IS the stored
 * credential, and no backend needs opening. On the STALE path it is the entry
 * the value was hydrated from, never the newer one the backend will not hand
 * over: reporting the new entry's `kind` beside an old secret is not a cosmetic
 * slip, because the proxy picks its auth header FROM the kind
 * (`anthropicPlacementForKind`), so an api-key would go out as
 * `Authorization: Bearer` and 401 with nothing at either end saying why.
 */
function servedFromHydrated(
  provider: CredentialName,
  hydrated: EnvCredential,
  describedBy: { kind: CredentialKind; backend: BackendId },
  stale = false,
): ResolvedCredential {
  return {
    provider,
    kind: describedBy.kind,
    value: hydrated.value,
    source: 'store',
    backend: describedBy.backend,
    envVar: hydrated.envVar,
    ...(stale ? { stale: true } : {}),
  };
}

/**
 * Adopt a rotated secret as this process's hydrated copy: into the environment,
 * and re-marked with the entry it came from.
 *
 * WITHOUT THIS THE CHEAP PATH IS A ONE-SHOT. The mark would still carry the
 * pre-rotation entry while the index carried the new one, so every later
 * comparison would fail and every later resolve would open the backend — one
 * `security` / `secret-tool` subprocess PER PROXY REQUEST for the rest of the
 * daemon's life, which is exactly the unlock-prompt-on-the-hot-path hazard the
 * index comparison exists to remove. One rotation would have undone it
 * permanently.
 *
 * The old variable is cleared when the rotation changed KIND. It would
 * otherwise keep a retired secret in the environment under a name the new mark
 * no longer covers — and an unmarked env value is read as the user's own
 * export, which outranks everything.
 */
function adoptRotated(
  provider: CredentialName,
  previous: EnvCredential,
  entry: CredentialIndexEntry,
  rotated: ResolvedCredential,
  env: NodeJS.ProcessEnv,
): void {
  env[rotated.envVar] = rotated.value;
  if (previous.envVar !== rotated.envVar) delete env[previous.envVar];
  markHydratedEnvValue(provider, rotated.envVar, rotated.value, {
    updatedAt: entry.updatedAt,
    hint: entry.hint,
    kind: entry.kind,
    backend: entry.backend,
  });
}

/**
 * Say — once — that the store cannot be read and the startup copy is standing
 * in for it, recording WHICH index entry the read failed on.
 *
 * ONCE, because the proxy resolves a credential PER REQUEST: a keychain that
 * locked an hour into a daemon's life would otherwise write this paragraph to
 * the log on every model request. The recorded entry does double duty — it also
 * bounds the RETRIES (see `storeUnreadableFor`), so the same entry is not
 * opened again — and a failure on an entry that has moved since is news, not an
 * echo, as is the first failure after the backend answers again.
 */
function reportUnreadableStore(
  provider: CredentialName,
  failedOn: CredentialIndexEntry,
  err: unknown,
): void {
  const detail = err instanceof Error ? err.message : String(err);
  if (!markStoreUnreadable(provider, failedOn)) {
    logger.debug(`Still cannot read the stored ${credentialLabel(provider)} credential: ${detail}`);
    return;
  }
  logger.warn(
    `Cannot read the stored ${credentialLabel(provider)} credential, so lazy is still using the ` +
    `copy it loaded at startup. The stored one has CHANGED since — it is NOT in use.\n${detail}`,
  );
}

/**
 * The credential a process should USE for a provider: environment first, store
 * second.
 *
 * ENV WINS, and that is the migration story. Every setup that exported
 * CLAUDE_CODE_OAUTH_TOKEN before this feature existed behaves exactly as it did,
 * and a one-off `ANTHROPIC_API_KEY=… lazy …` still overrides a stored
 * credential the way a user would expect an env var to.
 *
 * THE DAEMON'S OWN HYDRATED COPY IS NOT AN EXPORT. It is a reflection of the
 * store made at startup, so it never outranks the store it came from — that is
 * what makes `lazy auth set` take effect on the next turn always, rather than
 * only when the daemon happened to start with nothing stored under that name.
 * Except for the one credential the daemon serves straight out of its own
 * environment (`credentialNeedsDaemonRestart`), where the startup copy IS what
 * requests spend until a restart and saying anything else would make the
 * reports lie: see {@link envCredentialFor}.
 *
 * WHICH IS SETTLED FROM THE INDEX, NOT THE BACKEND. A hydrated copy carries the
 * index entry it came from (./hydrated-env.ts), so the question "is the store
 * still holding what I hydrated?" is a plain JSON read: same entry, serve the
 * copy; entry rewritten or gone, go to the backend. That matters twice over.
 * The proxy resolves per REQUEST, so reaching for the backend unconditionally
 * would mean a `security` / `secret-tool` subprocess on every model request —
 * and worse, a keychain read can block on an unlock prompt in a daemon with no
 * session to answer one, which is the whole reason this module keeps the secret
 * off that path (see the header). Neither cost buys anything: the index is
 * rewritten by every write, so comparing it detects a rotation just as surely.
 *
 * A hydrated value is not a source of its own: when the index no longer holds
 * the credential (`lazy auth rm`), this answers null rather than serving a copy
 * of the record the user just removed.
 *
 * ...but an index that still names a credential whose backend has stopped
 * ANSWERING is a different thing again, and there the hydrated copy stands in,
 * flagged `stale` and said out loud. See the header's "DISAGREEMENT IS AN
 * ERROR" exception.
 */
export async function resolveCredential(
  projectRoot: string,
  provider: CredentialName,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedCredential | null> {
  const fromEnv = envCredentialFor(provider, env);
  if (fromEnv && !fromEnv.hydratedFrom) {
    return { provider, kind: fromEnv.kind, value: fromEnv.value, source: 'env', envVar: fromEnv.envVar };
  }

  if (fromEnv?.hydratedFrom) {
    const entry = await credentialPresence(projectRoot, provider);
    if (!entry) return null;
    if (matchesHydratedEntry(fromEnv.hydratedFrom, entry)) {
      clearStoreUnreadable(provider);
      return servedFromHydrated(provider, fromEnv, entry);
    }
    // ALREADY FAILED ON THIS ENTRY: serve the copy without opening anything.
    // The index stays moved for as long as the store is unreadable, so without
    // this the "entry changed" branch would be taken by every request — the
    // keychain subprocess per proxy request, and the unlock prompt at an
    // unattended daemon, that the index comparison exists to prevent. The bound
    // is per ENTRY, so it lifts itself: any later `lazy auth set` moves the
    // entry and is tried at once, as is a restart. A store that merely becomes
    // readable again with nothing else changing is picked up at that next write
    // rather than immediately — the cost of not polling a keychain that prompts.
    if (storeUnreadableFor(provider, entry)) {
      return servedFromHydrated(provider, fromEnv, fromEnv.hydratedFrom, true);
    }

    // The entry moved: a rotation, a re-store, a backend change. Only now is a
    // backend read worth its cost — and if it fails, the startup copy stands in
    // rather than every request for this provider throwing.
    try {
      const rotated = await getStoredCredential(projectRoot, provider);
      clearStoreUnreadable(provider);
      if (!rotated) return null;
      const resolved = resolvedFromStore(provider, rotated);
      // Settle the steady state, or this read repeats on every request.
      adoptRotated(provider, fromEnv, entry, resolved, env);
      return resolved;
    } catch (err) {
      reportUnreadableStore(provider, entry, err);
      // Described by the record the SERVED value came from, not the one the
      // backend would not produce.
      return servedFromHydrated(provider, fromEnv, fromEnv.hydratedFrom, true);
    }
  }

  const stored = await getStoredCredential(projectRoot, provider);
  if (!stored) return null;
  return resolvedFromStore(provider, stored);
}

/** A secret read straight out of the backend, as a resolved credential. */
function resolvedFromStore(
  provider: CredentialName,
  stored: { value: string; kind: CredentialKind; backend: BackendId },
): ResolvedCredential {

  const envVar = envVarFor(provider, stored.kind);
  if (!envVar) {
    throw new Error(
      `The stored ${credentialLabel(provider)} credential has kind '${stored.kind}', which this ` +
      `version of lazy has no environment variable for. Re-store it with \`lazy auth set ${provider}\`.`,
    );
  }
  return {
    provider,
    kind: stored.kind,
    value: stored.value,
    source: 'store',
    backend: stored.backend,
    envVar,
  };
}

/**
 * The env var carrying a usable credential for this name, or null.
 *
 * "Usable" is present AND non-blank — the same rule the daemon gate applies,
 * because `export X=$(cmd)` with a failing `cmd` leaves a set-but-empty var
 * behind, and that must read as absent everywhere or the gate and the reports
 * disagree about the same shell.
 *
 * MECHANICAL: this answers "does the environment CARRY one", counting a copy
 * the daemon hydrated. The precedence question — does that value outrank the
 * store — belongs to {@link resolveCredential} and {@link locateCredential},
 * and `assertStoredCredentialsReachedEnv` depends on this staying the plain
 * question, since checking the environment is the whole point there.
 */
export function credentialInEnv(
  provider: CredentialName,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const kind of credentialKinds(provider)) {
    const envVar = envVarFor(provider, kind);
    if (envVar && env[envVar]?.trim()) return envVar;
  }
  return null;
}

/** Where a credential is available, and the non-secret handle that says so. */
export interface CredentialSource {
  source: 'env' | 'store';
  /** The env var NAME or the store backend id — never the secret. */
  via: string;
  /**
   * DEGRADED, and the same flag {@link ResolvedCredential} carries: the backend
   * cannot be read, so requests are being served the copy loaded at startup
   * while the stored secret has moved on. Reported so a report and a request
   * cannot describe the same credential differently.
   */
  stale?: boolean;
  /**
   * Set only on the stale path: the FORM of the value actually being served,
   * taken from the record it was hydrated from. The current index entry may
   * describe a different kind, and reporting that one beside a served secret of
   * the other is the same reporting-vs-serving divergence `stale` exists to
   * close. Null elsewhere — a caller reads the kind from the index as before.
   */
  kind?: CredentialKind;
}

/**
 * WHERE a credential is available — environment first, then the store's index
 * — without reading any secret. Null when nowhere.
 *
 * The presence question the gate asks, answered with the handle a report can
 * print: `lazy doctor` and the daemon's credential-state RPC say "from
 * ANTHROPIC_API_KEY" or "from the keychain" rather than a bare yes. Reads the
 * index only, never a backend: see the module header on unlock prompts.
 *
 * Same precedence as {@link resolveCredential}, hydrated copies included: a
 * report that called the daemon's own hydrated copy "from OPENAI_API_KEY" would
 * name a source no request is actually billed to. A hydrated copy reports as
 * the STORE, because that is what it is — the stored secret, read once at
 * startup and re-checked against the index on every resolve.
 *
 * ...unless the backend has stopped answering, where this says `stale` for the
 * same reason. Without it a report would print "from the keychain" while every
 * request was being served the startup copy — the divergence
 * `locateProfileCredential`'s "keep the two in step" contract exists to
 * prevent. Still no backend read: the degraded state is what resolution
 * recorded when its own read failed (./hydrated-env.ts).
 */
export async function locateCredential(
  projectRoot: string,
  provider: CredentialName,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialSource | null> {
  const fromEnv = envCredentialFor(provider, env);
  if (fromEnv && !fromEnv.hydratedFrom) return { source: 'env', via: fromEnv.envVar };
  const stored = await credentialPresence(projectRoot, provider);
  if (!stored) return null;
  const degraded = fromEnv?.hydratedFrom && isStoreUnreadable(provider) ? fromEnv.hydratedFrom : null;
  // Degraded: describe the record being SERVED — its backend and its kind —
  // not the newer entry the backend will not hand over.
  if (degraded) return { source: 'store', via: degraded.backend, stale: true, kind: degraded.kind };
  return { source: 'store', via: stored.backend };
}

/**
 * Is a credential AVAILABLE for this provider — from the environment or the
 * store — without reading any secret?
 *
 * This is the gate's question. It deliberately does not touch a backend: see the
 * module header on unlock prompts. One precedence rule with
 * {@link locateCredential}, so the gate and the reports built on it can never
 * disagree about where a credential is.
 */
export async function credentialAvailable(
  projectRoot: string,
  provider: CredentialName,
  env: NodeJS.ProcessEnv = process.env,
): Promise<'env' | 'store' | null> {
  return (await locateCredential(projectRoot, provider, env))?.source ?? null;
}
