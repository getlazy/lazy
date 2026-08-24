/**
 * INVARIANT: every storage method `RemoteStorage` forwards over RPC must be
 * registered in the daemon's `STORAGE_METHODS` dispatch table.
 *
 * Adding a Storage method means touching several files, and the daemon's
 * dispatch table is the one that is easy to forget: nothing references it from
 * the interface, and `FileStorage`-backed unit tests pass without it. The
 * failure only appears once a real daemon is in the loop, as
 * `404 Unknown storage method: <name>` at runtime — which is exactly how
 * `updateTaskAgent` / `updateSessionAgent` shipped broken in
 * `allow-mid-task-agent-change` while every unit test was green.
 *
 * This test closes that gap at unit-test speed. It is a runtime check on the
 * dispatch side (`STORAGE_METHODS` is exported for this purpose) and a source
 * scan on the caller side, since `RemoteStorage` only names its methods inside
 * `this.call(...)` string literals. The scan self-guards below so it cannot
 * quietly degrade into a no-op that passes by finding nothing.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { STORAGE_METHODS } from '../../src/daemon/rpc-handlers';

const REMOTE_STORAGE = join(import.meta.dir, '../../src/storage/remote-storage.ts');

/**
 * Every method name RemoteStorage sends over the wire.
 *
 * Matches `this.call('name'` and `this.call<Whatever>('name'`. The `[^(]*`
 * skips a generic parameter of any shape without swallowing the call's own
 * parenthesis.
 */
async function forwardedMethodNames(): Promise<string[]> {
  const source = await readFile(REMOTE_STORAGE, 'utf8');
  const names = new Set<string>();
  for (const m of source.matchAll(/this\.call[^(]*\(\s*'([A-Za-z0-9_]+)'/g)) {
    names.add(m[1]!);
  }
  return [...names].sort();
}

describe('storage RPC method coverage', () => {
  // Guard: if the scan or the export ever stops finding things, this test must
  // fail loudly rather than pass by comparing two empty sets.
  test('the scan and the dispatch table are both non-trivial', async () => {
    const forwarded = await forwardedMethodNames();

    expect(forwarded.length).toBeGreaterThan(50);
    expect(Object.keys(STORAGE_METHODS).length).toBeGreaterThan(50);

    // Spot-check a few well-known names so a regex that matches garbage fails.
    expect(forwarded).toContain('createTask');
    expect(forwarded).toContain('getTask');
    expect(forwarded).toContain('updateTaskStatus');
  });

  test('every method RemoteStorage forwards is registered in STORAGE_METHODS', async () => {
    const forwarded = await forwardedMethodNames();
    const missing = forwarded.filter((name) => !(name in STORAGE_METHODS));

    expect(missing).toEqual([]);
  });

  // The agent-switching methods specifically — these are the ones that shipped
  // unregistered, so name them explicitly rather than relying on the sweep.
  test('the agent-switching storage methods are registered', () => {
    expect(STORAGE_METHODS).toHaveProperty('updateTaskAgent');
    expect(STORAGE_METHODS).toHaveProperty('updateSessionAgent');
  });
});
