/**
 * The dashboard's session registry: what a ticket is worth, and for how long.
 *
 * The e2e suite covers sign-in through a real daemon. What it cannot cover is
 * TIME — a five-minute ticket window and a thirty-day idle window are not
 * things a test can wait out. These assertions reach the store directly and
 * write the timestamps, which is also why they are the only place that knows
 * the file's shape.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LOGIN_TICKET_TTL_MS,
  DASHBOARD_SESSION_IDLE_MS,
  clearDashboardSessionCache,
  isValidDashboardSession,
  mintDashboardLoginTicket,
  redeemDashboardLoginTicket,
  revokeDashboardSessions,
} from '../../src/daemon/dashboard-sessions';
import { getDashboardSessionsPath } from '../../src/daemon/paths';

describe('dashboard session registry', () => {
  let base: string;
  const projectRoot = '/tmp/lazy-dashboard-sessions-project';
  let previousBaseDir: string | undefined;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'lazy-dash-sessions-'));
    // The registry lives in the daemon's runtime state, addressed through the
    // documented LAZY_DAEMON_BASE_DIR seam — never HOME, which would also move
    // credential discovery and the default storage path.
    previousBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = base;
    clearDashboardSessionCache();
  });

  afterEach(async () => {
    if (previousBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = previousBaseDir;
    clearDashboardSessionCache();
    await rm(base, { recursive: true, force: true });
  });

  async function readStore() {
    return JSON.parse(await readFile(getDashboardSessionsPath(projectRoot), 'utf-8')) as {
      tickets: Array<{ ticket: string; expiresAt: string }>;
      sessions: Array<{ id: string; lastSeenAt: string }>;
    };
  }

  async function writeStore(data: unknown) {
    await writeFile(getDashboardSessionsPath(projectRoot), JSON.stringify(data, null, 2));
    clearDashboardSessionCache();
  }

  test('a ticket redeems once and yields a session', async () => {
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const sessionId = await redeemDashboardLoginTicket(projectRoot, ticket);
    expect(typeof sessionId).toBe('string');
    expect(await isValidDashboardSession(projectRoot, sessionId)).toBe(true);

    expect(await redeemDashboardLoginTicket(projectRoot, ticket)).toBeNull();
  });

  test('an unknown or empty ticket yields nothing', async () => {
    expect(await redeemDashboardLoginTicket(projectRoot, 'nope')).toBeNull();
    expect(await redeemDashboardLoginTicket(projectRoot, '')).toBeNull();
    expect(await redeemDashboardLoginTicket(projectRoot, null)).toBeNull();
  });

  test('an unknown or empty session id is not valid', async () => {
    await mintDashboardLoginTicket(projectRoot);
    expect(await isValidDashboardSession(projectRoot, 'nope')).toBe(false);
    expect(await isValidDashboardSession(projectRoot, '')).toBe(false);
    expect(await isValidDashboardSession(projectRoot, null)).toBe(false);
  });

  // Every value in the file is a bearer credential for the dashboard.
  test('the store is written 0600', async () => {
    await mintDashboardLoginTicket(projectRoot);
    const info = await stat(getDashboardSessionsPath(projectRoot));
    expect(info.mode & 0o777).toBe(0o600);
  });

  test('a ticket past its window is refused', async () => {
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const store = await readStore();
    store.tickets[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeStore(store);

    expect(await redeemDashboardLoginTicket(projectRoot, ticket)).toBeNull();
    expect(LOGIN_TICKET_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  test('a session idle past the window is refused', async () => {
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const sessionId = await redeemDashboardLoginTicket(projectRoot, ticket);

    const store = await readStore();
    store.sessions[0].lastSeenAt = new Date(Date.now() - DASHBOARD_SESSION_IDLE_MS - 1000).toISOString();
    await writeStore(store);

    expect(await isValidDashboardSession(projectRoot, sessionId)).toBe(false);
  });

  // The whole point of a 30-day IDLE window: someone who uses the dashboard is
  // never signed out from under themselves.
  test('using a session slides its idle window forward', async () => {
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const sessionId = await redeemDashboardLoginTicket(projectRoot, ticket);

    // Old enough to be worth a write, young enough to still be valid.
    const stale = new Date(Date.now() - DASHBOARD_SESSION_IDLE_MS / 2).toISOString();
    const store = await readStore();
    store.sessions[0].lastSeenAt = stale;
    await writeStore(store);

    expect(await isValidDashboardSession(projectRoot, sessionId)).toBe(true);
    const after = await readStore();
    expect(Date.parse(after.sessions[0].lastSeenAt)).toBeGreaterThan(Date.parse(stale));
  });

  // A daemon restart re-reads the file; a session minted by the previous process
  // must not look forged just because this one has an empty cache.
  test('a session written by another process is honoured after a cache drop', async () => {
    const ticket = await mintDashboardLoginTicket(projectRoot);
    const sessionId = await redeemDashboardLoginTicket(projectRoot, ticket);
    clearDashboardSessionCache();
    expect(await isValidDashboardSession(projectRoot, sessionId)).toBe(true);
  });

  test('revoking signs every browser out', async () => {
    const sessionId = await redeemDashboardLoginTicket(
      projectRoot,
      await mintDashboardLoginTicket(projectRoot),
    );
    expect(await revokeDashboardSessions(projectRoot)).toBe(1);
    expect(await isValidDashboardSession(projectRoot, sessionId)).toBe(false);
  });

  // "Not there" and "there but broken" are different: starting from empty on a
  // corrupt file would sign the operator out with no way to tell that from an
  // expired session.
  test('a corrupt store fails loudly with a remedy', async () => {
    await mintDashboardLoginTicket(projectRoot);
    await writeFile(getDashboardSessionsPath(projectRoot), '{ not json');
    clearDashboardSessionCache();

    await expect(isValidDashboardSession(projectRoot, 'anything')).rejects.toThrow(/lazy dashboard/);
  });
});
