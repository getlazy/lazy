/**
 * Module-mock isolation helper.
 *
 * Bun runs every test file in a single shared process and `mock.module()`
 * patches the global module registry. Those patches are NOT undone by
 * `mock.restore()` (which only restores spies), so a top-level `mock.module()`
 * in one file leaks into every file that runs afterwards — turning a clean
 * checkout's unit suite into a pile of order-dependent failures.
 *
 * Use `mockModule()` instead of `mock.module()` and call `restoreMockedModules()`
 * in an `afterAll`. `mockModule()` captures each module's real exports the first
 * time it is mocked (across the whole run), and `restoreMockedModules()`
 * re-installs those real exports so later files see the genuine module.
 */
import { mock } from 'bun:test';

const originals = new Map<string, unknown>();

/**
 * Install a module mock, capturing the module's real exports first so they can
 * be restored later. Must be awaited (it dynamically imports the real module
 * before the mock shadows it).
 */
export async function mockModule(path: string, factory: () => unknown): Promise<void> {
  if (!originals.has(path)) {
    try {
      // Snapshot the exports now: Bun's mock.module mutates the live module
      // namespace in place, so keeping a reference to it would later reflect the
      // mocked values. A shallow copy freezes the real exports.
      originals.set(path, { ...(await import(path)) });
    } catch {
      // The path may not resolve to a real module (e.g. a stale or wrong path
      // that mock.module tolerated as a no-op). There is nothing real to
      // restore, so don't track it — just install the mock below.
    }
  }
  mock.module(path, factory);
}

/** Re-install the real exports for every module ever mocked via `mockModule`. */
export function restoreMockedModules(): void {
  for (const [path, real] of originals) {
    mock.module(path, () => real);
  }
}
