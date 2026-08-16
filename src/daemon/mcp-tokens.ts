/**
 * Per-identity daemon MCP tokens.
 *
 * THE BOUNDARY THIS EXISTS FOR: agents call the daemon at
 * `POST /mcp/:taskId/:toolName`. The `:taskId` segment is *claimed* by the
 * caller — it is not evidence of anything. While every agent presented the same
 * shared daemon bearer token, any agent could claim any task id and act as that
 * task: pose as its own PARENT and accept itself, unblock a sibling, close
 * someone else's work. Every server-side ownership gate (agent-subtask-mcp,
 * allow-agent-accept-subtask) was therefore advisory against a deliberately
 * malicious agent.
 *
 * The fix is to make identity cryptographic rather than claimed: each task
 * session (and each builder session) gets its OWN random token, bound
 * server-side to exactly one identity. The daemon derives the caller's identity
 * from the token it presents and REFUSES (403) when the URL-claimed task id
 * disagrees — it never silently overrides the claim, because a caller acting on
 * the wrong task while believing it acts on another is worse than a hard error.
 *
 * Where the tokens live: `~/.lazy/daemon/<slug>/mcp-tokens.json`, mode 0600 —
 * the daemon's own state directory, alongside the shared `token` file, and
 * NEVER under the project root. That placement is load-bearing: task containers
 * bind-mount the whole repo read-only, so anything under `<project>/.lazy/`
 * is readable by EVERY agent. A per-task token stored there would be trivially
 * stealable by the very agents it is meant to separate.
 *
 * Restart semantics: tokens survive daemon restarts (the registry is on disk and
 * reloaded), matching the shared token's deliberate reuse across restarts — a
 * running container keeps working when the daemon bounces. They do NOT survive
 * the end of the session they belong to: accept/reject/close revoke the task's
 * token (see revokeTaskMcpTokens).
 */

import { randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { pidExists } from '../utils/process-identity';
import { getMcpTokensPath } from './paths';

/** Who a presented MCP token proves the caller to be. */
export type McpIdentity =
  | { kind: 'task'; taskId: string }
  | { kind: 'builder' };

/** One minted token and the identity it is bound to. */
interface McpTokenRecord {
  token: string;
  kind: 'task' | 'builder';
  /** Full task UUID for task tokens; absent for builder tokens. */
  taskId?: string;
  /** Container / builder name the token was minted for — diagnostics only. */
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

interface McpTokenFile {
  version: 1;
  tokens: McpTokenRecord[];
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
 *     none) is "not provably live" and is evicted first, exactly as today;
 *   - a recycled pid makes a dead record look live. That only *demotes* it in
 *     the eviction order — the cap is still a hard cap, so the registry stays
 *     bounded and the failure mode is one extra retained token, not growth.
 * The cap is never exceeded: if every retained builder is live, the oldest live
 * one is still dropped.
 */
export const MAX_BUILDER_TOKENS = 50;

/**
 * Is this record's owning session provably still running?
 *
 * Deliberately conservative: unknown pid means "not provably live". A false
 * negative only means an already-dead-looking record is evicted sooner, which
 * is the pre-existing behavior for every record.
 */
function isProvablyLive(record: McpTokenRecord): boolean {
  return typeof record.ownerPid === 'number' && pidExists(record.ownerPid);
}

/** Cached registry per project root, so the hot verify path does no file I/O. */
const cache = new Map<string, McpTokenFile>();
/** Serializes read-modify-write cycles within this process. */
let writeChain: Promise<unknown> = Promise.resolve();

function identityKey(identity: McpIdentity, label: string): string {
  return identity.kind === 'task' ? `task:${identity.taskId}` : `builder:${label}`;
}

function recordKey(record: McpTokenRecord): string {
  return record.kind === 'task' ? `task:${record.taskId}` : `builder:${record.label}`;
}

/** Read the registry from disk, tolerating a missing file (fresh project). */
async function loadRegistry(projectRoot: string): Promise<McpTokenFile> {
  const path = getMcpTokensPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, tokens: [] };
    }
    throw new Error(`Failed to read daemon MCP token registry ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: McpTokenFile;
  try {
    parsed = JSON.parse(raw) as McpTokenFile;
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

async function getRegistry(projectRoot: string): Promise<McpTokenFile> {
  const cached = cache.get(projectRoot);
  if (cached) return cached;
  const loaded = await loadRegistry(projectRoot);
  cache.set(projectRoot, loaded);
  return loaded;
}

async function persist(projectRoot: string, registry: McpTokenFile): Promise<void> {
  const path = getMcpTokensPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  // 0600: these are bearer credentials. Same posture as the shared token file.
  await writeFile(path, JSON.stringify(registry, null, 2), { mode: 0o600 });
  cache.set(projectRoot, registry);
}

/** Run a read-modify-write cycle with no interleaving inside this process. */
async function mutate<T>(
  projectRoot: string,
  fn: (registry: McpTokenFile) => Promise<T> | T,
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

/** Extra facts about the session a token is being minted for. */
export interface MintMcpTokenOptions {
  /**
   * pid of the process owning the session, when the caller can name it. Only
   * `lazy builder` does today; it runs on the host beside the daemon. Recorded
   * for eviction ordering alone — it is a CLAIM by an already-authenticated
   * caller, never evidence of identity, and no auth decision reads it.
   */
  ownerPid?: number;
}

/**
 * Mint (or reuse) the token for one identity.
 *
 * Reuse is deliberate and per identity: a task is unblocked many times and its
 * container is often reused, and the MCP server inside a live container holds
 * its token in memory. Minting a fresh token per turn would either invalidate a
 * live session mid-flight or leave a growing pile of equally-valid tokens for
 * one task. One live token per task is both simpler and a smaller surface.
 */
export async function mintMcpToken(
  projectRoot: string,
  identity: McpIdentity,
  label: string,
  options: MintMcpTokenOptions = {},
): Promise<string> {
  return mutate(projectRoot, async registry => {
    const key = identityKey(identity, label);
    const existing = registry.tokens.find(t => recordKey(t) === key);
    if (existing) {
      // Refresh the liveness pid on reuse. The re-issue watcher and the relaunch
      // loop both come back through here for the SAME identity, and a record
      // that predates this field would otherwise never learn its owner — the
      // live session it belongs to would stay first in line for eviction.
      if (options.ownerPid !== undefined && existing.ownerPid !== options.ownerPid) {
        existing.ownerPid = options.ownerPid;
        await persist(projectRoot, registry);
      }
      return existing.token;
    }

    const record: McpTokenRecord = {
      token: randomBytes(32).toString('hex'),
      kind: identity.kind,
      ...(identity.kind === 'task' ? { taskId: identity.taskId } : {}),
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
export async function lookupMcpIdentity(
  projectRoot: string,
  token: string | null | undefined,
): Promise<McpIdentity | null> {
  if (!token) return null;
  const found = (registry: McpTokenFile): McpIdentity | null => {
    const record = registry.tokens.find(t => t.token === token);
    if (!record) return null;
    if (record.kind === 'task') {
      return record.taskId ? { kind: 'task', taskId: record.taskId } : null;
    }
    return { kind: 'builder' };
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
 * Revoke every token bound to a task. Called when the task's session ends
 * (accept / reject / close) — after that point the agent must not be able to
 * act, and its container is being torn down anyway.
 *
 * Returns the number of tokens revoked. Idempotent.
 */
export async function revokeTaskMcpTokens(projectRoot: string, taskId: string): Promise<number> {
  return mutate(projectRoot, async registry => {
    const before = registry.tokens.length;
    registry.tokens = registry.tokens.filter(t => !(t.kind === 'task' && t.taskId === taskId));
    const removed = before - registry.tokens.length;
    if (removed > 0) await persist(projectRoot, registry);
    return removed;
  });
}

/**
 * Revoke the token bound to one builder session, identified by the label it was
 * minted with (the `builder-<id>` name that also names its MCP config file).
 *
 * Called when the builder's supervisor exits — the human closing the terminal
 * ends the session, and nothing else tells the daemon about it. Without this the
 * credential outlived the session entirely: builder tokens were bounded only by
 * MAX_BUILDER_TOKENS, so a token stayed valid until 50 later builders pushed it
 * out. A leaked config file from an exited session must not still be usable.
 *
 * Returns the number of tokens revoked (0 or 1). Idempotent.
 */
export async function revokeBuilderMcpToken(projectRoot: string, label: string): Promise<number> {
  return mutate(projectRoot, async registry => {
    const before = registry.tokens.length;
    registry.tokens = registry.tokens.filter(t => !(t.kind === 'builder' && t.label === label));
    const removed = before - registry.tokens.length;
    if (removed > 0) await persist(projectRoot, registry);
    return removed;
  });
}

/** Drop the in-process cache. Tests only — the daemon is a single writer. */
export function clearMcpTokenCache(): void {
  cache.clear();
}

/** The token currently bound to an identity, or null. Diagnostics/tests. */
export async function peekMcpToken(
  projectRoot: string,
  identity: McpIdentity,
  label: string,
): Promise<string | null> {
  const registry = await getRegistry(projectRoot);
  const key = identityKey(identity, label);
  return registry.tokens.find(t => recordKey(t) === key)?.token ?? null;
}
