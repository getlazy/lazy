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
 */
export function getLazyCommand(): string[] {
  // Dev mode: argv[1] is a TypeScript/JavaScript file
  if (process.argv.length > 1 && /\.[tj]sx?$/.test(process.argv[1])) {
    return [process.execPath, process.argv[1]];
  }
  // Compiled mode: just the binary
  return [process.execPath];
}
