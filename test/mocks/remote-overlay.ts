import { mock } from 'bun:test';
import { resolve } from 'path';

/**
 * The forge overlay alone, exported so an IN-PROCESS daemon suite can install
 * just this one (mock.module is process-wide and permanent; the claude and
 * oneshot mocks in preload-mocks.ts must not leak into other files). With no mock signal
 * present it falls through to the real factory.
 */
export function installRemoteMock(): void {
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
