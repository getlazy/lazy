/**
 * Opt-in gate for slow test suites.
 *
 * A handful of e2e suites take >300s per file (they stand up real daemons,
 * poll real reconcile loops, and stack multi-second timeouts). Running them on
 * every `bun test` kills the pace of ordinary work, so they are opt-in: set
 * `LAZY_SLOW_TESTS=1` to run them.
 *
 * INVARIANT: a skipped slow suite must never be silently green-by-omission.
 * `slowSuiteSkipped()` prints exactly one clear line per gated file so a run
 * that skips them says so.
 *
 * `LAZY_SLOW_TESTS` is a test-only env var, in the same family as
 * `LAZY_FORCE_TTY` / `LAZY_PROMPT_DEFAULTS`. Never read it from production code.
 */

/** True when the caller opted into slow suites via `LAZY_SLOW_TESTS=1`. */
export const SLOW_TESTS_ENABLED = process.env.LAZY_SLOW_TESTS === '1';

/**
 * Returns true when the named slow suite should be skipped, printing one line
 * saying so. Intended for `describe.skipIf(slowSuiteSkipped('name'))(...)`.
 *
 * Called at module scope during test-file collection, so the notice lands in
 * the run output next to the suite it belongs to.
 */
export function slowSuiteSkipped(suiteName: string): boolean {
  if (SLOW_TESTS_ENABLED) return false;
  console.log(`skipped: slow suite "${suiteName}" — set LAZY_SLOW_TESTS=1 to run`);
  return true;
}
