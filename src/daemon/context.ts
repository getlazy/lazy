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

// --- Pending-request signaling for reconcile priority inversion fix ---
//
// The daemon is single-threaded (Bun event loop). When the reconcile loop
// is doing heavy work, incoming HTTP requests queue behind it. These
// functions implement cooperative scheduling: HTTP handlers signal that a
// request is waiting, and the reconcile loop checks the flag between steps,
// yielding or aborting early so requests get served promptly.

let _pendingRequests = 0;

/**
 * Signal that an HTTP request has arrived and is waiting to be served.
 * Called by HTTP handlers before doing async work.
 */
export function signalPendingRequest(): void {
  _pendingRequests++;
}

/**
 * Signal that an HTTP request has been fully served.
 * Called by HTTP handlers after the response is sent.
 */
export function clearPendingRequest(): void {
  if (_pendingRequests > 0) _pendingRequests--;
}

/**
 * Check whether any HTTP requests are waiting to be served.
 * Used by the reconcile loop to decide whether to yield or abort.
 */
export function hasPendingRequests(): boolean {
  return _pendingRequests > 0;
}
