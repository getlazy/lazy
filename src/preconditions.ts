/**
 * The preconditions of doing anything with lazy: a project, a commit, storage.
 *
 * These are the THROWING core. A `process.exit()` here would be a landmine for
 * every long-lived process that reuses them — one daemon-unreachable MCP tool
 * call used to kill the stdio server mid-request. The exiting wrappers
 * (`requireLazyRoot` / `requireStorage`) live in `src/cli/helpers.ts` and are
 * for one-shot CLI commands only; servers use the functions here and let the
 * error propagate.
 */

import { findLazyRoot } from './project-paths';
import type { Storage } from './storage';
import { repoHasCommits } from './git/operations';
import { DaemonClient, RpcApplicationError, boundCloneFailure } from './daemon/client';
import { RemoteStorage } from './storage/remote-storage';

/**
 * A precondition of running lazy is not met (no project, no commits, no daemon).
 *
 * Carries the message a CLI user would have seen. `requireLazyRoot()` /
 * `requireStorage()` turn it back into that exact stderr + exit(1); long-lived
 * processes (MCP server, daemon) let it propagate as an ordinary error.
 */
export class LazyPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LazyPreconditionError';
  }
}

/**
 * Get the lazy root directory, THROWING if the preconditions are not met.
 *
 * Use this — not `requireLazyRoot()` — anywhere that is not a one-shot CLI
 * command. A `process.exit()` inside an MCP tool handler kills the stdio server
 * mid-request, and the client reports the useless "Connection closed" rather
 * than the reason (see docs/troubleshooting.md).
 */
export function resolveLazyRoot(): string {
  const root = findLazyRoot();
  if (!root) {
    throw new LazyPreconditionError('not in a lazy project. Run `lazy init` first.');
  }
  if (!repoHasCommits(root)) {
    throw new LazyPreconditionError(
      'repository has no commits. Lazy requires at least one commit to function.\n' +
      "Run: git commit --allow-empty -m 'Initial commit'",
    );
  }
  return root;
}

/**
 * Try to create a RemoteStorage that proxies through the daemon.
 * Returns null if the daemon is unavailable or in test/daemon mode.
 */
export async function tryRemoteStorage(root: string): Promise<Storage | null> {
  // Skip daemon in test mode or when we ARE the daemon
  if (process.env.LAZY_TEST === '1') return null;
  if (process.env.LAZY_IS_DAEMON === '1') return null;

  const client = await DaemonClient.create(root);
  if (!client) return null;

  try {
    // Fetch the storage path from the daemon so getStoragePath()/getTaskDir() work.
    const info = await client.rpc('storage', root, {
      method: 'getStoragePath',
      args: {},
    }) as string;

    return new RemoteStorage(client, root, info);
  } catch (err) {
    // A bound clone reaches Teams, not a local daemon: returning null here
    // would end in "Start it with: lazy daemon start", which refuses there.
    if (client.teams) {
      const failure = boundCloneFailure(client.teams, err);
      if (failure instanceof RpcApplicationError) throw failure;
      throw new LazyPreconditionError(failure instanceof Error ? failure.message : String(failure));
    }
    // The daemon RESPONDED but the operation failed (e.g. storage-lock
    // contention, a 500). That is NOT "daemon not running" — surface it so the
    // real problem is visible instead of sending the user to restart a healthy
    // daemon. Only a transport failure (daemon genuinely unreachable) should
    // fall through to the null → "Daemon is not running" path.
    if (err instanceof RpcApplicationError) throw err;
    return null;
  }
}

/**
 * Create and initialize storage, THROWING if the daemon is not reachable.
 *
 * Use this — not `requireStorage()` — in any long-lived process. See
 * `resolveLazyRoot()` for why exiting from a tool handler is a bug.
 */
export async function resolveStorage(): Promise<Storage> {
  const root = resolveLazyRoot();

  const remote = await tryRemoteStorage(root);
  if (remote) return remote;

  // Test-mode fallback: under LAZY_TEST no daemon runs (tryRemoteStorage returns
  // null by design, see above), so the CLI process opens storage directly. This
  // restores the direct-storage path requireStorage had before the daemon-
  // required refactor (commit 48be24a3), which removed it so production fails
  // fast when the daemon is down — but left no test-mode escape hatch,
  // deterministically breaking every LAZY_TEST e2e suite. We reuse the daemon-
  // storage singleton (getOrCreateStorage) rather than a fresh FileStorage so
  // that requireStorage and any in-process rpc-fallback handlers share ONE
  // StorageLock: two instances in one process would contend on .storage-lock
  // (each has its own re-entrancy counter) and deadlock. Safe: each e2e test is
  // a single CLI subprocess against its own temp project. NOT a production path
  // — real invocations never set LAZY_TEST and fail fast below.
  if (process.env.LAZY_TEST === '1') {
    // Dynamic import avoids a static preconditions ↔ daemon/rpc-handlers cycle.
    const { initDaemonStorage, getOrCreateStorage } = await import('./daemon/rpc-handlers');
    initDaemonStorage(root);
    return getOrCreateStorage();
  }

  throw new LazyPreconditionError('Daemon is not running. Start it with: lazy daemon start');
}
