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

/**
 * How many consecutive ports the daemon web server tries (starting at the
 * desired port) before it gives up and fails with an actionable error.
 *
 * This is a deliberate, bounded window — NOT "retry until something is free".
 * It exists so several legitimate lazy projects can run on one host at once
 * (each daemon takes the next free port), while still failing hard when the
 * range is genuinely exhausted.
 *
 * The cap is intentionally small (not 100+). A large window is a footgun: when
 * dozens of stray daemons occupy the low ports, a big walk silently shoves the
 * real daemon onto a far-off port. Browsers and containers still hit the
 * DEFAULT_WEB_PORT and land on a stray with an empty store — the daemon looks
 * "broken" with no error. A small window means that situation surfaces as a
 * hard, actionable failure (pointing at `lazy daemon kill-stray`) instead.
 * 20 concurrent daemons on one host is already far beyond realistic use.
 */
export const MAX_PORT_ATTEMPTS = 20;
