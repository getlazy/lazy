/**
 * Lazy configuration constants.
 *
 * These are default values that should be referenced throughout the codebase
 * rather than being duplicated as magic numbers.
 */

/**
 * Default TCP port for the web dashboard.
 * The daemon binds to this port for browser access (loopback only by default —
 * see DEFAULT_SERVER_BIND).
 */
export const DEFAULT_WEB_PORT = 26024;

/**
 * Default network interface the daemon's TCP server binds to.
 * Loopback only ('127.0.0.1') so the unauthenticated dashboard and the
 * /mcp + /rpc endpoints are NOT reachable from other machines on the network.
 * Users who want LAN/remote access must opt in explicitly via
 * `[server] bind = "0.0.0.0"` in lazy.toml.
 */
export const DEFAULT_SERVER_BIND = '127.0.0.1';
