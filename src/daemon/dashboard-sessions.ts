/**
 * Browser sign-in state for the daemon's web dashboard.
 *
 * THE BOUNDARY THIS EXISTS FOR: the daemon serves the dashboard, `/rpc` and
 * `/mcp` on ONE TCP port. `/rpc` and `/mcp` have always required a token; the
 * dashboard did not — and task containers are launched with
 * `--add-host=host.docker.internal:host-gateway` so their MCP client can reach
 * that port. An agent inside a container could therefore fetch the whole
 * dashboard, read `/api/tasks` (every task's id, goal, prompt and status), and
 * POST the task actions the dashboard exposes. The dashboard now requires a
 * browser session that a container cannot obtain.
 *
 * Two record kinds, one file:
 *
 *   - a LOGIN TICKET is a short-lived, single-use secret that `lazy dashboard`
 *     puts in the query string of the URL it opens. Redeeming it destroys it and
 *     yields a session. Single-use matters because a URL is the least private
 *     thing on a machine: it lands in shell history, in the opener's argv (which
 *     `ps` shows to every local process, including one in a container sharing
 *     the pid namespace), and possibly in a browser's history sync.
 *   - a SESSION is the long-lived secret behind the `HttpOnly; SameSite=Strict`
 *     cookie the browser then holds. Thirty days of idle life, slid forward as
 *     it is used, so the operator signs in about as often as they reboot.
 *
 * DELIBERATELY NOT the daemon bearer token, and not an MCP token. A container
 * holds an MCP token by design; if that token also opened the dashboard, this
 * whole change would be decorative. The dashboard credential is minted only
 * through `/rpc` (which a container cannot call — agent MCP tokens are refused
 * there) and delivered only to a browser on this host.
 *
 * Where it lives: `~/.lazy/daemon/<slug>/dashboard-sessions.json`, mode 0600 —
 * the daemon's own runtime state, never under the project root, for the same
 * reason as the MCP token registry: task containers bind-mount the repo, so a
 * browser credential stored in-repo would be readable by exactly the agents it
 * excludes. It is runtime state rather than Storage because it is a per-host
 * secret (like the daemon token), meaningless on another machine and not part
 * of the project's history.
 *
 * Restart semantics: sessions survive a daemon restart — the registry is on
 * disk and re-read — so bouncing the daemon does not sign the operator out.
 */

import { randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { getDashboardSessionsPath } from './paths';

/** A login ticket is exchanged for a session within this window. */
export const LOGIN_TICKET_TTL_MS = 5 * 60 * 1000;

/** A session expires this long after it was last used. */
export const DASHBOARD_SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How stale `lastSeenAt` may get before a verify writes it back.
 *
 * The dashboard auto-refreshes, so a signed-in browser produces a steady stream
 * of requests; persisting on every one would turn a page load into a burst of
 * 0600 file writes. An hour of slack is invisible against a 30-day idle window.
 */
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

interface LoginTicketRecord {
  ticket: string;
  createdAt: string;
  expiresAt: string;
}

interface DashboardSessionRecord {
  id: string;
  createdAt: string;
  lastSeenAt: string;
}

interface DashboardSessionsFile {
  version: 1;
  tickets: LoginTicketRecord[];
  sessions: DashboardSessionRecord[];
}

/** Cached registry per project root, so the hot verify path does no file I/O. */
const cache = new Map<string, DashboardSessionsFile>();
/** Serializes read-modify-write cycles within this process. */
let writeChain: Promise<unknown> = Promise.resolve();

function emptyFile(): DashboardSessionsFile {
  return { version: 1, tickets: [], sessions: [] };
}

/** Read the registry from disk, tolerating a missing file (never signed in). */
async function loadRegistry(projectRoot: string): Promise<DashboardSessionsFile> {
  const path = getDashboardSessionsPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
    throw new Error(
      `Failed to read dashboard session store ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: DashboardSessionsFile;
  try {
    parsed = JSON.parse(raw) as DashboardSessionsFile;
  } catch (err) {
    // Distinguish "not there" from "there but broken": starting from empty here
    // would sign the operator out with no explanation and no way to tell that
    // from an expired session.
    throw new Error(
      `Dashboard session store ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
      `Delete the file and run \`lazy dashboard\` to sign in again.`,
    );
  }
  if (!parsed || !Array.isArray(parsed.tickets) || !Array.isArray(parsed.sessions)) {
    throw new Error(
      `Dashboard session store ${path} has an unexpected shape (expected { version, tickets: [], sessions: [] }).`,
    );
  }
  return { version: 1, tickets: parsed.tickets, sessions: parsed.sessions };
}

async function getRegistry(projectRoot: string): Promise<DashboardSessionsFile> {
  const cached = cache.get(projectRoot);
  if (cached) return cached;
  const loaded = await loadRegistry(projectRoot);
  cache.set(projectRoot, loaded);
  return loaded;
}

async function persist(projectRoot: string, registry: DashboardSessionsFile): Promise<void> {
  const path = getDashboardSessionsPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  // 0600: every value in here is a bearer credential for the dashboard.
  await writeFile(path, JSON.stringify(registry, null, 2), { mode: 0o600 });
  cache.set(projectRoot, registry);
}

/** Run a read-modify-write cycle with no interleaving inside this process. */
async function mutate<T>(
  projectRoot: string,
  fn: (registry: DashboardSessionsFile) => Promise<T> | T,
): Promise<T> {
  const run = writeChain.then(async () => {
    const registry = await getRegistry(projectRoot);
    return fn(registry);
  });
  // Keep the chain alive even when this link rejects, or one failure would wedge
  // every later mint/redeem behind a permanently rejected promise.
  writeChain = run.catch(() => undefined);
  return run;
}

/** Drop expired tickets and idle-expired sessions. Returns true if anything went. */
function prune(registry: DashboardSessionsFile, now: number): boolean {
  const tickets = registry.tickets.filter(t => Date.parse(t.expiresAt) > now);
  const sessions = registry.sessions.filter(
    s => now - Date.parse(s.lastSeenAt) < DASHBOARD_SESSION_IDLE_MS,
  );
  const changed = tickets.length !== registry.tickets.length || sessions.length !== registry.sessions.length;
  registry.tickets = tickets;
  registry.sessions = sessions;
  return changed;
}

/**
 * Mint a one-time login ticket. The caller puts it in the query string of the
 * dashboard URL it opens; the first request carrying it exchanges it for a
 * session cookie and the ticket is gone.
 */
export async function mintDashboardLoginTicket(projectRoot: string): Promise<string> {
  return mutate(projectRoot, async registry => {
    const now = Date.now();
    prune(registry, now);
    const ticket = randomBytes(32).toString('hex');
    registry.tickets.push({
      ticket,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LOGIN_TICKET_TTL_MS).toISOString(),
    });
    await persist(projectRoot, registry);
    return ticket;
  });
}

/**
 * Exchange a login ticket for a session id, or null when the ticket is unknown,
 * already redeemed, or expired.
 *
 * The ticket is removed in the SAME serialized read-modify-write as the session
 * is created, so two concurrent requests carrying the same ticket cannot both
 * come away with a session.
 */
export async function redeemDashboardLoginTicket(
  projectRoot: string,
  ticket: string | null | undefined,
): Promise<string | null> {
  if (!ticket) return null;
  return mutate(projectRoot, async registry => {
    const now = Date.now();
    prune(registry, now);
    const index = registry.tickets.findIndex(t => t.ticket === ticket);
    if (index === -1) {
      // A ticket that was already redeemed is indistinguishable from one that
      // never existed, on purpose — replaying a URL from shell history must not
      // reveal that it once worked.
      return null;
    }
    registry.tickets.splice(index, 1);
    const id = randomBytes(32).toString('hex');
    const stamp = new Date(now).toISOString();
    registry.sessions.push({ id, createdAt: stamp, lastSeenAt: stamp });
    await persist(projectRoot, registry);
    return id;
  });
}

/**
 * Is this session id a live dashboard session?
 *
 * Slides the idle window forward, but only writes when `lastSeenAt` has gone
 * stale enough to be worth a write (see SESSION_TOUCH_INTERVAL_MS) — the
 * dashboard auto-refreshes and this runs on every request.
 *
 * On a cache miss the registry is re-read from disk before answering false: a
 * session minted before this process started (a restarted daemon, or a test
 * harness) must not be reported as forged.
 */
export async function isValidDashboardSession(
  projectRoot: string,
  sessionId: string | null | undefined,
): Promise<boolean> {
  if (!sessionId) return false;
  const now = Date.now();

  const live = (registry: DashboardSessionsFile): DashboardSessionRecord | null => {
    const record = registry.sessions.find(s => s.id === sessionId);
    if (!record) return null;
    if (now - Date.parse(record.lastSeenAt) >= DASHBOARD_SESSION_IDLE_MS) return null;
    return record;
  };

  let record: DashboardSessionRecord | null = null;
  const cached = cache.get(projectRoot);
  if (cached) record = live(cached);
  if (!record) {
    const fresh = await loadRegistry(projectRoot);
    cache.set(projectRoot, fresh);
    record = live(fresh);
  }
  if (!record) return false;

  if (now - Date.parse(record.lastSeenAt) > SESSION_TOUCH_INTERVAL_MS) {
    const id = record.id;
    await mutate(projectRoot, async registry => {
      const target = registry.sessions.find(s => s.id === id);
      if (!target) return;
      target.lastSeenAt = new Date(now).toISOString();
      await persist(projectRoot, registry);
    });
  }
  return true;
}

/** Sign every browser out. Returns how many sessions were dropped. */
export async function revokeDashboardSessions(projectRoot: string): Promise<number> {
  return mutate(projectRoot, async registry => {
    const removed = registry.sessions.length;
    registry.sessions = [];
    registry.tickets = [];
    await persist(projectRoot, registry);
    return removed;
  });
}

/** Drop the in-process cache. Tests only — the daemon is a single writer. */
export function clearDashboardSessionCache(): void {
  cache.clear();
}
