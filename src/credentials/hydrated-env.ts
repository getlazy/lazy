/**
 * What this process hydrated out of the credential store, and whether the store
 * has since stopped answering.
 *
 * WHY THIS EXISTS. Credential resolution has one precedence rule — environment
 * first, store second — and it is the migration promise: someone who exported
 * OPENAI_API_KEY before the store existed must keep getting that key. But the
 * daemon hydrates the stored secret into its OWN environment at startup
 * (see ./hydrate.ts), and to a rule that only looks at `env[VAR]` that copy is
 * indistinguishable from the user's export. So a daemon that started with a
 * stored key held it in its environment for its whole life, `lazy auth set
 * openai` afterwards changed nothing, and every turn kept failing on the retired
 * key with nothing saying why — the store had the new key and lost to a copy of
 * itself.
 *
 * Hydration records what it filled here, and resolution consults this to tell
 * the two apart: a value the daemon hydrated is NOT a user export, so the store
 * wins for it, while a real `export OPENAI_API_KEY=…` still outranks everything.
 *
 * THE SNAPSHOT IS WHAT MAKES THAT CHEAP. Each mark carries the INDEX ENTRY the
 * secret was hydrated from — `updatedAt`, `hint`, kind, backend, none of them
 * secret. Resolution compares that against the index, which is a plain JSON
 * read, and only reaches for the backend when the entry has actually changed.
 * Without it, "the store wins" would mean opening an OS keychain on every
 * proxied request: a subprocess per request, and — the reason ./store.ts keeps
 * the secret off that path in the first place — a read that can block on an
 * unlock prompt in a daemon with no session to answer one.
 *
 * MATCHED BY VALUE, not merely by variable name. A mark says "this variable held
 * THIS secret when I hydrated it"; if the value in the environment is anything
 * else, someone else put it there and it is an export like any other. That makes
 * the mark self-invalidating rather than something a later writer has to
 * remember to clear.
 *
 * The secret itself is never kept — only a SHA-256 of it. A digest answers
 * "is this the same string" exactly as well, and a second plaintext copy of
 * every credential living in a module-level map for the life of the daemon is
 * not worth the convenience.
 */

import { createHash } from 'crypto';
import type { CredentialKind, CredentialName } from './providers';
import type { BackendId } from './backends';

/**
 * The non-secret index entry a hydrated value came from.
 *
 * Everything resolution needs to answer "is the store still holding what I
 * hydrated?" without opening a backend. `updatedAt` alone would nearly do it;
 * the rest are carried because a mismatch in any of them means the entry was
 * rewritten, and comparing all four costs nothing.
 */
export interface HydratedFrom {
  updatedAt: string;
  hint: string;
  kind: CredentialKind;
  backend: BackendId;
}

interface Mark {
  envVar: string;
  /** SHA-256 of the value hydration wrote. */
  digest: string;
  from: HydratedFrom;
}

const marks = new Map<CredentialName, Mark>();

/**
 * Credentials whose backend has stopped answering in this process, and the
 * INDEX ENTRY each read failed on.
 *
 * Process state rather than a return value because two different questions need
 * it: resolution, to say once (not per request) that it is serving the startup
 * copy, and {@link locateCredential}'s reports, which never open a backend and
 * would otherwise describe a source no request is actually being served from.
 *
 * The entry is recorded, not just the fact, because the failure has to be
 * BOUNDED. Resolution reaches for the backend when the index has moved since
 * hydration — and on a store that cannot be read, the index stays moved, so
 * every request retried and failed again: a keychain subprocess per proxy
 * request, and an unlock prompt at an unattended daemon, which is the hazard
 * the whole index comparison exists to avoid. A read that failed on a given
 * entry is not retried for that same entry.
 */
const unreadable = new Map<CredentialName, HydratedFrom>();

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Record that this process wrote `value` into `envVar` out of the store, and
 * which index entry it came from.
 *
 * Called only by hydration. One mark per credential: a re-hydration replaces the
 * previous one, because only the current value is the one resolution will see.
 */
export function markHydratedEnvValue(
  provider: CredentialName,
  envVar: string,
  value: string,
  from: HydratedFrom,
): void {
  marks.set(provider, { envVar, digest: digest(value), from });
}

/**
 * The index entry this environment value was hydrated from, or null when the
 * value is not a copy this process made.
 *
 * Null for anything unmarked or changed since — including in every process that
 * never hydrates (the CLI, a container), where the answer is always "it is an
 * export", which is exactly right there.
 */
export function hydratedCopyFrom(
  provider: CredentialName,
  envVar: string,
  value: string | undefined | null,
): HydratedFrom | null {
  if (!value) return null;
  const mark = marks.get(provider);
  if (!mark || mark.envVar !== envVar) return null;
  return mark.digest === digest(value) ? mark.from : null;
}

/** Is this index entry the one a value was hydrated from? */
export function matchesHydratedEntry(
  from: HydratedFrom,
  entry: { updatedAt: string; hint: string; kind: CredentialKind; backend: BackendId },
): boolean {
  return entry.updatedAt === from.updatedAt
    && entry.hint === from.hint
    && entry.kind === from.kind
    && entry.backend === from.backend;
}

/**
 * Note that this credential's backend could not be read, and for WHICH index
 * entry.
 *
 * @returns true when this is news — a first failure, or one on an entry that
 *   has moved since the last. The caller says it in full then, rather than on
 *   every proxied request.
 */
export function markStoreUnreadable(provider: CredentialName, failedOn: HydratedFrom): boolean {
  const known = unreadable.get(provider);
  unreadable.set(provider, failedOn);
  return !known || !matchesHydratedEntry(known, failedOn);
}

/**
 * Has a read for this exact index entry already failed?
 *
 * The bound on retries: true means the backend was opened for this very entry
 * and could not answer, so opening it again this request would cost a
 * subprocess (and possibly an unlock prompt) to learn what is already known.
 * A entry that MOVES again — any later `lazy auth set` — is a different entry
 * and is tried, as is a fresh daemon.
 */
export function storeUnreadableFor(
  provider: CredentialName,
  entry: { updatedAt: string; hint: string; kind: CredentialKind; backend: BackendId },
): boolean {
  const known = unreadable.get(provider);
  return !!known && matchesHydratedEntry(known, entry);
}

/** The backend answered again — a later failure is news, not an echo. */
export function clearStoreUnreadable(provider: CredentialName): void {
  unreadable.delete(provider);
}

/**
 * Is this credential being served from the startup copy because its backend
 * cannot be read? Reports use it to say so instead of naming a store they are
 * not actually serving from.
 */
export function isStoreUnreadable(provider: CredentialName): boolean {
  return unreadable.has(provider);
}

/**
 * Drop every mark and every degraded flag.
 *
 * For tests, which run many hydrations in one process against throwaway
 * environments; no production path forgets a mark, because the daemon hydrates
 * once and lives with the result.
 */
export function forgetHydratedEnvValues(): void {
  marks.clear();
  unreadable.clear();
}
