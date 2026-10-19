import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

// INVARIANT: the daemon publishes its task proxy address BEFORE any startup step
// that awaits the store. A Teams project start waits on that address, and steps
// gated behind a store walk or a slow store open can outlast it. Source order is the
// guard because the slow case needs a big store on a slow mount to reproduce.
describe('daemon startup order', () => {
  test('the proxy port is published before the store-walking migrations', async () => {
    const src = await readFile(join(import.meta.dir, '../../src/daemon/server.ts'), 'utf-8');
    const publish = src.indexOf('setDaemonProxyPort(proxyServer.port)');
    const prune = src.indexOf('pruneLegacyAuditLog(storePath)');
    expect(publish).toBeGreaterThan(0);
    for (const step of ['migrateFollowUpsToRaisedItems()', 'migrateActorIdentity()', 'importStartServicesCmdFromConfig(']) {
      const at = src.indexOf(step);
      expect(at).toBeGreaterThan(0);
      expect(publish).toBeLessThan(at);
    }
    // The legacy audit-log cleanup opens the store; it runs after the publish too.
    expect(publish).toBeLessThan(prune);
  });
});
