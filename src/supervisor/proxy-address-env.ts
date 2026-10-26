/**
 * Point a KEPT container's supervisor at the proxy of the daemon serving now.
 *
 * The audit proxy runs inside the daemon on an OS-assigned port, and a task
 * container's env — `ANTHROPIC_BASE_URL`, `CURSOR_API_ENDPOINT`,
 * `LAZY_CODEX_API_BASE` — is fixed when the container is created. Containers
 * used to be stopped at every daemon restart for exactly that reason. Now a
 * restart stops only the agent and keeps the container (src/runner/agent-stop.ts),
 * so the new daemon tells every command it writes which port its proxy is on
 * (`proxy_port`, stamped by `writeCommand`), and the supervisor moves its OWN
 * env there before it starts the agent, which inherits it.
 *
 * Only the PORT moves. The container was created with
 * `LAZY_PROXY_BASE_URL` (the proxy base it was handed, e.g.
 * `http://host.docker.internal:41234`); every env value that starts with that
 * base is rewritten to the same base on the new port, and nothing else is
 * touched — credentials are unchanged, because the placeholders the container
 * holds are persisted grants and bindings that outlive the daemon process
 * (src/proxy/credential-broker.ts, src/daemon/session-credentials.ts).
 *
 * A container created before `LAZY_PROXY_BASE_URL` existed is read off its
 * `ANTHROPIC_BASE_URL` when that names the container spelling of the proxy
 * (`host.docker.internal`); anything else is left alone rather than guessed at.
 *
 * What it does NOT reach: processes already running in the container — the
 * services in its tmux sessions — keep the env they were started with. They
 * are the project's own programs and do not talk to lazy's proxy.
 */

/** The env var holding the proxy base a container's env was built against. */
export const PROXY_BASE_ENV = 'LAZY_PROXY_BASE_URL';

/**
 * The live proxy port, handed to an interactive session exec'd into a KEPT
 * container (`lazy-agent pair`, for Pair and Chat). A supervised turn learns it
 * from its command's `proxy_port`; an exec has no command, so the host launcher
 * passes it in the exec's env and the session moves its own env with
 * {@link applyProxyAddressEnv} before the agent starts. Without it, a Codex or
 * Cursor session opened after a daemon restart dialled the previous daemon's
 * port: their endpoint variables are fixed at container creation, and the
 * exec's overlay only ever refreshed the Anthropic ones.
 */
export const LIVE_PROXY_PORT_ENV = 'LAZY_LIVE_PROXY_PORT';

/** The host a container reaches the daemon's proxy at. */
const CONTAINER_PROXY_HOST = 'host.docker.internal';

function baseOf(env: Record<string, string | undefined>): string | null {
  const recorded = env[PROXY_BASE_ENV]?.trim();
  if (recorded) return recorded.replace(/\/$/, '');
  const anthropic = env.ANTHROPIC_BASE_URL?.trim();
  if (!anthropic) return null;
  try {
    const url = new URL(anthropic);
    return url.hostname === CONTAINER_PROXY_HOST && url.port ? url.origin : null;
  } catch {
    // Not a URL at all: nothing lazy wrote, so nothing to move.
    return null;
  }
}

/**
 * The env changes that point this process at the proxy on `port`: keys to set.
 * Empty when the port is unchanged, unknown, or the env names no proxy base.
 * Pure, so the decision is testable without touching process.env.
 */
export function proxyAddressEnvChanges(
  env: Record<string, string | undefined>,
  port: number | undefined,
): Record<string, string> {
  if (!port || !Number.isInteger(port) || port <= 0 || port > 65535) return {};
  const base = baseOf(env);
  if (!base) return {};
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return {};
  }
  if (url.port === String(port)) return {};
  url.port = String(port);
  const next = url.origin;
  const set: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (value === base || value.startsWith(`${base}/`)) set[key] = next + value.slice(base.length);
  }
  set[PROXY_BASE_ENV] = next;
  return set;
}

/** Apply {@link proxyAddressEnvChanges} to this process's env. Returns the new base, or null when nothing moved. */
export function applyProxyAddressEnv(port: number | undefined): string | null {
  const set = proxyAddressEnvChanges(process.env, port);
  if (Object.keys(set).length === 0) return null;
  for (const [key, value] of Object.entries(set)) process.env[key] = value;
  return set[PROXY_BASE_ENV] ?? null;
}
