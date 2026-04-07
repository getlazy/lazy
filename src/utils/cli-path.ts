/**
 * Get the command prefix to re-invoke the current lazy CLI.
 *
 * Handles these invocation patterns:
 *   - Compiled:         process.argv = ['/path/to/lazy', 'start', ...]
 *   - bun script:       process.argv = ['/path/to/bun', '/path/to/src/index.ts', 'start', ...]
 *   - bun run script:   process.argv = ['/path/to/bun', '/path/to/src/index.ts', 'start', ...]
 *     (bun strips the 'run' subcommand from argv)
 *
 * Returns the base command array (without subcommand arguments).
 *
 * CRITICAL INVARIANT: The daemon must NEVER spawn lazy CLI as a subprocess.
 * Legitimate uses of this function:
 *   1. CLI forking the daemon process (src/daemon/auto-start.ts)
 *   2. Runner spawning supervisor/MCP processes (src/runner/host-process-runner.ts)
 *
 * These are different process roles. Spawning lazy from within the daemon
 * causes deadlocks (child RPCs back to parent) and storage lock contention.
 * If you're tempted to use this in daemon code, you're doing it wrong —
 * call the daemon's internal functions directly instead.
 */
export function getLazyCommand(): string[] {
  // Dev mode: argv[1] is a TypeScript/JavaScript file
  if (process.argv.length > 1 && /\.[tj]sx?$/.test(process.argv[1])) {
    return [process.execPath, process.argv[1]];
  }
  // Compiled mode: just the binary
  return [process.execPath];
}
