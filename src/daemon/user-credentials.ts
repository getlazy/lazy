/**
 * Daemon-private member + endpoint credential registry. Secrets and the protected
 * migration backup live outside project worktrees. v1 adapters retain the old
 * profile and origin fields while all stored accounts have stable v2 identities.
 */

import { createHash } from 'crypto';
import { mkdir, readFile, open, rename, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { loadConfig } from '../config/loader';
import { agentProfilesFor } from '../config/agent-profiles';
import { endpointRequirementsForProfile, normalizeEndpointScope, consentScopeFor, credentialCompatibleWithEndpoint, credentialConsentedToEndpoint, legacyDefaultEndpointOrigin, type EndpointRequirement } from '../credentials/endpoint-requirements';
import { dirname } from 'path';
import { canonicalPersonEmail, isPersonEmail } from '../actor-ref';
import { isValidName } from '../config/agent-profiles';
import { getUserCredentialsPath } from './paths';
import { isManagedMode } from '../config/managed-mode';

/**
 * Which credential a user holds — and therefore which env var a placeholder for
 * them is injected into, and which request shape Claude Code will emit.
 *
 *   oauth   → CLAUDE_CODE_OAUTH_TOKEN → `Authorization: Bearer …`
 *   api-key → ANTHROPIC_API_KEY       → `x-api-key: …`
 *
 * This mirroring is load-bearing: the proxy replaces the token VALUE inside the
 * header the request arrived with, and never rewrites header shape.
 */
export type UserCredentialKind = 'oauth' | 'api-key';

export const USER_CREDENTIAL_KINDS: readonly UserCredentialKind[] = ['oauth', 'api-key'];

/**
 * The reserved id of the PROJECT-LEVEL service credential (§3.2).
 *
 * System-initiated turns — auto-deliver, sync, anything the daemon starts with
 * no human behind it — have no owner to bill. Attributing them to "the last
 * human who touched the task" was considered and rejected: it silently spends
 * one member's budget on work they did not ask for. So they run on this
 * credential, and when a team-mode project has not configured one, the
 * automation that would have launched the turn is disabled with a stated
 * reason rather than billed to an arbitrary member.
 *
 * The leading `__` cannot collide with anything a real key may be: an email
 * never starts with it, and the non-email form validated below must start with
 * a letter or digit.
 */
export const SERVICE_CREDENTIAL_USER_ID = '__service__';

export interface UserCredentialRecord {
  userId: string;
  kind: UserCredentialKind;
  /** The real secret. Never logged, never returned to a non-daemon caller. */
  token: string;
  /** Human-readable label for operators (an email, a name). Never a secret. */
  label: string;
  /**
   * WHOSE ACCOUNT this credential is, when the key does not say so.
   *
   * A per-user credential is keyed by its owner's address, so it needs none.
   * The SERVICE credential is keyed by a reserved id, and the person behind it
   * — the member whose Anthropic account pays for the project's automations —
   * is the identity every system-initiated write is attributed to
   * (docs/design/actor-identity-and-remote-clients.md §3.3 case 3). The control
   * plane pushes it here, beside the secret it belongs to, because that is the
   * one call that already knows both.
   *
   * ABSENT IS A REAL STATE and means exactly "nobody told us": a store written
   * by an earlier daemon, or a control plane that has not upgraded. Nothing
   * derives one from `label`, which is free text an operator may have set to
   * anything — a system-initiated write then names nobody, as it did before
   * this existed, which is the only honest answer available.
   */
  ownerEmail?: string;
  ownerName?: string;
  /** Legacy adapter label; v2 account identity is endpointId. */
  profile?: string;
  /**
   * The member's CONSENT: the endpoint (origin; '' for the project's default
   * upstream) the control plane SHOWED them for this profile when they
   * connected the credential, sent by the control plane with it and stored as
   * given. Never derived from config — the control plane re-pushes every
   * credential on each provisioning pass, and a stamp taken from config there
   * would re-consent every member to wherever the profile points now. Null:
   * no consent was stated, and the credential pays for nothing. A turn is
   * refused while this differs from where the RUNNING proxy forwards the
   * profile (./member-credentials.ts).
   */
  endpoint?: string | null;
  /**
   * sha256 of the secret exactly as the control plane pushed it. Set only on a
   * credential lazy RENEWS itself (a ChatGPT subscription session): renewal
   * rotates the stored secret, while the control plane re-pushes the ORIGINAL on
   * every provisioning pass — whose refresh token the renewal already retired.
   * A re-push matching this digest is the same credential, not a new one, and
   * must not clobber the renewed secret.
   */
  pushedDigest?: string;
  /**
   * For the SERVICE key on a ChatGPT-session profile only: the address of the
   * service holder whose OWN record pays, instead of a copy of their session.
   * A session renews by rotating its refresh token, so two stored copies of one
   * login each retire the other's; this record holds no secret (`token` is
   * ''), and every use — the holder's turns and the automations — renews and
   * writes back through the holder's one record (./member-credentials.ts).
   */
  sameAs?: string;
  updatedAt: string;
}

/** Everything about a stored credential EXCEPT the secret. Safe to return/log. */
export interface UserCredentialSummary {
  userId: string;
  kind: UserCredentialKind;
  label: string;
  ownerEmail?: string;
  ownerName?: string;
  profile?: string;
  updatedAt: string;
}

export interface EndpointCredentialRecord extends UserCredentialRecord {
  endpointId: string;
  provider: string;
  session: boolean;
}
export interface EndpointCredentialSummary extends UserCredentialSummary {
  endpointId: string;
  origin: string | null;
  provider: string;
  session: boolean;
  state?: 'conflicted';
}
interface UserCredentialFile {
  version: 2;
  billingMode: 'member' | 'solo';
  credentials: EndpointCredentialRecord[];
}
const cache = new Map<string, UserCredentialFile>();
let writeChain: Promise<unknown> = Promise.resolve();

const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Is this a key a credential may be stored under?
 *
 * Per-user credentials are keyed by EMAIL, the same way the store names people
 * (docs/design/actor-identity-and-remote-clients.md §3.8) — one spelling of a
 * person everywhere in the daemon, so the identity on a row and the identity
 * that pays for it are the same string. `SERVICE_CREDENTIAL_USER_ID` stays the
 * one reserved non-email key, and its leading `__` is what keeps it
 * uncollidable: no address starts with it and no id may.
 */
function isValidCredentialKey(userId: string): boolean {
  if (userId === SERVICE_CREDENTIAL_USER_ID) return true;
  return isPersonEmail(userId) || USER_ID_RE.test(userId);
}

/**
 * The canonical form of a credential key — the ONE spelling this registry
 * stores and compares under.
 *
 * THE SAME RULE THE TOKEN REGISTRY USES, and it must stay the same rule. A
 * turn is billed to whatever address the caller's token carries, and that
 * address is canonicalised at the mint (`canonicalPersonEmail`, src/actor-ref.ts).
 * If this side folded differently — or, as it did before, only trimmed — a
 * token minted for `Ada@Example.com` would hold `ada@example.com` while the
 * credential sat under `Ada@Example.com`, unreachable, and that member would be
 * refused with the no-credential marker on their first turn. Two registries
 * keyed by the same identity have to agree by construction; one of them
 * remembering to normalise is not agreement.
 *
 * GUARDED, because not every key is an address. `SERVICE_CREDENTIAL_USER_ID` is
 * the daemon's own reserved key, and the opaque control-plane form
 * (`USER_ID_RE`) is still admitted so that records written by an earlier release
 * can be revoked — see the comment on USER_ID_RE. Neither is a person, so
 * neither is folded: an
 * opaque id may legitimately be case-sensitive, and rewriting one would make an
 * existing credential unreachable, which is the very failure this fixes.
 *
 * Applied at every DOOR (put/revoke/get/check) and on BOTH sides of a lookup,
 * so a record written by an earlier daemon under a raw mixed-case address is
 * still found rather than silently orphaned.
 */
export function canonicalCredentialKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed === SERVICE_CREDENTIAL_USER_ID) return trimmed;
  return isPersonEmail(trimmed) ? canonicalPersonEmail(trimmed) : trimmed;
}

/**
 * The person a stored credential belongs to, validated at the door.
 *
 * TWO KEYS, ONE RULE: a credential names its owner exactly once. A per-user
 * credential is keyed BY that address, so an `ownerEmail` there is either the
 * same fact said twice or a contradiction — and a contradiction stored here
 * would be a second, quieter answer to "whose account is this" than the key
 * everything else reads. It is refused rather than reconciled. Only the
 * reserved service key, which names no person by construction, carries one.
 *
 * A NAME WITHOUT AN ADDRESS is refused for the same reason the store never
 * writes one: a name alone identifies nobody, and every surface resolves a
 * person by address.
 */
function resolveOwner(
  userId: string,
  input: { ownerEmail?: string; ownerName?: string },
): { email?: string; name?: string } {
  const email = input.ownerEmail?.trim();
  const name = input.ownerName?.trim();

  if (!email) {
    if (name) {
      throw new Error(
        `Refusing to store ownerName '${name}' for '${userId}' with no ownerEmail. A person is ` +
        `identified by their address everywhere in the store, so a name on its own names nobody.`,
      );
    }
    return {};
  }

  if (!isPersonEmail(email)) {
    throw new Error(
      `Invalid ownerEmail '${email}'. The owner of a credential is named by their email ` +
      `address — the same way the store names people.`,
    );
  }

  if (userId !== SERVICE_CREDENTIAL_USER_ID) {
    if (canonicalPersonEmail(email) === userId) return {};
    throw new Error(
      `Refusing to store credential '${userId}' with ownerEmail '${email}': a per-user ` +
      `credential is keyed BY its owner's address, so the two cannot disagree. Only the ` +
      `service credential ('${SERVICE_CREDENTIAL_USER_ID}') takes an owner, because its key ` +
      `names no person.`,
    );
  }

  return { email: canonicalPersonEmail(email), ...(name ? { name } : {}) };
}

/** All reads, migrations and mutations share the same serialization. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn);
  // The caller observes rejection; the queue must remain usable afterwards.
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

function validateRecord(value: unknown, version: 1 | 2): asserts value is EndpointCredentialRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Credential entry must be an object.');
  const r = value as EndpointCredentialRecord;
  if (typeof r.userId !== 'string' || !isValidCredentialKey(canonicalCredentialKey(r.userId)) ||
      !USER_CREDENTIAL_KINDS.includes(r.kind) || typeof r.token !== 'string' ||
      typeof r.label !== 'string' || typeof r.updatedAt !== 'string' || !Number.isFinite(Date.parse(r.updatedAt))) {
    throw new Error('Credential entry has invalid identity, kind, secret, label or timestamp.');
  }
  if (r.profile !== undefined && (typeof r.profile !== 'string' || !isValidName(r.profile))) throw new Error('Invalid legacy profile.');
  if (r.endpoint !== undefined && r.endpoint !== null && typeof r.endpoint !== 'string') throw new Error('Invalid origin consent.');
  if (r.endpoint) normalizeEndpointScope(r.endpoint);
  for (const field of ['ownerEmail', 'ownerName', 'sameAs', 'pushedDigest'] as const) {
    if (r[field] !== undefined && typeof r[field] !== 'string') throw new Error(`Invalid ${field}.`);
  }
  resolveOwner(canonicalCredentialKey(r.userId), r);
  if (r.sameAs !== undefined && (r.userId !== SERVICE_CREDENTIAL_USER_ID || !isPersonEmail(r.sameAs) || (version === 1 && !r.profile))) throw new Error('Invalid service holder reference.');
  if (r.sameAs && r.ownerEmail && canonicalCredentialKey(r.sameAs) !== canonicalCredentialKey(r.ownerEmail)) throw new Error('Service holder reference contradicts ownerEmail.');
  if (!r.token.trim() && !r.sameAs) throw new Error('Empty credential secret.');
  if (r.pushedDigest !== undefined && !/^[a-f0-9]{64}$/.test(r.pushedDigest)) throw new Error('Invalid renewal push digest.');
  if (version === 2 && (!isEndpointIdentity(r.endpointId) || typeof r.provider !== 'string' || !r.provider || typeof r.session !== 'boolean')) throw new Error('Invalid endpoint credential semantics.');
}

export function isEndpointIdentity(value: unknown): value is string {
  return typeof value === 'string' && (isValidName(value) || /^(profile|builtin):[a-z0-9][a-z0-9._-]*$/.test(value));
}

async function legacyRequirement(projectRoot: string, profile?: string): Promise<{ endpointId: string; provider: string; session: boolean }> {
  if (!profile) return { endpointId: 'builtin:anthropic', provider: 'anthropic', session: false };
  const config = await loadConfig(projectRoot);
  const resolved = agentProfilesFor(config).get(profile);
  if (!resolved) return { endpointId: `profile:${profile}`, provider: `legacy:${profile}`, session: false };
  const { endpointId, provider, session } = endpointRequirementsForProfile(resolved, config)[0]!;
  return { endpointId, provider, session };
}

function storedOriginConsent(endpointId: string, origin: string | null): string | null {
  // The PATH is kept: consent names origin + path (normalizeEndpointScope).
  return origin === '' ? legacyDefaultEndpointOrigin(endpointId) ?? '' : origin ? consentScopeFor(origin) : origin;
}

/** Write a private temporary file, fsync it, then replace in one rename. */
async function atomicPrivateWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temp, path); }
  catch (err) {
    await unlink(temp);
    throw new Error(`Failed to replace credential registry at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function persist(projectRoot: string, file: UserCredentialFile): Promise<void> {
  for (const record of file.credentials) validateRecord(record, 2);
  await atomicPrivateWrite(getUserCredentialsPath(projectRoot), JSON.stringify(file, null, 2));
  cache.set(projectRoot, file);
}

async function load(projectRoot: string): Promise<UserCredentialFile> {
  const cached = cache.get(projectRoot);
  if (cached) return cached;
  const path = getUserCredentialsPath(projectRoot);
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Failed to read credential registry at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    // Do not automatically restore the v1 backup: it may contain revoked secrets.
    try {
      await readFile(`${path}.v1-backup`, 'utf8');
      throw new Error(`Credential registry at ${path} is missing but its migration backup exists. Reconcile explicitly; automatic recovery could resurrect revoked credentials.`);
    } catch (backupError) {
      if ((backupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot initialize credential registry: ${backupError instanceof Error ? backupError.message : String(backupError)}`);
    }
    const empty: UserCredentialFile = { version: 2, billingMode: isManagedMode() ? 'member' : 'solo', credentials: [] };
    if (isManagedMode()) await persist(projectRoot, empty);
    return empty;
  }
  try {
    let data;
    try { data = JSON.parse(raw); }
    catch {
      // Bun syntax errors can quote token bytes from the secret-bearing input.
      throw new Error('Malformed registry JSON. Repair the credential registry before retrying.');
    }
    if (!data || ![1, 2].includes(data.version) || !Array.isArray(data.credentials)) throw new Error('Expected version 1 or 2 and a credentials array.');
    for (const record of data.credentials) validateRecord(record, data.version);
    let file: UserCredentialFile;
    if (data.version === 1) {
      const credentials: EndpointCredentialRecord[] = [];
      for (const r of data.credentials as UserCredentialRecord[]) {
        const requirement = await legacyRequirement(projectRoot, r.profile);
        const migrated: EndpointCredentialRecord = {
          ...r, userId: canonicalCredentialKey(r.userId), ...requirement,
          // Only the profile-less historical Claude slot carried implicit Anthropic consent.
          endpoint: storedOriginConsent(requirement.endpointId, r.endpoint === undefined ? r.profile ? null : 'https://api.anthropic.com' : r.endpoint),
          ...(r.ownerEmail ? { ownerEmail: canonicalCredentialKey(r.ownerEmail) } : {}),
          ...(r.sameAs ? { sameAs: canonicalCredentialKey(r.sameAs) } : {}),
        };
        // Coalesce only an identical account AND consent/auth/renewal metadata.
        if (!credentials.some(c => equivalent(c, migrated))) credentials.push(migrated);
      }
      file = { version: 2, billingMode: isManagedMode() || credentials.some(c => c.userId !== SERVICE_CREDENTIAL_USER_ID) ? 'member' : 'solo', credentials };
      for (const r of file.credentials) validateRecord(r, 2);
      const backup = `${path}.v1-backup`;
      try {
        const handle = await open(backup, 'wx', 0o600);
        try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`Could not protect migration backup: ${err instanceof Error ? err.message : String(err)}`);
        throw new Error('A migration backup already exists beside a v1 registry. Reconcile explicitly; this may be an interrupted migration or restored credentials revoked since migration.');
      }
      await persist(projectRoot, file);
    } else {
      if (!['member', 'solo'].includes(data.billingMode)) throw new Error('Credential billing mode is missing or invalid; paid spending is refused.');
      file = data;
      if (isManagedMode() && file.billingMode !== 'member') { file = { ...file, billingMode: 'member' }; await persist(projectRoot, file); }
    }
    cache.set(projectRoot, file);
    return file;
  } catch (err) {
    throw new Error(`Cannot use credential registry at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function equivalent(a: EndpointCredentialRecord, b: EndpointCredentialRecord): boolean {
  return ['userId', 'endpointId', 'token', 'endpoint', 'provider', 'session', 'kind', 'sameAs', 'pushedDigest', 'ownerEmail', 'ownerName', 'label'].every(k => a[k as keyof EndpointCredentialRecord] === b[k as keyof EndpointCredentialRecord]);
}
function sameSlot(record: EndpointCredentialRecord, member: string, endpointId: string): boolean {
  return canonicalCredentialKey(record.userId) === member && record.endpointId === endpointId;
}
function digestOf(secret: string): string { return createHash('sha256').update(secret).digest('hex'); }
export function clearUserCredentialCache(): void { cache.clear(); }

export async function setCredentialBillingMode(projectRoot: string): Promise<void> {
  return serialized(async () => { const file = await load(projectRoot); await persist(projectRoot, { ...file, billingMode: 'member' }); });
}
export async function teamModeEnabled(projectRoot: string): Promise<boolean> {
  return serialized(async () => (await load(projectRoot)).billingMode === 'member');
}

export interface PutEndpointCredentialInput {
  userId: string;
  endpointId: string;
  origin: string | null;
  provider: string;
  session?: boolean;
  kind: UserCredentialKind;
  token: string;
  label?: string;
  ownerEmail?: string;
  ownerName?: string;
  renewable?: boolean;
  sameAs?: string;
  /** Kept only for old callers' summaries. */
  profile?: string;
}

/** External usage-store boundary; defaults to the daemon's durable invalidator. */
export type EndpointUsageInvalidator = (projectRoot: string, member: string, endpointId: string) => Promise<void>;
async function clearUsage(projectRoot: string, member: string, endpointId: string): Promise<void> {
  const module = await import('./usage-readings');
  await module.clearMemberEndpointUsage(projectRoot, member, endpointId);
}

export async function putEndpointCredential(projectRoot: string, input: PutEndpointCredentialInput, invalidate: EndpointUsageInvalidator = clearUsage): Promise<EndpointCredentialSummary> {
  return putCredential(projectRoot, input, invalidate, false);
}

async function putCredential(projectRoot: string, input: PutEndpointCredentialInput, invalidate: EndpointUsageInvalidator, optInMemberBilling: boolean): Promise<EndpointCredentialSummary> {
  const userId = canonicalCredentialKey(input.userId);
  if (!isValidCredentialKey(userId)) throw new Error(`Invalid userId '${input.userId}'.`);
  const owner = resolveOwner(userId, input);
  const sameAs = input.sameAs ? canonicalCredentialKey(input.sameAs) : undefined;
  const token = sameAs ? '' : input.token.trim();
  const record: EndpointCredentialRecord = {
    userId, endpointId: input.endpointId, provider: input.provider, session: input.session ?? false,
    kind: input.kind, token, label: input.label?.trim() || userId,
    endpoint: storedOriginConsent(input.endpointId, input.origin),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(owner.email ? { ownerEmail: owner.email } : {}), ...(owner.name ? { ownerName: owner.name } : {}),
    ...(sameAs ? { sameAs } : {}), ...(input.renewable ? { pushedDigest: digestOf(token) } : {}), updatedAt: new Date().toISOString(),
  };
  validateRecord(record, 2);
  return serialized(async () => {
    const file = await load(projectRoot);
    const entries = file.credentials.filter(c => sameSlot(c, userId, record.endpointId));
    const old = entries.length === 1 ? entries[0] : undefined;
    const samePush = old && record.pushedDigest && old.pushedDigest === record.pushedDigest && old.kind === record.kind && old.provider === record.provider && old.session === record.session;
    const stored = samePush ? { ...record, token: old.token } : record;
    const remaining = file.credentials.filter(c => !sameSlot(c, userId, record.endpointId));
    const changed = entries.length !== 1 || old!.token !== stored.token || old!.endpoint !== stored.endpoint || old!.kind !== stored.kind || old!.provider !== stored.provider || old!.session !== stored.session || old!.sameAs !== stored.sameAs || old!.ownerEmail !== stored.ownerEmail;
    if (changed && userId !== SERVICE_CREDENTIAL_USER_ID) {
      // Detach BEFORE erasing readings. A failed write preserves the old reading;
      // a later failure leaves no spendable slot, including after a restart.
      // Clear first connections too, so re-push recovers a previously failed clear.
      await persist(projectRoot, { ...file, credentials: remaining });
      try { await invalidate(projectRoot, userId, stored.endpointId); }
      catch (err) {
        throw new Error(`Endpoint '${stored.endpointId}' for '${userId}' was disconnected, but its usage reading could not be cleared. Reconnect to retry: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Service records designate a holder; they do not replace the holder's
    // own endpoint account, so changing them must preserve that account's usage.
    // Legacy member opt-in and its validated credential become visible together.
    // Detach/clear failures preserve the old mode; endpoint provisioning never changes it.
    await persist(projectRoot, { ...file, billingMode: optInMemberBilling && userId !== SERVICE_CREDENTIAL_USER_ID ? 'member' : file.billingMode, credentials: [...remaining, stored] });
    return summarize(stored);
  });
}

export async function getEndpointCredential(projectRoot: string, userId: string, endpointId: string): Promise<EndpointCredentialRecord | null> {
  return serialized(async () => {
    const entries = (await load(projectRoot)).credentials.filter(c => sameSlot(c, canonicalCredentialKey(userId), endpointId));
    return entries.length === 1 ? { ...entries[0]! } : null;
  });
}

export type EndpointCredentialState = { state: 'connected' | 'missing' | 'stale' | 'conflicted' | 'none-needed'; detail?: string };
export async function endpointCredentialState(projectRoot: string, userId: string, requirement: EndpointRequirement): Promise<EndpointCredentialState> {
  if (!requirement.kinds.length) return { state: 'none-needed' };
  return serialized(async () => {
    const file = await load(projectRoot);
    let member = canonicalCredentialKey(userId);
    if (member === SERVICE_CREDENTIAL_USER_ID) {
      const service = serviceHolderFromRecords(file.credentials);
      if (service.conflicted) return { state: 'conflicted', detail: 'Service connections name different holders; choose one service holder.' };
      if (!service.holder) return { state: 'missing', detail: 'No service holder is designated.' };
      member = service.holder.email;
    }
    const records = file.credentials.filter(c => sameSlot(c, member, requirement.endpointId));
    if (records.length > 1) return { state: 'conflicted', detail: 'Multiple retained connections require the owner to choose an account.' };
    const record = records[0];
    if (!record) return { state: 'missing' };
    if (!credentialConsentedToEndpoint(record, requirement) || !credentialCompatibleWithEndpoint(record, requirement)) return { state: 'stale', detail: 'The connection does not match this endpoint origin or authentication.' };
    return { state: 'connected' };
  });
}

export async function revokeEndpointCredential(projectRoot: string, userId: string, endpointId: string, invalidate: EndpointUsageInvalidator = clearUsage): Promise<boolean> {
  return serialized(async () => {
    const file = await load(projectRoot);
    const entries = file.credentials.filter(c => sameSlot(c, canonicalCredentialKey(userId), endpointId));
    if (!entries.length) return false;
    await persist(projectRoot, { ...file, credentials: file.credentials.filter(c => !entries.includes(c)) });
    const member = canonicalCredentialKey(userId);
    if (member !== SERVICE_CREDENTIAL_USER_ID) {
      try { await invalidate(projectRoot, member, endpointId); }
      catch (err) {
        throw new Error(`Endpoint '${endpointId}' for '${member}' was revoked, but its usage reading could not be cleared. Reconnect to retry: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return true;
  });
}
export async function storeRenewedEndpointCredential(projectRoot: string, userId: string, endpointId: string, token: string, renewedFrom: string): Promise<boolean> {
  return serialized(async () => {
    const file = await load(projectRoot);
    const entries = file.credentials.filter(c => sameSlot(c, canonicalCredentialKey(userId), endpointId));
    if (entries.length !== 1 || entries[0]!.token !== renewedFrom) return false;
    const old = entries[0]!;
    await persist(projectRoot, { ...file, credentials: file.credentials.map(c => c === old ? { ...c, token, updatedAt: new Date().toISOString() } : c) });
    return true;
  });
}

/** Compatibility adapters: a profile lookup never borrows another endpoint's account. */
export async function putUserCredential(projectRoot: string, input: Omit<PutEndpointCredentialInput, 'endpointId' | 'origin' | 'provider'> & { endpoint?: string | null }): Promise<UserCredentialSummary> {
  if (input.profile && !isValidName(input.profile)) throw new Error(`Invalid profile '${input.profile}'.`);
  const requirement = await legacyRequirement(projectRoot, input.profile);
  return putCredential(projectRoot, { ...input, ...requirement, origin: input.profile ? input.endpoint ?? null : 'https://api.anthropic.com' }, clearUsage, true);
}
export async function getUserCredential(projectRoot: string, userId: string, profile?: string): Promise<UserCredentialRecord | null> {
  const requirement = await legacyRequirement(projectRoot, profile);
  const record = await getEndpointCredential(projectRoot, userId, requirement.endpointId);
  if (record && !profile && (record.endpoint !== 'https://api.anthropic.com' || record.provider !== 'anthropic' || record.session)) return null;
  // New endpoint rows may be served to old profile callers only after checking
  // their actual consent. Translate the old default-origin spelling afterwards.
  if (record && profile && (!record.profile || requirement.endpointId === 'builtin:cursor')) {
    const config = await loadConfig(projectRoot);
    const resolved = agentProfilesFor(config).get(profile);
    const expected = resolved ? endpointRequirementsForProfile(resolved, config)[0] : undefined;
    if (!expected || !credentialConsentedToEndpoint(record, expected) || !credentialCompatibleWithEndpoint(record, expected)) return null;
    return { ...record, profile, endpoint: resolved!.endpoint ? consentScopeFor(resolved!.endpoint) : '' };
  }
  return record;
}
export async function revokeUserCredential(projectRoot: string, userId: string, profile?: string): Promise<boolean> {
  return revokeEndpointCredential(projectRoot, userId, (await legacyRequirement(projectRoot, profile)).endpointId);
}
export async function storeRenewedUserCredential(projectRoot: string, userId: string, profile: string | undefined, token: string, renewedFrom: string): Promise<boolean> {
  return storeRenewedEndpointCredential(projectRoot, userId, (await legacyRequirement(projectRoot, profile)).endpointId, token, renewedFrom);
}
export async function getServiceCredential(projectRoot: string): Promise<UserCredentialRecord | null> { return getUserCredential(projectRoot, SERVICE_CREDENTIAL_USER_ID); }
function serviceHolderFromRecords(credentials: EndpointCredentialRecord[]): {
  holder: { email: string; name?: string } | null;
  conflicted: boolean;
} {
  const records = credentials.filter(c => c.userId === SERVICE_CREDENTIAL_USER_ID && (c.ownerEmail || c.sameAs));
  const holders = new Set(records.map(c => canonicalCredentialKey(c.ownerEmail ?? c.sameAs!)));
  if (holders.size !== 1) return { holder: null, conflicted: holders.size > 1 };
  const record = records[0]!;
  return { holder: { email: canonicalCredentialKey(record.ownerEmail ?? record.sameAs!), ...(record.ownerName ? { name: record.ownerName } : {}) }, conflicted: false };
}
export async function getServiceHolder(projectRoot: string): Promise<{ email: string; name?: string } | null> {
  return serialized(async () => serviceHolderFromRecords((await load(projectRoot)).credentials).holder);
}
/**
 * The service holder as this daemon knows it, and why there is none: the holder
 * is named only by the service records Teams delivered, so "none" means either
 * nothing was delivered or the delivered records name different holders.
 */
export async function getServiceHolderState(projectRoot: string): Promise<{ holder: { email: string; name?: string } | null; conflicted: boolean }> {
  return serialized(async () => serviceHolderFromRecords((await load(projectRoot)).credentials));
}
function summarize(record: EndpointCredentialRecord): EndpointCredentialSummary {
  return {
    userId: record.userId, endpointId: record.endpointId, origin: record.endpoint ?? null,
    provider: record.provider, session: record.session, kind: record.kind, label: record.label,
    ...(record.ownerEmail ? { ownerEmail: record.ownerEmail } : {}),
    ...(record.ownerName ? { ownerName: record.ownerName } : {}),
    ...(record.profile ? { profile: record.profile } : {}), updatedAt: record.updatedAt,
  };
}
export async function listEndpointCredentials(projectRoot: string, userId?: string): Promise<EndpointCredentialSummary[]> {
  return serialized(async () => {
    const records = (await load(projectRoot)).credentials;
    return records.filter(c => userId === undefined || canonicalCredentialKey(userId) === c.userId).map(c => ({ ...summarize(c), ...(records.filter(other => sameSlot(other, c.userId, c.endpointId)).length > 1 ? { state: 'conflicted' as const } : {}) }));
  });
}
export async function listUserCredentials(projectRoot: string): Promise<UserCredentialSummary[]> { return listEndpointCredentials(projectRoot); }
export async function storedUserSecretValues(projectRoot: string): Promise<string[]> {
  return serialized(async () => (await load(projectRoot)).credentials.map(c => c.token).filter(Boolean));
}
