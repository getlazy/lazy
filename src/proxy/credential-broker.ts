/**
 * Per-launch PLACEHOLDER credentials.
 *
 * THE BOUNDARY THIS EXISTS FOR: every task container used to receive the user's
 * REAL Anthropic (and Cursor) credential in its environment — visible in
 * `docker run` argv, in the container's `/proc/<pid>/environ`, and to anything
 * the agent chose to run. An agent that exfiltrated it held the human's billing
 * identity, outside lazy entirely.
 *
 * A container now gets a PLACEHOLDER instead: a random token lazy minted for
 * that launch, worthless anywhere but this project's own proxy. The proxy
 * authenticates the placeholder, derives attribution (role, task) from the
 * grant it is bound to, and swaps in the real credential just before forwarding
 * upstream (src/proxy/inject.ts, src/proxy/target-credentials.ts). The real
 * credential never leaves the daemon process.
 *
 * WHY THIS ALSO REPLACES THE ATTRIBUTION HEADERS: `x-lazy-role` /
 * `x-lazy-task-id` were self-reported by the client and therefore advisory — an
 * agent could claim any task's identity in the audit trail. A grant is minted
 * server-side and bound to exactly one identity, so attribution derived from it
 * is evidence rather than a claim. Same upgrade `mcp-tokens.ts` made to the
 * daemon's MCP surface, for the same reason.
 *
 * Where the grants live: `~/.lazy/daemon/<slug>/proxy-tokens.json`, mode 0600 —
 * the daemon's own state directory, never under the project root. That
 * placement is load-bearing and identical to the MCP token registry's: task
 * containers bind-mount the whole repo read-only, so a registry stored in-repo
 * would be readable by every agent it is meant to separate.
 *
 * Restart semantics: grants survive a daemon restart (the registry is on disk
 * and reloaded), so a running container keeps working when the daemon bounces.
 * They do NOT survive the end of the session they belong to — accept / reject /
 * close revoke the task's grants (see revokeTaskCredentialGrants).
 */

import { randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { getProxyTokensPath } from '../daemon/paths';

/** Whose traffic a grant authorises. */
export type GrantRole = 'agent' | 'builder';

/** What a verified placeholder proves about the caller. */
export interface CredentialGrant {
  /** The placeholder value itself — what the client presents. */
  token: string;
  role: GrantRole;
  /** Task the launch belongs to, or null for the taskless builder. */
  taskId: string | null;
  /** Container / session name the grant was minted for — diagnostics only. */
  label: string;
  /**
   * Env var this placeholder occupies in the launched process. Part of the
   * identity: one launch can hold two credentials at once (a cursor task also
   * gets Anthropic creds for its supervisor), and they must be separate
   * placeholders — a single shared value would have to pick one credential
   * shape, and a client that validates its key format would reject the other.
   */
  envKey: string;
  /**
   * Agent profile (`[agents.<name>]`) the launch runs, which is how the proxy
   * decides where to forward this caller's traffic (src/proxy/agent-upstreams.ts).
   *
   * OPTIONAL because the registry on disk outlives a daemon restart, and grants
   * minted before profiles existed have no such field. Declaring it required
   * would be a lie about the data: a legacy grant would read as `undefined`
   * through a `string` type and route by a name nothing configured. Absent means
   * "no profile evidence" and routes to the primary upstream, the same answer as
   * traffic with no grant at all; the identity's next launch mints one that
   * carries the profile.
   */
  profile?: string;
  /**
   * The UUID of the task the launch belongs to — what the proxy matches a
   * team-mode turn's principal by (its live session binding is keyed by it).
   * `taskId` is whatever REFERENCE the launch had to hand (its code, a short
   * id), and a code is mutable and reusable, so it never identifies a turn.
   * Optional: grants minted before it existed carry none, and pay for nothing
   * in team mode until their next launch adds it.
   */
  taskUuid?: string;
  /**
   * The session-binding key a team-mode launch BESIDE a task (a member's
   * builder, a one-shot) is paid through — the proxy bills that binding's owner
   * with their own credential for the grant's profile, exactly as it bills a
   * task turn's principal through `taskUuid`. Absent on every other grant.
   */
  bindingKey?: string;
  /**
   * Source addresses of the container this grant was launched into, when the
   * runner could read them (see {@link pinGrantsToAddresses}). Absent = not
   * pinned, accepted from anywhere.
   */
  boundAddresses?: string[];
  /**
   * Credentials an upstream minted FOR this grant's holder (Cursor's key
   * exchange), each held behind its own placeholder and source digest — see
   * {@link bindDerivedCredentials}. The container only ever sees `placeholder`.
   */
  derived?: Array<{ placeholder: string; real: string; sourceDigest?: string; createdAt: string }>;
  createdAt: string;
}

interface GrantFile {
  version: 1;
  grants: CredentialGrant[];
}

/**
 * Cap on retained BUILDER grants. A builder session has no lifecycle event the
 * daemon can hang revocation on the way a task does (accept/reject/close), so
 * its grants are bounded by a cap instead. Oldest first: a builder session that
 * has been idle longest is the one least likely to still be running. Task
 * grants are not capped — they are revoked explicitly when the task ends, and
 * capping them could silently kill a live long-running task's turn. That is by
 * TASK ID, not by role: a builder-role grant naming a task is revocable and so
 * is excluded from this cap too.
 */
export const MAX_BUILDER_GRANTS = 50;

/**
 * Prefix each placeholder carries, chosen to MIMIC the real credential's shape.
 *
 * Purely a client-compatibility measure: Claude Code has branched on the
 * `sk-ant-oat01-` prefix to decide which auth header to send, so a placeholder
 * that looked nothing like a credential could change the wire shape and break
 * the swap. The proxy never recognises a placeholder by its prefix — it
 * recognises it by LOOKUP (see {@link lookupCredentialGrant}), so a prefix that
 * drifts out of date costs compatibility, never correctness.
 */
const PLACEHOLDER_PREFIXES: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-lazy-',
  ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-lazy-',
  ANTHROPIC_API_KEY: 'sk-ant-api03-lazy-',
  CURSOR_API_KEY: 'key_lazy_',
  // OpenAI keys are `sk-...` / `sk-proj-...`; OpenRouter keys are `sk-or-v1-...`.
  OPENAI_API_KEY: 'sk-proj-lazy-',
  OPENROUTER_API_KEY: 'sk-or-v1-lazy-',
  // Fireworks keys are `fw_...`.
  FIREWORKS_API_KEY: 'fw_lazy_',
};

/** Fallback for an env var lazy has no shape knowledge of. */
const DEFAULT_PLACEHOLDER_PREFIX = 'lazy-placeholder-';

/**
 * Build a placeholder value for the env var it will occupy.
 *
 * The placeholder goes into the SAME env var the real credential would have
 * used, so the client sends the same header it always did and the proxy's swap
 * is a pure substitution rather than a protocol change.
 */
export function placeholderValueFor(envKey: string): string {
  const prefix = PLACEHOLDER_PREFIXES[envKey] ?? DEFAULT_PLACEHOLDER_PREFIX;
  return prefix + randomBytes(24).toString('hex');
}

/**
 * Does this value LOOK like a placeholder lazy minted?
 *
 * Used on exactly one path: deciding whether a credential that failed lookup
 * deserves a 401 ("your placeholder is unknown or revoked") or should simply be
 * forwarded untouched (a real credential, presented by something that is not a
 * placeholder-holding launch — a host process on its own login session).
 *
 * Shape is acceptable HERE and nowhere else. A false negative costs a worse
 * error message; a false positive 401s a request that would have failed
 * upstream anyway. Neither can cause a placeholder to be forwarded as a
 * credential, which is the failure this module actually guards against — that
 * decision is made by {@link lookupCredentialGrant} alone.
 */
export function looksLikeLazyPlaceholder(value: string): boolean {
  if (value.startsWith(DEFAULT_PLACEHOLDER_PREFIX)) return true;
  return Object.values(PLACEHOLDER_PREFIXES).some(prefix => value.startsWith(prefix));
}

/** Cached registry per project root, so the hot verify path does no file I/O. */
const cache = new Map<string, GrantFile>();
/** Serializes read-modify-write cycles within this process. */
let writeChain: Promise<unknown> = Promise.resolve();

/** Read the registry from disk, tolerating a missing file (fresh project). */
async function loadRegistry(projectRoot: string): Promise<GrantFile> {
  const path = getProxyTokensPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, grants: [] };
    }
    throw new Error(
      `Failed to read the proxy credential grant registry ${path}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: GrantFile;
  try {
    parsed = JSON.parse(raw) as GrantFile;
  } catch {
    // Found-but-broken is an error the human must see. Starting from empty
    // would silently 401 every running container's next request, and the
    // message they'd chase would be "authentication", not "corrupt file".
    throw new Error(
      `The proxy credential grant registry ${path} is not valid JSON. ` +
      `Delete the file and restart the daemon to re-mint placeholders — ` +
      `running agents will need their tasks resumed.`,
    );
  }
  if (!parsed || !Array.isArray(parsed.grants)) {
    throw new Error(
      `The proxy credential grant registry ${path} has an unexpected shape ` +
      `(expected { version, grants: [] }).`,
    );
  }
  return { version: 1, grants: parsed.grants };
}

async function getRegistry(projectRoot: string): Promise<GrantFile> {
  const cached = cache.get(projectRoot);
  if (cached) return cached;
  const loaded = await loadRegistry(projectRoot);
  cache.set(projectRoot, loaded);
  return loaded;
}

async function persist(projectRoot: string, registry: GrantFile): Promise<void> {
  const path = getProxyTokensPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  // 0600: a placeholder is a bearer credential for this project's proxy. Same
  // posture as the shared daemon token and the MCP token registry.
  await writeFile(path, JSON.stringify(registry, null, 2), { mode: 0o600 });
  cache.set(projectRoot, registry);
}

/** Run a read-modify-write cycle with no interleaving inside this process. */
async function mutate<T>(
  projectRoot: string,
  fn: (registry: GrantFile) => Promise<T> | T,
): Promise<T> {
  const run = writeChain.then(async () => {
    const registry = await getRegistry(projectRoot);
    return fn(registry);
  });
  // Keep the chain alive even when this link rejects, or one failure would
  // wedge every later mint/revoke behind a permanently rejected promise.
  writeChain = run.catch(() => undefined);
  return run;
}

/**
 * The identity a grant is reused for.
 *
 * The PROFILE participates: two profiles forward to different upstreams with
 * different credentials, so one placeholder covering both would let a request
 * bound for a local Ollama be routed — and paid for — as if it were the other.
 * Switching a task's profile therefore mints a new placeholder rather than
 * re-pointing the old one, which is also what makes a legacy profile-less grant
 * self-heal on the identity's next launch.
 */
function identityKey(
  role: GrantRole,
  taskId: string | null,
  label: string,
  envKey: string,
  profile: string | undefined,
  bindingKey?: string,
): string {
  // The LABEL (the container / run name) is part of an agent grant's identity:
  // a task's work, review and accept-gate containers each run under their own
  // name and must each hold their OWN placeholder, because a grant is pinned to
  // one container's address (pinGrantsToAddresses). The work container's name
  // is stable per task, so work turns still reuse one placeholder.
  const who = role === 'agent' ? `agent:${taskId ?? label}|${label}` : `builder:${label}`;
  // The PAYER is part of a side launch's identity: one-shot labels are shared
  // per project or task, and a grant reused across two launches paid by
  // different people would bill whichever bound it last for both.
  const paidBy = role !== 'agent' && bindingKey ? `|bind:${bindingKey}` : '';
  return `${who}|${envKey}|${profile ?? ''}${paidBy}`;
}

/**
 * Mint (or reuse) the placeholder for one launch identity.
 *
 * Reuse is deliberate and per identity, for the same reason the MCP tokens
 * reuse: a task is unblocked many times and its container is often reused, and
 * the agent inside a live container holds its placeholder in memory. Minting a
 * fresh one per turn would either invalidate a live turn mid-flight or leave a
 * growing pile of equally-valid placeholders for one task.
 *
 * `envKey` only shapes the placeholder's PREFIX (see {@link placeholderValueFor}).
 * A reused grant keeps its original value even if a later launch would have
 * chosen a different prefix — the value in a live container's env is the one
 * that has to keep verifying.
 */
export async function mintCredentialGrant(
  projectRoot: string,
  opts: {
    role: GrantRole; taskId?: string | null; label: string; envKey: string; profile?: string; taskUuid?: string;
    bindingKey?: string;
  },
): Promise<string> {
  const taskId = opts.taskId ?? null;
  return mutate(projectRoot, async registry => {
    const key = identityKey(opts.role, taskId, opts.label, opts.envKey, opts.profile, opts.bindingKey);
    const existing = registry.grants.find(
      g => identityKey(g.role, g.taskId, g.label, g.envKey, g.profile, g.bindingKey) === key,
    );
    if (existing) {
      // Same token — a running container keeps the value in its env — now
      // carrying the task UUID a grant minted before that field lacks.
      if (opts.taskUuid && existing.taskUuid !== opts.taskUuid) {
        existing.taskUuid = opts.taskUuid;
        await persist(projectRoot, registry);
      }
      return existing.token;
    }

    const grant: CredentialGrant = {
      token: placeholderValueFor(opts.envKey),
      role: opts.role,
      taskId,
      label: opts.label,
      envKey: opts.envKey,
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.taskUuid ? { taskUuid: opts.taskUuid } : {}),
      ...(opts.bindingKey ? { bindingKey: opts.bindingKey } : {}),
      createdAt: new Date().toISOString(),
    };
    registry.grants.push(grant);

    // Only TASKLESS builder grants are capped. A builder-role grant that names a
    // task (a task-scoped machine one-shot — see oneshotLaunchIdentity) has a
    // lifecycle event to be revoked on, exactly like an agent grant, so it
    // belongs on the revocation path rather than the eviction path. Counting
    // them here would let a busy project's one-shots push the cap over and evict
    // a live builder session — the one grant the cap exists to protect.
    const builders = registry.grants.filter(g => g.role === 'builder' && !g.taskId);
    if (builders.length > MAX_BUILDER_GRANTS) {
      const drop = new Set(
        [...builders]
          // Never evict the grant we just minted: it is the one session we know
          // for certain is starting right now.
          .filter(g => g.token !== grant.token)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(0, builders.length - MAX_BUILDER_GRANTS)
          .map(g => g.token),
      );
      registry.grants = registry.grants.filter(g => !drop.has(g.token));
    }

    await persist(projectRoot, registry);
    return grant.token;
  });
}

/**
 * Resolve a presented placeholder to the grant it is bound to, or null when it
 * is unknown or revoked.
 *
 * On a cache miss the registry is re-read from disk before answering null: a
 * placeholder minted by another process (a test harness, or a daemon that
 * restarted after this cache was populated) must not be reported as forged.
 */
export async function lookupCredentialGrant(
  projectRoot: string,
  token: string | null | undefined,
): Promise<CredentialGrant | null> {
  if (!token) return null;
  const cached = cache.get(projectRoot);
  const hit = cached?.grants.find(g => g.token === token);
  if (hit) return hit;

  const fresh = await loadRegistry(projectRoot);
  cache.set(projectRoot, fresh);
  return fresh.grants.find(g => g.token === token) ?? null;
}

/**
 * Revoke every grant bound to a task. Called when the task's session ends
 * (accept / reject / close) — after that point its container must not be able
 * to spend the human's credential, and it is being torn down anyway.
 *
 * EVERY grant naming the task, whatever its role. A task's traffic is not only
 * its agent's: a machine one-shot ABOUT the task (an accept-time summary) and a
 * pairing container both mint BUILDER-role grants carrying the task id, and both
 * are as dead as the agent's once the task ends. Filtering on `role === 'agent'`
 * as this once did left those behind as live placeholders with nothing left to
 * revoke them.
 *
 * WHICH IDENTIFIERS: `task.id` is the task's UUID and `task.refs` every
 * reference a launch may have minted under (its code, its short id). Launches
 * mint with `taskId` = the REF they had to hand and `taskUuid` = the UUID, so
 * a revoke by UUID alone matched nothing and every placeholder outlived its
 * task. A grant matches when its `taskUuid` is the UUID, or when its `taskId`
 * is the UUID or one of the refs and it names no OTHER task's UUID — a code is
 * reusable, and a grant carrying a different UUID belongs to that task.
 *
 * Returns the number revoked. Idempotent.
 */
export async function revokeTaskCredentialGrants(
  projectRoot: string,
  task: { id: string; refs?: readonly string[] },
): Promise<number> {
  const refs = new Set([task.id, ...(task.refs ?? [])].filter(Boolean));
  const belongs = (g: CredentialGrant): boolean =>
    g.taskUuid === task.id ||
    (g.taskId !== null && refs.has(g.taskId) && (!g.taskUuid || g.taskUuid === task.id));
  return mutate(projectRoot, async registry => {
    const before = registry.grants.length;
    registry.grants = registry.grants.filter(g => !belongs(g));
    const removed = before - registry.grants.length;
    if (removed > 0) await persist(projectRoot, registry);
    return removed;
  });
}

/**
 * Pin every grant minted for one launch (by its label — the container name) to
 * the network addresses that container has, or clear the pin with `null`.
 *
 * A pinned grant is refused by the proxy from any other source address
 * ({@link grantAcceptsPeer}), so a placeholder that leaks out of its container
 * — into a transcript, a log another task can read — cannot be spent from a
 * sibling container during the owner's live turn.
 *
 * Grants are reused across turns and every turn runs in a fresh container with
 * a fresh address, so a launch CLEARS the pin before `docker run` (the old
 * address is gone, and keeping it would refuse the new container's first
 * request) and pins again once the container is up. Returns how many grants
 * changed.
 */
export async function pinGrantsToAddresses(
  projectRoot: string,
  label: string,
  addresses: readonly string[] | null,
): Promise<number> {
  const pin = addresses && addresses.length > 0 ? [...new Set(addresses)].sort() : null;
  return mutate(projectRoot, async registry => {
    let changed = 0;
    for (const g of registry.grants) {
      if (g.label !== label) continue;
      if (pin) {
        if (JSON.stringify(g.boundAddresses ?? null) === JSON.stringify(pin)) continue;
        g.boundAddresses = pin;
      } else {
        if (!g.boundAddresses) continue;
        delete g.boundAddresses;
      }
      changed++;
    }
    if (changed > 0) await persist(projectRoot, registry);
    return changed;
  });
}

/**
 * May a request from `peerAddress` spend this grant?
 *
 * An unpinned grant answers yes (nothing to check against — Docker Desktop,
 * the host-process runner, a launch whose address could not be read). A
 * pinned one answers yes only from one of its addresses, and NO when the peer
 * is unknown: a pin an unidentifiable caller could pass would pin nothing.
 */
export function grantAcceptsPeer(grant: CredentialGrant, peerAddress: string | null): boolean {
  if (!grant.boundAddresses || grant.boundAddresses.length === 0) return true;
  return peerAddress !== null && grant.boundAddresses.includes(peerAddress);
}

/**
 * Most derived pairs one grant keeps. Each Cursor key exchange (once per
 * launch, again whenever the access token nears expiry) adds one; the newest
 * few cover every token a live container can still be holding.
 */
export const MAX_DERIVED_PER_GRANT = 8;

/** Marker in a derived placeholder (the signature segment of a JWT-shaped one). */
const DERIVED_MARKER = 'lazyd';

/**
 * A placeholder standing in for a credential an UPSTREAM minted for a grant's
 * holder — today the access and refresh tokens Cursor's key exchange returns.
 *
 * A JWT keeps its header and payload and loses its signature: cursor-agent
 * decodes the payload to read `exp` and re-exchanges whenever it cannot, and a
 * JWT whose signature is lazy's random marker verifies nowhere. Anything else
 * becomes an opaque marker value.
 */
export function derivedPlaceholderFor(real: string): string {
  const random = randomBytes(24).toString('hex');
  const parts = real.split('.');
  if (parts.length === 3 && parts[0] && parts[1]) return `${parts[0]}.${parts[1]}.${DERIVED_MARKER}${random}`;
  return `${DERIVED_MARKER}_${random}`;
}

/**
 * Record upstream-minted credentials against the grant whose request minted
 * them, so the proxy can substitute them back on that grant's later requests.
 * Persisted ON the grant: it survives a daemon restart as the grant does, and
 * it is revoked WITH the grant — a derived placeholder dies with its task.
 * Returns false when the grant no longer exists (revoked mid-request); the
 * caller must then hand out nothing.
 */
export async function bindDerivedCredentials(
  projectRoot: string,
  grantToken: string,
  pairs: ReadonlyArray<{ placeholder: string; real: string; sourceDigest?: string }>,
): Promise<boolean> {
  return mutate(projectRoot, async registry => {
    const grant = registry.grants.find(g => g.token === grantToken);
    if (!grant) return false;
    const now = new Date().toISOString();
    grant.derived = [
      ...(grant.derived ?? []),
      ...pairs.map(p => ({ ...p, createdAt: now })),
    ].slice(-MAX_DERIVED_PER_GRANT);
    await persist(projectRoot, registry);
    return true;
  });
}

/**
 * Revoke the grant bound to one builder session, identified by the label it was
 * minted with. Called when the builder's supervisor exits — the human closing
 * the terminal ends the session, and nothing else tells the daemon about it.
 *
 * Returns the number revoked (0 or 1). Idempotent.
 */
export async function revokeBuilderCredentialGrant(
  projectRoot: string,
  label: string,
): Promise<number> {
  return mutate(projectRoot, async registry => {
    const before = registry.grants.length;
    registry.grants = registry.grants.filter(g => !(g.role === 'builder' && g.label === label));
    const removed = before - registry.grants.length;
    if (removed > 0) await persist(projectRoot, registry);
    return removed;
  });
}

/**
 * Revoke every grant paid through the session binding `bindingKey` — a side
 * launch's grants, when its binding is released. Returns how many. Idempotent.
 */
export async function revokeGrantsByBindingKey(projectRoot: string, bindingKey: string): Promise<number> {
  return mutate(projectRoot, async registry => {
    const before = registry.grants.length;
    registry.grants = registry.grants.filter(g => g.bindingKey !== bindingKey);
    const removed = before - registry.grants.length;
    if (removed > 0) await persist(projectRoot, registry);
    return removed;
  });
}

/**
 * Revoke every grant whose label starts with `prefix` — the member
 * containers' grants (`member-terminal:`), whose only other revoke is the
 * container's removal, which a daemon restart interrupts. `keep` names labels
 * left alone: those of member containers the new daemon re-adopted. Returns how many.
 */
export async function revokeGrantsByLabelPrefix(projectRoot: string, prefix: string, keep: ReadonlySet<string> = new Set()): Promise<number> {
  return mutate(projectRoot, async registry => {
    const before = registry.grants.length;
    registry.grants = registry.grants.filter(g => !g.label.startsWith(prefix) || keep.has(g.label));
    const removed = before - registry.grants.length;
    if (removed > 0) await persist(projectRoot, registry);
    return removed;
  });
}

/** Drop the in-process cache. Tests only — the daemon is a single writer. */
export function clearCredentialGrantCache(): void {
  cache.clear();
}

/**
 * Every placeholder value this project's registry holds — for scrubbing them
 * out of text an admin reads (src/daemon/observability-redaction.ts). Values
 * only, never the grants they belong to. Includes each grant's derived pairs,
 * placeholder AND real value: the real one is an upstream-minted session the
 * daemon holds, and must no more appear in that text than the key it came from.
 */
export async function knownPlaceholderValues(projectRoot: string): Promise<string[]> {
  return (await getRegistry(projectRoot)).grants.flatMap(g => [
    g.token,
    ...(g.derived ?? []).flatMap(d => [d.placeholder, d.real]),
  ]);
}

/**
 * The SHAPE of a placeholder lazy mints: one of the known prefixes followed
 * by the 48 hex characters {@link placeholderValueFor} appends. Exact by
 * construction — it is lazy's own format — so a placeholder already revoked
 * (no longer in the registry) is still recognised in old log text.
 */
export const PLACEHOLDER_VALUE_PATTERN = new RegExp(
  `(?:${[...new Set([...Object.values(PLACEHOLDER_PREFIXES), DEFAULT_PLACEHOLDER_PREFIX])]
    .map(p => p.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})[0-9a-f]{48}`,
  'g',
);

/**
 * The shape of a placeholder standing in for an UPSTREAM-minted credential
 * (see {@link derivedPlaceholderFor}): a JWT whose signature is lazy's marker,
 * or the bare marker form.
 */
export const DERIVED_PLACEHOLDER_PATTERN = new RegExp(
  `(?:[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.${DERIVED_MARKER}|${DERIVED_MARKER}_)[0-9a-f]{48}`,
  'g',
);

/**
 * Replace every lazy placeholder SHAPE in `text` — grant placeholders, team
 * session placeholders, derived ones — with a fixed marker. For text a task
 * container can read (the proxy audit log): a placeholder there could be
 * spent by a sibling container while its owner's turn is live. Shape-based so
 * it needs no registry read per record and still catches revoked values.
 */
export function scrubLazyPlaceholders(text: string): string {
  return text
    .replace(PLACEHOLDER_VALUE_PATTERN, '<lazy-placeholder>')
    .replace(SESSION_PLACEHOLDER_PATTERN, '<lazy-placeholder>')
    .replace(DERIVED_PLACEHOLDER_PATTERN, '<lazy-placeholder>');
}

/** Team-mode session placeholder shape (src/daemon/session-credentials.ts). */
const SESSION_PLACEHOLDER_PATTERN = /lazy-sess-[0-9a-f]{64}/g;
