/**
 * Daemon process context — module-level state available to all daemon code.
 *
 * Set once by the server at startup. Used by RPC handlers and the task
 * launcher to access daemon-owned resources (webPort, token) without
 * needing to check health or read files.
 */

export interface DaemonContext {
  /** TCP port the web dashboard is listening on. */
  webPort: number;
  /** Bearer token for daemon authentication. */
  token: string;
}

let context: DaemonContext | null = null;

/**
 * Initialize daemon context. Called once by the server at startup.
 */
export function setDaemonContext(ctx: DaemonContext): void {
  context = ctx;
}

/**
 * Check whether daemon context has been initialized.
 * Returns false when running outside the daemon process (e.g., in-process
 * RPC fallback during tests or when the daemon is not running).
 */
export function hasDaemonContext(): boolean {
  return context !== null;
}

/**
 * Get the daemon context. Throws if not initialized (should never happen
 * in daemon process — indicates a startup ordering bug).
 */
export function getDaemonContext(): DaemonContext {
  if (!context) {
    throw new Error('Daemon context not initialized — setDaemonContext() must be called at startup');
  }
  return context;
}
