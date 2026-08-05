/**
 * Pin config resolution to a test project's own lazy.toml.
 *
 * WHY THIS EXISTS: a test that calls `startDaemonServer()` IN-PROCESS gets a
 * daemon that resolves its config the way `loadConfig` does by default —
 * walking UP from `process.cwd()`. Under `bun test` that is lazy's own worktree,
 * whose lazy.toml is a real developer config: it points `[storage]
 * external_path` at the developer's live store. So the daemon under test
 * quietly adopts settings belonging to the repo it is being tested in.
 *
 * The consequences are environment-dependent, which is what makes this so
 * expensive to debug:
 *
 *   - In a clean container, `/Users/<dev>/.lazy/<project>/` cannot be created →
 *     the daemon dies in ~200ms with
 *     `Daemon failed to start the [proxy] server: EACCES: permission denied,
 *     mkdir '/Users/…'` (this is what daemon-events.test.ts hit).
 *   - On the developer's own machine that path EXISTS, so nothing errors — the
 *     test daemon simply attaches to the LIVE store and contends for its
 *     `.storage-lock` with the developer's real daemon.
 *
 * Same defect, opposite symptoms, and neither one points at the actual cause.
 *
 * Pinning `LAZY_CONFIG` to an absolute path short-circuits the upward walk
 * entirely (`src/config/loader.ts`), so the test reads exactly the config its
 * fixture created — no matter what cwd is or whose machine it runs on.
 *
 * `process.chdir(ctx.root)` is the older workaround for this and is weaker: it
 * is process-global, must be undone, and leaves resolution implicit. Note that
 * an unrelated earlier `chdir` can also MASK the bug (cwd lands somewhere with
 * no lazy.toml above it), which is why the same test can pass in one file and
 * fail in another.
 *
 * Subprocesses started via `ctx.lazy()` already run with `cwd = ctx.root`, so
 * they only need `LAZY_CONFIG` passed explicitly when their env is overridden.
 */

import { join } from 'path';

/**
 * Point `LAZY_CONFIG` at `<projectRoot>/lazy.toml`.
 *
 * @returns a restore function to call in the test's `finally` / `afterEach`.
 */
export function pinConfig(projectRoot: string): () => void {
  const original = process.env.LAZY_CONFIG;
  process.env.LAZY_CONFIG = join(projectRoot, 'lazy.toml');
  return () => {
    if (original === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = original;
  };
}
