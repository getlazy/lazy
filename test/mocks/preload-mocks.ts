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

  // Overlay createDriver so a mock forge can be injected per-call from env
  // or from files under LAZY_PROTOCOL_BASE. Always wrap (not only when an
  // env var is set at preload): daemon-backed suites write those files after
  // the daemon has started, and a late wrap would miss them.
  //
  // Do NOT require src/remote/index.ts at preload — that hangs every
  // daemon-backed `lazy start` after pre-flight (module init / circular
  // import). Resolve the real module on first createDriver instead.
  //
  // INVARIANT: mock.module replaces the WHOLE module — snapshot real exports
  // first, then overlay only createDriver. A hand-maintained partial re-export
  // list drifts every time src/remote/index.ts gains a symbol (e.g.
  // resolveUpstreamMergeRef) and kills daemon-backed e2e at startup.
  // require() of a mocked path returns the mock, so the real module is loaded
  // via a distinct specifier (`?unmocked`) that bun does not wrap.
  const mockRemotePath = resolve(__dirname, 'remote.ts');
  const realRemotePath = resolve(__dirname, '../../src/remote/index.ts');
  const unmockedRemotePath = `${realRemotePath}?unmocked`;

  let realRemote: Record<string, unknown> | null = null;
  const getRealRemote = (): Record<string, unknown> => {
    if (!realRemote) {
      realRemote = require(unmockedRemotePath) as Record<string, unknown>;
    }
    return realRemote;
  };

  mock.module(realRemotePath, () => {
    const mockRemote = require(mockRemotePath);
    const real = getRealRemote();
    const realCreateDriver = real.createDriver as (
      config: unknown,
      context?: unknown,
      options?: unknown,
    ) => unknown;
    return {
      ...real,
      createDriver: (config: unknown, context?: unknown, options?: unknown) => {
        // Offline, the real factory answers a LocalDriver whatever the config
        // says — and so must the fake forge, or an offline code path is never
        // exercised at all under it (it would keep talking to the "forge").
        if ((options as { offline?: boolean } | undefined)?.offline) {
          return realCreateDriver(config, context, options);
        }
        const mocked = mockRemote.tryCreateMockDriver();
        if (mocked) return mocked;
        return realCreateDriver(config, context, options);
      },
    };
  });
}
