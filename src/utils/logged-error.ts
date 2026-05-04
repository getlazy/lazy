/**
 * Mark an Error as already written to the daemon log file.
 *
 * In background daemon mode (LAZY_DAEMON_BACKGROUND=1), the child's
 * stdout/stderr are redirected to daemon.log via an O_APPEND fd. When
 * startup code logs a fatal error via logger.error() and then throws,
 * the top-level CLI catch in src/index.ts would otherwise re-emit the
 * same message via console.error — landing an untimestamped duplicate
 * in daemon.log next to the logger's timestamped copy.
 *
 * The marker lives in a module-scoped WeakSet so the Error object
 * itself is not mutated with ad-hoc properties, and the `as` cast
 * for the flag lives in exactly one place.
 */

const loggedErrors = new WeakSet<Error>();

export function markLoggedToFile(err: Error): Error {
  loggedErrors.add(err);
  return err;
}

export function isLoggedToFile(err: unknown): boolean {
  return err instanceof Error && loggedErrors.has(err);
}
