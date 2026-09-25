/**
 * Daemon file paths.
 *
 * All daemon state lives under ~/.lazy/daemon/<project-slug>/ — PID file,
 * bearer token, TCP port/host markers, and log file. Each project gets its own
 * daemon directory derived from the project root path.
 *
 * Directory naming: <last-dir-component>-<sha256(projectRoot).slice(0,8)>
 * e.g., /home/user/prg/workshop → ~/.lazy/daemon/workshop-a1b2c3d4/
 *
 * Uses getHome() from utils/home which prefers $HOME over os.homedir()
 * because Bun's homedir() doesn't respect the HOME env var on some platforms.
 */

import { join, basename } from 'path';
import { createHash } from 'crypto';
import { getHome } from '../utils/home';

// Daemon state filenames within a per-project daemon dir. Centralized so that
// code which scans daemon dirs by slug (e.g. the daemon registry / operator
// `lazy daemon list`) can address files inside a dir it discovered WITHOUT a
// projectRoot to feed the path helpers, and without hardcoding string literals.
export const PID_FILE = 'lazy.pid';
/**
 * Pre-v0.22 daemons bound a unix socket at this name. The socket transport is
 * gone (drop-unix-socket) — the constant survives ONLY so cleanup can remove
 * the stale file an older daemon left behind. Never bind or connect to it.
 */
export const LEGACY_SOCKET_FILE = 'lazy.sock';
export const TOKEN_FILE = 'token';
/**
 * Records the last TCP web port the daemon successfully bound. Preferred on the
 * next start so a restart re-binds the SAME port — keeping the `target` in
 * daemon MCP configs already mounted into running containers/builders valid
 * (they call back via host.docker.internal:<webPort>). With the TCP port as the
 * daemon's only transport, this file (plus web-host) is also how the host-side
 * CLI finds the daemon. See getWebPortPath.
 */
export const WEB_PORT_FILE = 'web-port';
/**
 * Records the interface the daemon bound (= config.server.bind). Read together
 * with web-port by getDaemonTcpTarget so the CLI connects to the right
 * interface when [server] bind is moved off loopback. Absent (older daemon) →
 * loopback is assumed.
 */
export const WEB_HOST_FILE = 'web-host';
export const LOG_FILE = 'daemon.log';
/**
 * Registry binding each minted MCP bearer token to ONE identity (a task, or the
 * builder). See src/daemon/mcp-tokens.ts. Lives in the daemon dir, never under
 * the project root: task containers mount the repo read-only, so a per-task
 * token stored in-repo would be readable by every other agent.
 */
export const MCP_TOKENS_FILE = 'mcp-tokens.json';
/**
 * Registry binding each minted proxy PLACEHOLDER credential to ONE launch
 * identity (a task agent, or the builder). See src/proxy/credential-broker.ts.
 * Same placement rationale as MCP_TOKENS_FILE: task containers mount the repo
 * read-only, so a registry stored in-repo would be readable by every agent it
 * is meant to separate.
 */
export const PROXY_TOKENS_FILE = 'proxy-tokens.json';
/** Directory holding per-identity daemon MCP config files (see MCP_TOKENS_FILE). */
export const MCP_CONFIG_DIR = 'mcp';
/**
 * Per-task environment variables (`lazy env set`). See src/daemon/task-env.ts.
 * Same placement rule as MCP_TOKENS_FILE and for the same reason: task
 * containers bind-mount the project root read-only, so a per-task secret stored
 * under `<project>/.lazy/` would be readable by every other task's agent.
 */
export const TASK_ENV_FILE = 'task-env.json';
/**
 * Real per-user Anthropic credentials, written by the control plane over the
 * `putUserCredential` RPC. See src/daemon/user-credentials.ts. Same placement
 * rule as MCP_TOKENS_FILE, and here it is the whole point: a task container
 * must NEVER be able to read a real credential, and it bind-mounts the repo.
 */
export const USER_CREDENTIALS_FILE = 'user-credentials.json';
/**
 * Session-bound placeholder tokens handed to containers in place of a real
 * credential. See src/daemon/session-credentials.ts. Lives beside the real
 * credentials for the same reason: only the daemon may map one to the other.
 */
export const SESSION_CREDENTIALS_FILE = 'session-credentials.json';
/**
 * Model-provider credential secrets, when the credential store falls back to
 * its `file` backend (no OS keychain / Secret Service on this host). See
 * src/credentials/backends.ts. Same placement rule as USER_CREDENTIALS_FILE and
 * for the same reason: task containers bind-mount the project root, so a real
 * credential under `<project>/.lazy/` would be readable by every agent.
 */
export const CREDENTIALS_FILE = 'credentials.json';
/**
 * NON-SECRET index of what the credential store holds: provider, kind, which
 * backend the secret is in, when it was written. Never a secret value.
 *
 * Separate from the secrets so the daemon credential gate can answer "is there
 * a credential for this provider?" without touching the OS keychain — which on
 * macOS can block on a GUI unlock prompt, and the gate runs on every daemon
 * start including detached auto-starts with no session to answer one.
 */
export const CREDENTIAL_INDEX_FILE = 'credential-index.json';
/**
 * Browser sign-in state for the web dashboard: the one-time login tickets minted
 * by `lazy dashboard` and the cookie sessions they are exchanged for. See
 * src/daemon/dashboard-sessions.ts. Same placement rule as MCP_TOKENS_FILE, and
 * here it is the entire point: a task container bind-mounts the project root and
 * can reach the daemon's port, so a browser credential stored under
 * `<project>/.lazy/` would be readable by exactly the agents it excludes.
 */
export const DASHBOARD_SESSIONS_FILE = 'dashboard-sessions.json';
export const DAEMON_LOCK_FILE = 'daemon.lock';
/** Records the canonical project root the daemon serves (see getRootPath). */
export const ROOT_FILE = 'root';
/**
 * Worktree Dockerfile adoption written by `lazy upgrade` (Part 2 of the
 * worktree-image flow). Daemon runtime state — not env, not lazy.toml.
 * See src/daemon/adopted-image.ts.
 */
export const ADOPTED_IMAGE_FILE = 'adopted-image.json';
/**
 * Snapshot of the Dockerfile bytes consented at adoption time. Upgrade builds
 * read THIS file (outside any worktree), never the live worktree path — closes
 * the hash-then-rebuild TOCTOU where an agent edit between hash and
 * `docker build` would produce a mis-tagged image. Drift checks still compare
 * the live worktree path recorded in adopted-image.json.
 */
export const ADOPTED_DOCKERFILE_FILE = 'adopted-Dockerfile';

/**
 * Derive a human-readable, collision-resistant slug from a project root.
 * Format: <last-dir-component>-<sha256(projectRoot).slice(0,8)>
 */
export function projectSlug(projectRoot: string): string {
  const name = basename(projectRoot) || 'root';
  const hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

/**
 * Root directory for all daemon state: ~/.lazy/daemon/
 *
 * `LAZY_DAEMON_BASE_DIR` overrides the location. This is a test-isolation and
 * operator-override seam: the daemon registry and `lazy daemon list/kill-stray`
 * enumerate every daemon under this dir, so tests point it at a temp directory
 * to avoid scanning (or reaping!) the host's real daemons. Honored everywhere
 * because every daemon path flows through this function.
 */
export function getDaemonBaseDir(): string {
  const override = process.env.LAZY_DAEMON_BASE_DIR;
  if (override) return override;
  return join(getHome(), '.lazy', 'daemon');
}

/** Per-project daemon directory: ~/.lazy/daemon/<slug>/ */
export function getDaemonDir(projectRoot: string): string {
  return join(getDaemonBaseDir(), projectSlug(projectRoot));
}

/** PID file: ~/.lazy/daemon/<slug>/lazy.pid */
export function getPidPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), PID_FILE);
}

/** Legacy unix socket file: ~/.lazy/daemon/<slug>/lazy.sock — cleanup only. */
export function getLegacySocketPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), LEGACY_SOCKET_FILE);
}

/** Bearer token file: ~/.lazy/daemon/<slug>/token */
export function getTokenPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), TOKEN_FILE);
}

/** MCP token registry: ~/.lazy/daemon/<slug>/mcp-tokens.json */
export function getMcpTokensPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), MCP_TOKENS_FILE);
}

/** Per-task env registry: ~/.lazy/daemon/<slug>/task-env.json */
export function getTaskEnvPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), TASK_ENV_FILE);
}

/** Per-user real credential store: ~/.lazy/daemon/<slug>/user-credentials.json */
export function getUserCredentialsPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), USER_CREDENTIALS_FILE);
}

/** Credential-store secrets (file backend): ~/.lazy/daemon/<slug>/credentials.json */
export function getCredentialsPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), CREDENTIALS_FILE);
}

/** Non-secret credential index: ~/.lazy/daemon/<slug>/credential-index.json */
export function getCredentialIndexPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), CREDENTIAL_INDEX_FILE);
}

/** Session placeholder-token registry: ~/.lazy/daemon/<slug>/session-credentials.json */
export function getSessionCredentialsPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), SESSION_CREDENTIALS_FILE);
}

/** Proxy placeholder-credential registry: ~/.lazy/daemon/<slug>/proxy-tokens.json */
export function getProxyTokensPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), PROXY_TOKENS_FILE);
}

/** Dashboard login tickets + cookie sessions: ~/.lazy/daemon/<slug>/dashboard-sessions.json */
export function getDashboardSessionsPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), DASHBOARD_SESSIONS_FILE);
}

/** Per-identity daemon MCP config dir: ~/.lazy/daemon/<slug>/mcp/ */
export function getMcpConfigDir(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), MCP_CONFIG_DIR);
}

/** Last-bound web port marker: ~/.lazy/daemon/<slug>/web-port */
export function getWebPortPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), WEB_PORT_FILE);
}

/** Last-bound interface marker: ~/.lazy/daemon/<slug>/web-host */
export function getWebHostPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), WEB_HOST_FILE);
}

/** Daemon log file: ~/.lazy/daemon/<slug>/daemon.log */
export function getLogPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), LOG_FILE);
}

/** Project-root marker: ~/.lazy/daemon/<slug>/root
 *  Written by the daemon at startup with the absolute project root it serves.
 *  The slug only encodes basename + a hash of the root, so the full root can't
 *  be recovered from the dir name alone — this file is the source of truth that
 *  lets `lazy daemon list/kill-stray` show the real project path and detect
 *  daemons whose root has been deleted ("stray"). */
export function getRootPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), ROOT_FILE);
}

/** Startup lock file: ~/.lazy/daemon/<slug>/start.lock
 *  @deprecated Superseded by daemon.lock flock — kept for test compatibility. */
export function getStartLockPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'start.lock');
}

/** Exclusive daemon lock file: ~/.lazy/daemon/<slug>/daemon.lock
 *  Held by the running daemon for its entire lifetime via flock(2).
 *  When the daemon exits (cleanly or via crash/SIGKILL), the OS releases
 *  the lock automatically. This is the primary singleton enforcement. */
export function getDaemonLockPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'daemon.lock');
}

/** Startup error marker: ~/.lazy/daemon/<slug>/startup-error
 *  Written by a background daemon child just before it throws a fatal
 *  startup error (e.g., web-port bind failure). The parent process
 *  (startDaemonBackground) reads this file after its readiness poll
 *  times out, so it can surface the actual error to the user's terminal
 *  instead of a generic "daemon did not start within Ns" message.
 *  Cleared before each spawn. */
export function getStartupErrorPath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'startup-error');
}

/**
 * Adopted worktree image: ~/.lazy/daemon/<slug>/adopted-image.json
 *
 * Written by `lazy upgrade` when the human consents to run the daemon and all
 * non-pinned launches on a worktree's Dockerfile until the next upgrade
 * rebuild. See src/daemon/adopted-image.ts.
 */
export function getAdoptedImagePath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), ADOPTED_IMAGE_FILE);
}

/**
 * Consented Dockerfile bytes for the upgrade build:
 * ~/.lazy/daemon/<slug>/adopted-Dockerfile
 *
 * Written alongside adopted-image.json. Outside every task worktree so a
 * post-consent agent edit cannot change what `docker build` reads.
 */
export function getAdoptedDockerfilePath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), ADOPTED_DOCKERFILE_FILE);
}
