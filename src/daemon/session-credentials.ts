/**
 * Session-bound PLACEHOLDER tokens — what a container gets instead of a real
 * Anthropic credential.
 *
 * The shape of the mechanism (docs/design/lazy-teams.md §3.2):
 *
 *   1. The control plane stores a member's real credential in the daemon
 *      (./user-credentials.ts). It never goes anywhere else.
 *   2. At turn launch the daemon binds a random placeholder token to
 *      `{taskId, sessionId, ownerUserId}` — that binding is this file.
 *   3. The placeholder is injected into the container in the env var that
 *      MIRRORS the owner's credential kind, so Claude Code emits the request
 *      shape the real credential needs, by itself.
 *   4. The proxy recognises the placeholder on the way out, looks up the owner,
 *      and replaces the token VALUE inside the header the request arrived with.
 *   5. When the turn's process exits the binding is revoked, so a container
 *      that keeps talking afterwards gets a 401 rather than continuing to spend
 *      a departed user's identity.
 *
 * TOKEN VALUE vs OWNER BINDING. A task container is long-lived and REUSED
 * across turns (src/daemon/task-launcher.ts), and its environment is fixed when
 * docker creates it — no later turn can change an env var of a running
 * container. So the two halves have different lifetimes on purpose: the token
 * VALUE is stable for as long as the container that holds it, while the OWNER
 * BINDING is re-pointed at every turn launch and dropped when the turn ends.
 * Authority therefore always tracks the current turn even though the string in
 * the container's env does not change.
 *
 * The one thing that cannot be re-pointed is the KIND, because the kind decides
 * which env var name the placeholder lives in. A turn whose owner holds a
 * different credential kind than the running container was launched with
 * therefore forces the container to be recreated (`kindChanged` below) — the
 * alternative would be the launch path manufacturing the very
 * `auth_kind_mismatch` the proxy exists to refuse.
 *
 * Placement: `~/.lazy/daemon/<slug>/session-credentials.json`, mode 0600. On
 * disk rather than in memory so a daemon restart mid-session does not silently
 * 401 every running container.
 */

import { randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { getSessionCredentialsPath } from './paths';
import type { UserCredentialKind } from './user-credentials';

/**
 * Prefix that marks a token as a lazy placeholder rather than a real
 * credential.
 *
 * This prefix is what makes the whole feature additive. The proxy only applies
 * session-token rules — lookup, swap, and "unknown ⇒ 401" — to values carrying
 * it. Everything else is forwarded verbatim, exactly as before, which is what
 * every single-user install sends.
 */
export const SESSION_TOKEN_PREFIX = 'lazy-sess-';

/** True for a value lazy minted as a session placeholder. */
export function isSessionPlaceholderToken(value: string): boolean {
  return value.startsWith(SESSION_TOKEN_PREFIX);
}

export interface SessionCredentialBinding {
  /** The placeholder value handed to the container. */
  token: string;
  /** Task UUID this binding belongs to. */
  taskId: string;
  /** Session id of the turn that bound it. */
  sessionId: string;
  /** The principal whose real credential this placeholder resolves to. */
  ownerUserId: string;
  /** Credential kind at bind time — decides the env var the placeholder lives in. */
  kind: UserCredentialKind;
  /** When the binding was last (re-)pointed, unix ms. */
  boundAt: number;
  /**
   * When the turn ended, unix ms — null while the turn is live.
   *
   * A revoked binding is kept rather than deleted, and that is load-bearing: it
   * remembers the token VALUE and KIND the still-running container was created
   * with, so the task's next turn can re-point the same value instead of minting
   * a new one and forcing a pointless container recreation. It confers no
   * authority — the proxy treats a revoked binding exactly like an unknown one.
   */
  revokedAt: number | null;
  /**
   * The ONLY network address requests carrying this placeholder may arrive
   * from, when set. Recorded for a member's terminal container once it is up
   * (src/daemon/member-container.ts): the proxy refuses the placeholder from
   * anywhere else, so a value that leaked out of that container is worthless.
   * Unset for everything else (see {@link setSessionBindingOrigin}).
   */
  origin?: string;
}

/** How long a revoked binding is kept for its token/kind memory. */
const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionCredentialFile {
  version: 1;
  bindings: SessionCredentialBinding[];
}

const cache = new Map<string, SessionCredentialFile>();
let writeChain: Promise<unknown> = Promise.resolve();

function emptyFile(): SessionCredentialFile {
  return { version: 1, bindings: [] };
}

async function load(projectRoot: string): Promise<SessionCredentialFile> {
  const cached = cache.get(projectRoot);
  if (cached) return cached;

  const path = getSessionCredentialsPath(projectRoot);
  let parsed: SessionCredentialFile;
  try {
    const raw = await readFile(path, 'utf-8');
    const data = JSON.parse(raw) as Partial<SessionCredentialFile>;
    const bindings = Array.isArray(data.bindings) ? data.bindings : [];
    parsed = {
      version: 1,
      bindings: bindings.map((b) => ({ ...b, revokedAt: b.revokedAt ?? null })),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      parsed = emptyFile();
    } else {
      // A corrupt registry must not read as "no session tokens exist" — that
      // would silently 401 every live container with no explanation anywhere.
      throw new Error(
        `Failed to read the session-credential registry at ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  cache.set(projectRoot, parsed);
  return parsed;
}

async function persist(projectRoot: string, file: SessionCredentialFile): Promise<void> {
  const path = getSessionCredentialsPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  cache.set(projectRoot, file);
}

async function mutate<T>(
  projectRoot: string,
  fn: (file: SessionCredentialFile) => Promise<T> | T,
): Promise<T> {
  const run = writeChain.then(async () => {
    const file = await load(projectRoot);
    return fn(file);
  });
  writeChain = run.catch(() => {});
  return run;
}

/** Drop the in-memory cache. Tests, and any process that is not the daemon. */
export function clearSessionCredentialCache(): void {
  cache.clear();
}

export interface BindTurnCredentialResult {
  /** The placeholder to inject into the container. */
  token: string;
  /**
   * True when the credential KIND changed since this task's last binding (or
   * there was no binding). The launch path must recreate the container in that
   * case: the placeholder has to move to a different env var name, and a
   * running container's env cannot be changed.
   */
  kindChanged: boolean;
}

/**
 * Point this task's placeholder at the owner of the turn about to launch.
 *
 * Reuses the existing token VALUE when the kind is unchanged, so a container
 * that is being reused keeps working with the env it was created with while the
 * authority behind that value moves to the new turn's owner.
 */
export async function bindTurnCredential(
  projectRoot: string,
  input: { taskId: string; sessionId: string; ownerUserId: string; kind: UserCredentialKind },
): Promise<BindTurnCredentialResult> {
  return mutate(projectRoot, async (file) => {
    const existing = file.bindings.find((b) => b.taskId === input.taskId);
    const kindChanged = !existing || existing.kind !== input.kind;
    const token = kindChanged ? mintToken() : existing!.token;

    const binding: SessionCredentialBinding = {
      token,
      taskId: input.taskId,
      sessionId: input.sessionId,
      ownerUserId: input.ownerUserId,
      kind: input.kind,
      boundAt: Date.now(),
      revokedAt: null,
    };

    const bindings = prune(file.bindings).filter((b) => b.taskId !== input.taskId);
    bindings.push(binding);
    await persist(projectRoot, { version: 1, bindings });
    return { token, kindChanged };
  });
}

/**
 * This task's binding, live or revoked, or null.
 *
 * Used when composing launch env, where the question is "what value is in this
 * container's environment", not "is it currently authoritative" — the launch
 * path has just re-pointed it. Never used to decide access; that is
 * {@link lookupSessionBinding}.
 */
export async function getTaskSessionBinding(
  projectRoot: string,
  taskId: string,
): Promise<SessionCredentialBinding | null> {
  const file = await load(projectRoot);
  return file.bindings.find((b) => b.taskId === taskId) ?? null;
}

/**
 * The binding a presented placeholder proves, or null.
 *
 * Null is the whole answer the proxy needs: an unknown session token is a 401,
 * always. There is no unattributed bucket on this path — a request lazy cannot
 * attribute to a person is a request lazy does not forward.
 */
export async function lookupSessionBinding(
  projectRoot: string,
  token: string,
): Promise<SessionCredentialBinding | null> {
  if (!isSessionPlaceholderToken(token)) return null;
  const live = (b: SessionCredentialBinding) => b.token === token && b.revokedAt === null;
  const cached = cache.get(projectRoot);
  const hit = cached?.bindings.find(live);
  if (hit) return hit;
  // Miss: re-read from disk before answering. Another process (or an older
  // daemon generation) may have bound it since this cache was filled.
  cache.delete(projectRoot);
  const file = await load(projectRoot);
  return file.bindings.find(live) ?? null;
}

/**
 * Revoke this task's binding — called when the turn's process exits.
 *
 * The container keeps the now-orphaned placeholder in its env; that is exactly
 * the intent. Anything it sends after its turn is over resolves to nothing and
 * gets a 401, so a long-lived container cannot keep spending the identity of
 * the user whose turn has ended.
 */
export async function revokeTaskSessionBinding(
  projectRoot: string,
  taskId: string,
): Promise<boolean> {
  return mutate(projectRoot, async (file) => {
    let revoked = false;
    const bindings = prune(file.bindings).map((b) => {
      if (b.taskId !== taskId || b.revokedAt !== null) return b;
      revoked = true;
      return { ...b, revokedAt: Date.now() };
    });
    if (!revoked) return false;
    await persist(projectRoot, { version: 1, bindings });
    return true;
  });
}

/**
 * Pin a binding to the one network address its placeholder may be presented
 * from. Throws when there is no live binding under `taskId` — the caller is
 * launching the container this pins, and must not start it unpinned.
 */
export async function setSessionBindingOrigin(projectRoot: string, taskId: string, origin: string): Promise<void> {
  await mutate(projectRoot, async (file) => {
    const bindings = prune(file.bindings);
    const current = bindings.find((b) => b.taskId === taskId && b.revokedAt === null);
    if (!current) throw new Error(`no live credential binding to pin under ${taskId}`);
    current.origin = origin;
    await persist(projectRoot, { version: 1, bindings });
  });
}

/**
 * Revoke every live binding whose key starts with `prefix`. For the member
 * containers' bindings (`member-exec:`), whose only other revoke is the
 * container's removal, which a daemon restart interrupts. Returns how many.
 */
export async function revokeBindingsByKeyPrefix(projectRoot: string, prefix: string): Promise<number> {
  return mutate(projectRoot, async (file) => {
    let revoked = 0;
    const bindings = prune(file.bindings).map((b) => {
      if (!b.taskId.startsWith(prefix) || b.revokedAt !== null) return b;
      revoked += 1;
      return { ...b, revokedAt: Date.now() };
    });
    if (revoked > 0) await persist(projectRoot, { version: 1, bindings });
    return revoked;
  });
}

/** Drop revoked bindings whose container is long gone. */
function prune(bindings: SessionCredentialBinding[]): SessionCredentialBinding[] {
  const cutoff = Date.now() - REVOKED_RETENTION_MS;
  return bindings.filter((b) => b.revokedAt === null || b.revokedAt > cutoff);
}

function mintToken(): string {
  return SESSION_TOKEN_PREFIX + randomBytes(32).toString('hex');
}
