/**
 * Bun preload script that mocks modules for e2e tests.
 *
 * Activated when either:
 *   - LAZY_TEST=1 (classic bypass-daemon test mode)
 *   - LAZY_MOCK_CLAUDE_RESPONSE is set (withDaemon test mode, where the
 *     daemon is real but agent responses are still mocked)
 *
 * Used via: bun run --preload test/mocks/preload-mocks.ts src/index.ts
 *
 * Uses mock.module() with absolute paths so that all relative imports
 * resolve to our mocks instead of the real modules.
 *
 * Mocked modules:
 *   - capture/claude (always when activated)
 *   - oneshot/index (always when activated)
 *   - remote/index (always when activated — createDriver only; see below)
 */

import { mock } from 'bun:test';
import { resolve } from 'path';
import { installRemoteMock } from './remote-overlay';

if (process.env.LAZY_TEST === '1' || process.env.LAZY_MOCK_CLAUDE_RESPONSE) {
  const mockClaudePath = resolve(__dirname, 'claude.ts');
  // The real module path — all relative imports resolve to this absolute path
  const realClaudePath = resolve(__dirname, '../../src/capture/claude.ts');

  mock.module(realClaudePath, () => require(mockClaudePath));

  // Machine one-shots go through their own dispatcher now (src/oneshot), so
  // they need their own mock. Mocking the DISPATCHER means a mocked run never
  // reaches the daemon RPC, the Runner, or a container.
  mock.module(
    resolve(__dirname, '../../src/oneshot/index.ts'),
    () => require(resolve(__dirname, 'oneshot.ts'))
  );

  installRemoteMock();
}
