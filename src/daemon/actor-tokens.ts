/**
 * The daemon's per-identity token registry.
 *
 * THE BOUNDARY THIS EXISTS FOR: the daemon's HTTP surfaces are reachable by
 * anything that can open a socket to it, and a caller's *claim* about who it is
 * (a task id in a URL, an `actor` field in a request body) is data, not
 * evidence. This registry makes identity cryptographic instead: each caller
 * holds its OWN random token, bound server-side to exactly one identity, and
 * the daemon derives who is calling from the token it presents.
 *
 * Four identity kinds share one registry:
 *
 *   - `task`    — one per task session, for `POST /mcp/:taskId/:tool`. The
 *                 `:taskId` segment must agree with the token's task or the
 *                 call is refused (see src/daemon/mcp-routes.ts).
 *   - `builder` — one per builder session, same MCP surface, project-wide.
 *   - `control` — the operator / control plane (Rails). May do anything the
 *                 legacy shared token could, including minting and revoking
 *                 tokens and naming the `actor` recorded on writes.
 *   - `user`    — one human, NAMED THE WAY THE STORE NAMES PEOPLE: an email
 *                 address plus an optional display name. Held by a human's own
 *                 client (CLI/MCP login) or by a control plane acting for one
 *                 member. A user token cannot mint, cannot revoke, and cannot
 *                 claim to be anyone else: its actor comes from the token
 *                 alone, and the `(email, name)` pair it carries is what lands
 *                 in `actor_email` / `actor_name` on every row it writes.
 *
 * The two surfaces do NOT overlap. `/mcp/*` accepts only `task`/`builder`
 * tokens (`lookupMcpIdentity` in ./mcp-tokens.ts returns null for the others),
 * and `/rpc/*` accepts only `control`/`user` tokens plus the legacy shared
 * token (`resolveRpcActor` in ./rpc-auth.ts). Neither can be used on the other,
 * so a compromised agent token buys no RPC access and a user token cannot pose
 * as a task agent.
 *
 * Where the tokens live: `~/.lazy/daemon/<slug>/mcp-tokens.json`, mode 0600 —
 * the daemon's own state directory, alongside the shared `token` file, and
 * NEVER under the project root. That placement is load-bearing: task containers
 * bind-mount the whole repo read-only, so anything under `<project>/.lazy/`
 * is readable by EVERY agent. A per-task token stored there would be trivially
 * stealable by the very agents it is meant to separate.
 *
 * The file name still says "mcp" for a boring reason: renaming it would orphan
 * every token minted by an earlier daemon, silently revoking the MCP tools of
 * every running container at upgrade. The path is a compatibility surface, not
 * a description of the contents.
 *
 * Restart semantics: tokens survive daemon restarts (the registry is on disk and
 * reloaded), matching the shared token's deliberate reuse across restarts — a
 * running container keeps working when the daemon bounces. They do NOT survive
 * the end of the session they belong to: accept/reject/close revoke the task's
 * token (see revokeTaskMcpTokens), a builder revokes its own on exit, and
 * control/user tokens are revoked explicitly by the control plane.
 */

import { randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { canonicalPersonEmail, isPersonEmail } from '../actor-ref';
import { logger } from '../utils/logger';
import { pidExists } from '../utils/process-identity';
import { getMcpTokensPath } from './paths';

/** Who a presented daemon token proves the caller to be. */
export type DaemonIdentity =
  | { kind: 'task'; taskId: string }
  | { kind: 'builder' }
  | { kind: 'control' }
  | { kind: 'user'; email: string; name?: string };

/** The identity kinds accepted on `/rpc/*` (see ./rpc-auth.ts). */
export type ActorIdentity = Extract<DaemonIdentity, { kind: 'control' } | { kind: 'user' }>;

export const DAEMON_IDENTITY_KINDS = ['task', 'builder', 'control', 'user'] as const;
export type DaemonIdentityKind = (typeof DAEMON_IDENTITY_KINDS)[number];

/** One minted token and the identity it is bound to. */
interface DaemonTokenRecord {
  token: string;
  kind: DaemonIdentityKind;
  /** Full task UUID for task tokens; absent otherwise. */
  taskId?: string;
  /** The person's email for user tokens; absent otherwise. */
  email?: string;
  /** The person's display name for user tokens, when the mint carried one. */
  name?: string;
  /**
   * The PRE-EMAIL spelling of a user token's identity — a control plane's
   * opaque id (`user-12`). Only ever READ, never written: see
   * {@link identityOf} for what a record still carrying one resolves to.
   */
  userId?: string;
  /** Container / builder / user-facing name the token was minted for. */
  label: string;
  createdAt: string;
  /**
   * pid of the process that OWNS this session, when it told us. Builder tokens
   * only: `lazy builder` runs on the host, in the same pid namespace as the
   * daemon, and reports its own pid when it asks for a config. Used for exactly
   * one thing — eviction order (see MAX_BUILDER_TOKENS). Never for auth.
   */
  ownerPid?: number;
}

interface DaemonTokenFile {
  version: 1;
  tokens: DaemonTokenRecord[];
}

/**
 * Cap on retained builder tokens. A builder session normally revokes its own
 * token when its supervisor exits (see revokeBuilderMcpToken), but that hook is
 * best-effort: a SIGKILLed `lazy builder`, or one whose daemon was down at exit,
 * leaves its record behind. The cap bounds that residue so the registry cannot
 * grow forever.
 *
 * EVICTION ORDER: residue first, live sessions last. Dropping a builder's token
 * costs it every `lazy_*` tool for the rest of its session, silently — the same
 * failure fix-builder-mcp-token-race removed, reached by a different route. The
 * original policy (oldest-created first) picked the *worst* victim available:
 * the oldest record is the most likely long-running live builder. So a record
 * whose owning process is still alive is evicted only after every record that is
 * not, and within each group the oldest goes first.
 *
 * The liveness signal is the owner's pid (see `ownerPid`), tested with a
 * `kill(pid, 0)` — no file I/O, no daemon→runner dependency, and nothing on the
 * hot verify path, which stays I/O-free. What it costs:
 *   - a record with no pid (minted before this change, or by a caller that sent
 *     none) is "not provably live" and is evicted first, exactly as before;
 *   - a recycled pid makes a dead record look live. That only *demotes* it in
 *     the eviction order — the cap is still a hard cap, so the registry stays
 *     bounded and the failure mode is one extra retained token, not growth.
 * The cap is never exceeded: if every retained builder is live, the oldest live
 * one is still dropped.
 *
 * Deliberately NOT applied to control/user tokens: those are minted and revoked
 * explicitly by the control plane, and silently dropping the oldest would log a
 * long-lived human out with no event anywhere explaining why.
 */
export const MAX_BUILDER_TOKENS = 50;

/**
 * Is this record's owning session provably still running?
 *
 * Deliberately conservative: unknown pid means "not provably live". A false
 * negative only means an already-dead-looking record is evicted sooner, which
 * is the pre-existing behavior for every record.
 */
function isProvablyLive(record: DaemonTokenRecord): boolean {
  return typeof record.ownerPid === 'number' && pidExists(record.ownerPid);
}

/** Cached registry per project root, so the hot verify path does no file I/O. */
const cache = new Map<string, DaemonTokenFile>();
/** Serializes read-modify-write cycles within this process. */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * The registry key for an identity — one live token per identity.
 *
 * `label` participates for builder and control tokens (they have no other
 * discriminator); a task token keys on its task and a user token on its EMAIL,
 * so a re-mint with a different label — or with a corrected display name —
 * still resolves to the same identity rather than minting a second
 * equally-valid credential for the same principal.
 */
function identityKey(identity: DaemonIdentity, label: string): string {
  switch (identity.kind) {
    case 'task': return `task:${identity.taskId}`;
    case 'builder': return `builder:${label}`;
    case 'control': return `control:${label}`;
    case 'user': return `user:${canonicalPersonEmail(identity.email)}`;
  }
}

function recordKey(record: DaemonTokenRecord): string {
  switch (record.kind) {
    case 'task': return `task:${record.taskId}`;
    case 'builder': return `builder:${record.label}`;
    case 'control': return `control:${record.label}`;
    // A pre-email record keys on its opaque id, so re-minting for the same
    // person by EMAIL does not collide with it — it is replaced by the new
    // record only once identityOf can read it as the same address.
    //
    // Canonicalised so a record stored by an earlier daemon under a padded or
    // mixed-case address is recognised as the SAME identity on re-mint, and
    // replaced, rather than leaving that person holding two live tokens.
    case 'user': {
      const stored = record.email ?? record.userId;
      return `user:${stored === undefined ? undefined : canonicalPersonEmail(stored)}`;
    }
  }
}

/** Read the registry from disk, tolerating a missing file (fresh project). */
async function loadRegistry(projectRoot: string): Promise<DaemonTokenFile> {
  const path = getMcpTokensPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, tokens: [] };
    }
    throw new Error(`Failed to read daemon token registry ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: DaemonTokenFile;
  try {
    parsed = JSON.parse(raw) as DaemonTokenFile;
  } catch (err) {
    // A corrupt registry is NOT recoverable by ignoring it: silently starting
    // from empty would revoke every running agent's token with no explanation.
    throw new Error(
      `Daemon MCP token registry ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
      `Delete the file and restart the daemon to re-mint tokens — running agents will need their tasks resumed.`,
    );
  }
  if (!parsed || !Array.isArray(parsed.tokens)) {
    throw new Error(`Daemon MCP token registry ${path} has an unexpected shape (expected { version, tokens: [] }).`);
  }
  return { version: 1, tokens: parsed.tokens };
}

async function getRegistry(projectRoot: string): Promise<DaemonTokenFile> {
  const cached = cache.get(projectRoot);
  if (cached) return cached;
  const loaded = await loadRegistry(projectRoot);
  cache.set(projectRoot, loaded);
  return loaded;
}

async function persist(projectRoot: string, registry: DaemonTokenFile): Promise<void> {
  const path = getMcpTokensPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  // 0600: these are bearer credentials. Same posture as the shared token file.
  await writeFile(path, JSON.stringify(registry, null, 2), { mode: 0o600 });
  cache.set(projectRoot, registry);
}

/** Run a read-modify-write cycle with no interleaving inside this process. */
async function mutate<T>(
  projectRoot: string,
  fn: (registry: DaemonTokenFile) => Promise<T> | T,
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

/** Rebuild the identity a record proves, or null when the record is malformed. */
function identityOf(record: DaemonTokenRecord): DaemonIdentity | null {
  switch (record.kind) {
    case 'task': return record.taskId ? { kind: 'task', taskId: record.taskId } : null;
    case 'builder': return { kind: 'builder' };
    case 'control': return { kind: 'control' };
    case 'user': {
      // A record minted before the mint took `(email, name)` by name carries an
      // opaque `userId` and a free-text `label`. It is honoured only when that
      // id IS an address: the store's person fields promise an email, the
      // migration clears anything that is not one
      // (docs/design/actor-identity-and-remote-clients.md §3.8), and a token
      // resolving to `user-12` would write back exactly the value that
      // migration exists to remove. An unusable record answers null, so the
      // token is refused as unknown — visible, and fixed by re-minting — rather
      // than quietly attributing rows to an id nobody can resolve. The `label`
      // is deliberately NOT adopted as the display name: it names the TOKEN,
      // and the one control plane minting these passed the member's address
      // there (see pinActor in ./rpc-handlers.ts).
      const email = record.email ?? (isPersonEmail(record.userId) ? record.userId : undefined);
      if (!email) {
        // WHY THIS LOGS. The caller gets a bare 401, which is correct — the
        // token proves nothing — but on the wire it is indistinguishable from a
        // random probe, so an operator mid-upgrade sees a member "just not able
        // to log in" with nothing anywhere saying why. This is the same ordered
        // upgrade as the credential re-put: a member hitting one usually hits
        // both, and the remedy is the same one sentence.
        logger.warn(
          `Refusing a user token minted before identity moved to email: registry record '${record.label}' ` +
          `carries '${record.userId ?? '(none)'}', which is not an address, so it names nobody this store can ` +
          `resolve. Re-mint this member's token with 'email' (mintActorToken) — the old token stays refused ` +
          `until you do. See docs/design/actor-identity-and-remote-clients.md §7.1 task 4.`,
        );
        return null;
      }
      return {
        kind: 'user',
        email: canonicalPersonEmail(email),
        ...(record.name ? { name: record.name } : {}),
      };
    }
    default: return null;
  }
}

/** Extra facts about the session a token is being minted for. */
export interface MintDaemonTokenOptions {
  /**
   * pid of the process owning the session, when the caller can name it. Only
   * `lazy builder` does today; it runs on the host beside the daemon. Recorded
   * for eviction ordering alone — it is a CLAIM by an already-authenticated
   * caller, never evidence of identity, and no auth decision reads it.
   */
  ownerPid?: number;
  /** Replace the secret bound to an existing identity (control-plane rotation). */
  rotate?: boolean;
}

/**
 * Mint (or reuse) the token for one identity.
 *
 * Reuse is deliberate and per identity: a task is unblocked many times and its
 * container is often reused, and the MCP server inside a live container holds
 * its token in memory. Minting a fresh token per turn would either invalidate a
 * live session mid-flight or leave a growing pile of equally-valid tokens for
 * one task. One live token per identity is both simpler and a smaller surface.
 *
 * `rotate` forces a fresh secret for the same identity, replacing the previous
 * one atomically — the control plane's key-rotation path. The old token stops
 * working the moment this returns; that is the point of rotating.
 */
export async function mintDaemonToken(
  projectRoot: string,
  identity: DaemonIdentity,
  label: string,
  options: MintDaemonTokenOptions = {},
): Promise<string> {
  return mutate(projectRoot, async registry => {
    const key = identityKey(identity, label);
    const existing = registry.tokens.find(t => recordKey(t) === key);
    if (existing && !options.rotate) {
      let changed = false;

      // Refresh the liveness pid on reuse. The re-issue watcher and the relaunch
      // loop both come back through here for the SAME identity, and a record
      // that predates this field would otherwise never learn its owner — the
      // live session it belongs to would stay first in line for eviction.
      if (options.ownerPid !== undefined && existing.ownerPid !== options.ownerPid) {
        existing.ownerPid = options.ownerPid;
        changed = true;
      }

      // ADOPT A CORRECTED DISPLAY NAME on reuse, for the same reason the pid is
      // refreshed: the identity is the EMAIL, so a re-mint for the same address
      // is the control plane saying "this is who that is now". Without this the
      // re-mint succeeded, reported success, and changed nothing — every row
      // that person went on to write kept the old name, or none, forever, and
      // the only remedy was `rotate: true`, which logs them out mid-session.
      //
      // A wrong name is worse than no name (see pinnedActorOf in
      // ./rpc-handlers.ts), and a STALE one is a wrong one by another route —
      // on rows that are append-only. So a mint carrying NO name clears the
      // stored one rather than leaving the previous value standing: the caller
      // has said this person has no display name, and silently keeping the old
      // one would make "unset the name" impossible to express.
      if (identity.kind === 'user') {
        const nextName = identity.name;
        if (existing.name !== nextName) {
          if (nextName === undefined) delete existing.name;
          else existing.name = nextName;
          changed = true;
        }
        // The label is derived from the pair by the mint handler, so it goes
        // stale in exactly the same way and is what the eviction log names.
        if (existing.label !== label) {
          existing.label = label;
          changed = true;
        }
      }

      if (changed) await persist(projectRoot, registry);
      return existing.token;
    }
    if (existing) registry.tokens = registry.tokens.filter(t => recordKey(t) !== key);

    const record: DaemonTokenRecord = {
      token: randomBytes(32).toString('hex'),
      kind: identity.kind,
      ...(identity.kind === 'task' ? { taskId: identity.taskId } : {}),
      ...(identity.kind === 'user'
        ? { email: identity.email, ...(identity.name ? { name: identity.name } : {}) }
        : {}),
      label,
      createdAt: new Date().toISOString(),
      ...(options.ownerPid !== undefined ? { ownerPid: options.ownerPid } : {}),
    };
    registry.tokens.push(record);

    const builders = registry.tokens.filter(t => t.kind === 'builder');
    if (builders.length > MAX_BUILDER_TOKENS) {
      const byAge = [...builders]
        // Never evict the record we just minted: it is the one session we know
        // for certain is starting right now.
        .filter(t => t.token !== record.token)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const notLive = byAge.filter(t => !isProvablyLive(t));
      const live = byAge.filter(t => isProvablyLive(t));
      const drop = new Set(
        [...notLive, ...live]
          .slice(0, builders.length - MAX_BUILDER_TOKENS)
          .map(t => t.token),
      );
      registry.tokens = registry.tokens.filter(t => !drop.has(t.token));
    }

    await persist(projectRoot, registry);
    return record.token;
  });
}

/**
 * Resolve a presented bearer token to the identity it is bound to, or null when
 * the token is unknown or revoked.
 *
 * On a cache miss the registry is re-read from disk before answering null: a
 * token minted by another process (a test harness, or a daemon that restarted
 * after this cache was populated) must not be reported as forged.
 */
/**
 * Resolve the session label a presented token was minted for, or null when the
 * token is unknown or revoked.
 *
 * Used by builder-only daemon surfaces that need the label to mint a fresh JIT
 * credential grant (GET /builder/launch-env) without exposing the full registry.
 */
export async function lookupDaemonTokenLabel(
  projectRoot: string,
  token: string,
): Promise<string | null> {
  const registry = await getRegistry(projectRoot);
  const record = registry.tokens.find(t => t.token === token);
  return record?.label ?? null;
}

export async function lookupDaemonIdentity(
  projectRoot: string,
  token: string | null | undefined,
): Promise<DaemonIdentity | null> {
  if (!token) return null;
  const found = (registry: DaemonTokenFile): DaemonIdentity | null => {
    const record = registry.tokens.find(t => t.token === token);
    if (!record) return null;
    return identityOf(record);
  };

  const cached = cache.get(projectRoot);
  if (cached) {
    const hit = found(cached);
    if (hit) return hit;
  }

  const fresh = await loadRegistry(projectRoot);
  cache.set(projectRoot, fresh);
  return found(fresh);
}

/**
 * Revoke tokens matching a selector. Returns how many were revoked; idempotent.
 *
 * Revocation MUST happen in the daemon process rather than by editing the
 * registry file: the daemon caches the registry in memory and only re-reads it
 * on a token MISS, so a file edited behind its back would leave the revoked
 * token still accepted.
 */
export async function revokeDaemonTokens(
  projectRoot: string,
  selector:
    | { kind: 'task'; taskId: string }
    | { kind: 'builder'; label: string }
    | { kind: 'control'; label: string }
    | { kind: 'user'; email: string }
    | { token: string },
): Promise<number> {
  return mutate(projectRoot, async registry => {
    const before = registry.tokens.length;
    const matches = (t: DaemonTokenRecord): boolean => {
      if ('token' in selector) return t.token === selector.token;
      switch (selector.kind) {
        case 'task': return t.kind === 'task' && t.taskId === selector.taskId;
        case 'builder': return t.kind === 'builder' && t.label === selector.label;
        case 'control': return t.kind === 'control' && t.label === selector.label;
        // Pre-email records match by the same rule identityOf reads them with:
        // one keyed by an address is the same person as a new one.
        //
        // Both sides are canonicalised rather than compared verbatim. The mint
        // now stores a canonical address, but a record written by an EARLIER
        // daemon was stored raw — and a revoke that missed it would answer
        // "revoked 0", indistinguishable from "already gone", while the token
        // kept working. Canonicalising here reaches those too.
        case 'user': {
          if (t.kind !== 'user') return false;
          const stored = t.email ?? t.userId;
          return stored !== undefined
            && canonicalPersonEmail(stored) === canonicalPersonEmail(selector.email);
        }
      }
    };
    registry.tokens = registry.tokens.filter(t => !matches(t));
    const removed = before - registry.tokens.length;
    if (removed > 0) await persist(projectRoot, registry);
    return removed;
  });
}

/** Drop the in-process cache. Tests only — the daemon is a single writer. */
export function clearDaemonTokenCache(): void {
  cache.clear();
}

/** The token currently bound to an identity, or null. Diagnostics/tests. */
export async function peekDaemonToken(
  projectRoot: string,
  identity: DaemonIdentity,
  label: string,
): Promise<string | null> {
  const registry = await getRegistry(projectRoot);
  const key = identityKey(identity, label);
  return registry.tokens.find(t => recordKey(t) === key)?.token ?? null;
}

