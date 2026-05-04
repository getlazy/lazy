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
 *   - remote/index (when LAZY_MOCK_IMPORT_RESULT or LAZY_MOCK_ACCEPT_GATES is set)
 */

import { mock } from 'bun:test';
import { resolve } from 'path';

if (process.env.LAZY_TEST === '1' || process.env.LAZY_MOCK_CLAUDE_RESPONSE) {
  const mockClaudePath = resolve(__dirname, 'claude.ts');
  // The real module path — all relative imports resolve to this absolute path
  const realClaudePath = resolve(__dirname, '../../src/capture/claude.ts');

  mock.module(realClaudePath, () => require(mockClaudePath));

  // Mock the remote driver when a mock import result or accept gates are configured
  if (process.env.LAZY_MOCK_IMPORT_RESULT || process.env.LAZY_MOCK_ACCEPT_GATES) {
    const mockRemotePath = resolve(__dirname, 'remote.ts');
    const realRemotePath = resolve(__dirname, '../../src/remote/index.ts');

    mock.module(realRemotePath, () => require(mockRemotePath));
  }
}
