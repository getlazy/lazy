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
 * capping them could silently kill a live long-running task's turn.
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
  } catch (err) {
    // Found-but-broken is an error the human must see. Starting from empty
    // would silently 401 every running container's next request, and the
    // message they'd chase would be "authentication", not "corrupt file".
    throw new Error(
      `The proxy credential grant registry ${path} is not valid JSON ` +
      `(${err instanceof Error ? err.message : String(err)}). ` +
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

function identityKey(
  role: GrantRole,
  taskId: string | null,
  label: string,
  envKey: string,
): string {
  const who = role === 'agent' ? `agent:${taskId ?? label}` : `builder:${label}`;
  return `${who}|${envKey}`;
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
  opts: { role: GrantRole; taskId?: string | null; label: string; envKey: string },
): Promise<string> {
  const taskId = opts.taskId ?? null;
  return mutate(projectRoot, async registry => {
    const key = identityKey(opts.role, taskId, opts.label, opts.envKey);
    const existing = registry.grants.find(
      g => identityKey(g.role, g.taskId, g.label, g.envKey) === key,
    );
    if (existing) return existing.token;

    const grant: CredentialGrant = {
      token: placeholderValueFor(opts.envKey),
      role: opts.role,
      taskId,
      label: opts.label,
      envKey: opts.envKey,
      createdAt: new Date().toISOString(),
    };
    registry.grants.push(grant);

    const builders = registry.grants.filter(g => g.role === 'builder');
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
 * Returns the number revoked. Idempotent.
 */
export async function revokeTaskCredentialGrants(
  projectRoot: string,
  taskId: string,
): Promise<number> {
  return mutate(projectRoot, async registry => {
    const before = registry.grants.length;
    registry.grants = registry.grants.filter(g => !(g.role === 'agent' && g.taskId === taskId));
    const removed = before - registry.grants.length;
    if (removed > 0) await persist(projectRoot, registry);
    return removed;
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

/** Drop the in-process cache. Tests only — the daemon is a single writer. */
export function clearCredentialGrantCache(): void {
  cache.clear();
}
