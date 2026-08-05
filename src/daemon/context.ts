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
  /**
   * Actual TCP port the Anthropic passthrough proxy bound to, once started.
   * Undefined when no `[proxy]` section is configured. May be an OS-assigned
   * port (when `[proxy] port` was omitted), so this — not the config — is the
   * source of truth for where proxied traffic flows.
   */
  proxyPort?: number;
}

let context: DaemonContext | null = null;

/**
 * Initialize daemon context. Called once by the server at startup.
 */
export function setDaemonContext(ctx: DaemonContext): void {
  context = ctx;
}

/**
 * Record the proxy's actual bound port after it starts (the proxy binds after
 * the web server, once the daemon context already exists). Idempotent.
 */
export function setDaemonProxyPort(proxyPort: number): void {
  if (context) context.proxyPort = proxyPort;
}

/**
 * Tear the context back down, so `hasDaemonContext()` reports false again.
 *
 * The lifecycle counterpart to {@link setDaemonContext}. The daemon process
 * itself never needs it (it exits rather than un-becoming a daemon); it exists
 * so a caller that installs a context can guarantee it does not leak into
 * unrelated code that legitimately runs outside the daemon.
 */
export function clearDaemonContext(): void {
  context = null;
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
