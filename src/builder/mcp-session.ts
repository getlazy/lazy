/**
 * Lifecycle of a builder session's daemon MCP credential.
 *
 * A builder session is bracketed by two daemon calls: `lazy builder` asks the
 * daemon to mint a config (and with it a token bound to the `builder` identity),
 * and — once the builder supervisor has exited — asks it to revoke that token
 * again. Nothing else observes the end of a builder session: the human closes
 * the terminal, and the daemon never hears about it. Without the revoke call the
 * credential stayed valid for as long as the registry kept the record (bounded
 * only by its 50-entry builder cap), so a config file recovered from an exited
 * session was still a working key to the builder MCP surface.
 *
 * Revocation goes through the daemon (RPC), never by editing the registry file
 * directly: the daemon caches the registry in memory and only re-reads it on a
 * token miss, so a file rewritten behind its back would leave the revoked token
 * still accepted by the running daemon.
 */

import { queryRevokeDaemonMcpToken } from '../daemon/rpc-fallback';
import { logger } from '../utils/logger';

/**
 * Revoke a builder session's MCP token. Best effort by design.
 *
 * This runs on the way out of `lazy builder`, after the builder container has
 * exited. A daemon that has since crashed, been stopped, or is otherwise
 * unreachable must NOT turn a normal builder exit into a failure — the human
 * has already finished their session and there is nothing left to protect in
 * this process. The failure is logged (never swallowed silently) and the stale
 * token is still bounded by the registry's builder cap.
 */
export async function revokeBuilderMcpToken(name: string): Promise<void> {
  try {
    await queryRevokeDaemonMcpToken({ name });
  } catch (err) {
    logger.warn(
      `Could not revoke the builder's daemon MCP token (${name}): ` +
      `${err instanceof Error ? err.message : String(err)}. ` +
      `The token remains valid until the daemon retires it; restart the daemon to clear it now.`,
    );
  }
}
