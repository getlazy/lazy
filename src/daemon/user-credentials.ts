/**
 * Real per-user Anthropic credentials, held by the daemon and by nothing else.
 *
 * WHY THIS EXISTS: with a control plane in front of the daemon (docs/design/
 * lazy-teams.md §3), each human's model spend must be billed to that human's
 * own Anthropic account. The daemon process env holds ONE credential, which is
 * exactly right for a single-user install and useless for a team. So the
 * control plane hands the daemon each member's credential once, over a
 * control-token RPC, and the daemon keeps it.
 *
 * THE INVARIANT THIS FILE PROTECTS: a real credential never leaves this
 * process. It is not written into any container's environment, not into a
 * worktree, and not into the repo. A container gets a session-bound PLACEHOLDER
 * (./session-credentials.ts); the proxy swaps the placeholder for the real
 * value on the way out (src/proxy/server.ts). That is why the file lives in
 * `~/.lazy/daemon/<slug>/`, mode 0600, and never under the project root: task
 * containers bind-mount the repo, so anything under `<project>/.lazy/` is
 * readable by every agent lazy runs.
 *
 * Scope of v1, per §3.2: long-lived credentials only — an OAuth setup-token or
 * an API key. There is no refresh machinery here, deliberately; lazy does not
 * replicate Claude Code's OAuth handshake (the same line the credential gate
 * draws, see ./credential-gate.ts).
 */

import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { canonicalPersonEmail, isPersonEmail } from '../actor-ref';
import { isValidName } from '../config/agent-profiles';
import { getUserCredentialsPath } from './paths';

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
  /**
   * The AGENT PROFILE (`[agents.<name>]`) this credential pays for, or absent
   * for the principal's Claude (Anthropic) credential — the one every record
   * was before profiles had credentials of their own, and still the one that
   * pays an Anthropic-billed profile whose traffic goes to Anthropic itself
   * (./member-credentials.ts owns that rule).
   *
   * Keyed per PROFILE rather than per credential name on purpose: a member's
   * token then only ever reaches the upstream of the profile they connected it
   * for. Keyed by name, an `[agents.x]` block pointing anywhere with the default
   * `anthropic` credential would carry every member's Anthropic token there.
   */
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

interface UserCredentialFile {
  version: 1;
  credentials: UserCredentialRecord[];
}

/** Cached per project root — the launch path reads this on every turn start. */
const cache = new Map<string, UserCredentialFile>();
/** Serializes read-modify-write cycles within this process. */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * The non-email spellings a credential may be keyed by. Kept beside the email
 * form rather than replaced by it: an install that already holds credentials
 * under a control plane's id must not have them become unreachable by an
 * upgrade, and the daemon's own reserved key is not an address.
 *
 * DELIBERATE AND TEMPORARY, and it now has NO PRODUCER LEFT — only records
 * written by an earlier release. The mint takes an `(email, name)` pair by name
 * as of `teams-identity-is-the-token`, and the control plane puts credentials
 * under addresses as of `teams-every-human-action-on-the-users-token`
 * (docs/design/actor-identity-and-remote-clients.md §3.6), so every live token
 * and every new credential identifies its holder by address and a turn is billed
 * to that address.
 *
 * What it survives FOR is the other half of that change: the control plane's
 * re-put also REVOKES the credentials still filed under `user-12`, which are
 * unreachable for anybody (the member is refused with the no-credential marker
 * while a live secret sits under a key nothing will ever ask for again) — and a
 * revoke has to be able to name the key it is removing. Delete this once the
 * re-put has run on the install (`bin/rails user_credentials:reput`, whose
 * ordered place in the upgrade is in lazy-teams/docs/self-host-deploy.md),
 * turning `isValidCredentialKey` into `isPersonEmail` plus the reserved key.
 */
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

function emptyFile(): UserCredentialFile {
  return { version: 1, credentials: [] };
}

async function load(projectRoot: string): Promise<UserCredentialFile> {
  const cached = cache.get(projectRoot);
  if (cached) return cached;

  const path = getUserCredentialsPath(projectRoot);
  let parsed: UserCredentialFile;
  try {
    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw) as Partial<UserCredentialFile>;
    parsed = {
      version: 1,
      credentials: Array.isArray(data.credentials) ? data.credentials : [],
    };
  } catch (err) {
    // A missing file is the normal state of every install that has never had a
    // control plane in front of it. A file that EXISTS but will not parse is a
    // different thing entirely — silently treating it as empty would bill every
    // user's traffic to the daemon's own credential without a word.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      parsed = emptyFile();
    } else {
      throw new Error(
        `Failed to read the per-user credential store at ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  cache.set(projectRoot, parsed);
  return parsed;
}

async function persist(projectRoot: string, file: UserCredentialFile): Promise<void> {
  const path = getUserCredentialsPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  // 0600: real Anthropic credentials. Same posture as the token registry.
  await writeFile(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  cache.set(projectRoot, file);
}

/** Serialize a read-modify-write against the store. */
async function mutate<T>(
  projectRoot: string,
  fn: (file: UserCredentialFile) => Promise<T> | T,
): Promise<T> {
  const run = writeChain.then(async () => {
    const file = await load(projectRoot);
    return fn(file);
  });
  writeChain = run.catch(() => {});
  return run;
}

/** Drop the in-memory cache. Tests, and any process that is not the daemon. */
export function clearUserCredentialCache(): void {
  cache.clear();
}

/**
 * Store (or replace) one principal's real credential.
 *
 * Control-plane only — the RPC layer enforces that (see `requireControlActor`
 * in ./rpc-handlers.ts). Re-putting the same `userId` replaces the credential
 * in place rather than accumulating a second equally-valid secret.
 */
export async function putUserCredential(
  projectRoot: string,
  input: {
    userId: string;
    kind: UserCredentialKind;
    token: string;
    label?: string;
    ownerEmail?: string;
    ownerName?: string;
    /** The agent profile this credential pays for; omitted for the Claude credential. */
    profile?: string;
    /** The endpoint the member was SHOWN, as the control plane sent it — see the record field. Never config. */
    endpoint?: string | null;
    /** True for a credential lazy renews itself; see `pushedDigest`. */
    renewable?: boolean;
    /** Service key, session profile: the holder whose own record pays — see the record field. */
    sameAs?: string;
  },
): Promise<UserCredentialSummary> {
  const userId = canonicalCredentialKey(input.userId);
  const profile = input.profile?.trim() || undefined;
  if (profile !== undefined && !isValidName(profile)) {
    throw new Error(
      `Invalid profile '${input.profile}'. A profile name is lowercase letters, digits, and . _ - ` +
      `(starting with a letter or digit) — the name of an [agents.<name>] block.`,
    );
  }
  if (!isValidCredentialKey(userId)) {
    throw new Error(
      `Invalid userId '${input.userId}'. A credential is keyed by the person's email — ` +
      `the same way the store names people — or by 1-128 characters of letters, digits, ` +
      `'.', '_', ':' or '-' starting with a letter or digit.`,
    );
  }
  if (!USER_CREDENTIAL_KINDS.includes(input.kind)) {
    throw new Error(
      `Invalid credential kind '${input.kind}'. Expected 'oauth' (a \`claude setup-token\` ` +
      `token, sent as Authorization: Bearer) or 'api-key' (an Anthropic API key, sent as x-api-key).`,
    );
  }
  const sameAs = input.sameAs ? canonicalCredentialKey(input.sameAs) : undefined;
  if (sameAs !== undefined && (userId !== SERVICE_CREDENTIAL_USER_ID || !isPersonEmail(sameAs) || !input.profile)) {
    throw new Error(
      `Refusing a credential for '${userId}' that refers to '${input.sameAs}': only the service key's ` +
      `credential for an agent profile may refer to a member's own, by their address.`,
    );
  }
  const token = sameAs !== undefined ? '' : input.token.trim();
  if (!token && sameAs === undefined) {
    throw new Error(`Refusing to store an empty credential for user '${userId}'.`);
  }

  const owner = resolveOwner(userId, input);

  const pushedDigest = input.renewable ? digestOf(token) : undefined;
  const record: UserCredentialRecord = {
    userId,
    kind: input.kind,
    token,
    label: input.label?.trim() || userId,
    ...(owner.email ? { ownerEmail: owner.email } : {}),
    ...(owner.name ? { ownerName: owner.name } : {}),
    ...(profile !== undefined ? { profile, endpoint: input.endpoint ?? null } : {}),
    ...(pushedDigest ? { pushedDigest } : {}),
    ...(sameAs !== undefined ? { sameAs } : {}),
    updatedAt: new Date().toISOString(),
  };

  return mutate(projectRoot, async (file) => {
    const existing = file.credentials.find((c) => sameSlot(c, userId, profile));
    // THE SAME RENEWABLE SECRET, PUSHED AGAIN: keep the renewed one. The
    // original's refresh token is already retired upstream, so storing it
    // again would log the member out on the next renewal.
    const stored = existing && pushedDigest && existing.pushedDigest === pushedDigest && existing.kind === record.kind
      ? { ...record, token: existing.token }
      : record;
    // Both sides canonicalised, so re-putting under a corrected spelling
    // REPLACES a record an earlier daemon stored raw rather than leaving that
    // person with two credentials and no way to tell which one is spent.
    const credentials = file.credentials.filter((c) => !sameSlot(c, userId, profile));
    credentials.push(stored);
    await persist(projectRoot, { version: 1, credentials });
    return summarize(stored);
  });
}

/**
 * Write back a secret lazy RENEWED itself (a rotated ChatGPT session) into an
 * existing record, keeping everything else — above all `pushedDigest`, which
 * is what stops the control plane's next re-push of the original from undoing
 * this.
 *
 * COMPARE-AND-SWAP on `renewedFrom`, the secret the renewal started from: a
 * member may reconnect a NEW session while an old one renews, and writing the
 * old account's renewal over it would keep the new record's digest — so every
 * later re-push would match and the member would stay billed on the login they
 * replaced. False, and nothing written, when the record is gone or no longer
 * holds that secret.
 */
export async function storeRenewedUserCredential(
  projectRoot: string,
  userId: string,
  profile: string | undefined,
  token: string,
  renewedFrom: string,
): Promise<boolean> {
  const key = canonicalCredentialKey(userId);
  return mutate(projectRoot, async (file) => {
    const existing = file.credentials.find((c) => sameSlot(c, key, profile));
    if (!existing || existing.token !== renewedFrom) return false;
    const renewed: UserCredentialRecord = { ...existing, token, updatedAt: new Date().toISOString() };
    const credentials = file.credentials.filter((c) => !sameSlot(c, key, profile));
    credentials.push(renewed);
    await persist(projectRoot, { version: 1, credentials });
    return true;
  });
}

/** One record per (principal, profile); an absent profile is the Claude credential. */
function sameSlot(record: UserCredentialRecord, canonicalUserId: string, profile: string | undefined): boolean {
  return canonicalCredentialKey(record.userId) === canonicalUserId && (record.profile || undefined) === profile;
}

function digestOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Remove a principal's credential — their Claude credential, or with `profile`
 * the one they connected for that agent profile. Returns false when there was
 * none. One slot at a time: taking back a Claude credential must not also take
 * back a key the member connected for some other profile.
 */
export async function revokeUserCredential(
  projectRoot: string,
  userId: string,
  profile?: string,
): Promise<boolean> {
  const key = canonicalCredentialKey(userId);
  const slot = profile?.trim() || undefined;
  return mutate(projectRoot, async (file) => {
    const credentials = file.credentials.filter((c) => !sameSlot(c, key, slot));
    if (credentials.length === file.credentials.length) return false;
    await persist(projectRoot, { version: 1, credentials });
    return true;
  });
}

/**
 * The real credential for a principal, or null. Daemon-internal use only.
 *
 * Without `profile` this is their Claude credential; with it, the one they
 * connected for that profile. Which of the two a TURN spends is not decided
 * here — see ./member-credentials.ts.
 */
export async function getUserCredential(
  projectRoot: string,
  userId: string,
  profile?: string,
): Promise<UserCredentialRecord | null> {
  const file = await load(projectRoot);
  const key = canonicalCredentialKey(userId);
  return file.credentials.find((c) => sameSlot(c, key, profile)) ?? null;
}

/** The project-level service credential for system-initiated turns, or null. */
export async function getServiceCredential(
  projectRoot: string,
): Promise<UserCredentialRecord | null> {
  return getUserCredential(projectRoot, SERVICE_CREDENTIAL_USER_ID);
}

/** Every stored credential, without secrets. */
export async function listUserCredentials(
  projectRoot: string,
): Promise<UserCredentialSummary[]> {
  const file = await load(projectRoot);
  return file.credentials.map(summarize);
}

/**
 * Is this project in TEAM MODE — i.e. has a control plane ever handed the
 * daemon a per-user credential?
 *
 * This one predicate is what keeps every single-user install on exactly the
 * path it was on before this feature existed. No `putUserCredential` call has
 * ever been made → false → the launch path reads the daemon's process env, the
 * proxy forwards auth headers verbatim, and nothing below is reachable.
 *
 * The service credential alone does not count: a project that configured only
 * a service credential has no per-user billing to do.
 */
export async function teamModeEnabled(projectRoot: string): Promise<boolean> {
  const file = await load(projectRoot);
  return file.credentials.some((c) => c.userId !== SERVICE_CREDENTIAL_USER_ID);
}

function summarize(record: UserCredentialRecord): UserCredentialSummary {
  return {
    userId: record.userId,
    kind: record.kind,
    label: record.label,
    ...(record.ownerEmail ? { ownerEmail: record.ownerEmail } : {}),
    ...(record.ownerName ? { ownerName: record.ownerName } : {}),
    ...(record.profile ? { profile: record.profile } : {}),
    updatedAt: record.updatedAt,
  };
}
