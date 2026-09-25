/**
 * Endpoint-host predicates.
 *
 * Sibling to `isHostedOllamaEndpoint` (./ollama.ts) and `isOpenRouterEndpoint`
 * (./openai-compat.ts): lazy decides which credential an upstream is paid with
 * from its HOSTNAME, so the whole rule stays in the config spelling
 * (`endpoint = "..."`) with no per-provider syntax.
 *
 * `isLocalEndpoint` is the "none" arm of that rule. A model server on this
 * machine (or on the LAN behind it) does not authenticate, so handing it a real
 * Anthropic or OpenAI key is a pure leak: the key travels to a process that
 * ignores it, and anything that can read that process's request log now has it.
 */

/**
 * Convert a Docker-internal endpoint to one reachable from the host.
 * Uses URL parsing so it only replaces the hostname, not substrings that
 * happen to contain "host.docker.internal".
 *
 * Lives here rather than next to the role-target helpers that used to own it so
 * that agent-profile resolution — which normalizes every `[agents.<name>]`
 * endpoint through it — can reach it without importing a module that now
 * depends on profiles.
 */
export function endpointForHost(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.hostname === 'host.docker.internal') {
      url.hostname = 'localhost';
      return url.toString().replace(/\/$/, '');
    }
    return endpoint;
  } catch {
    return endpoint;
  }
}

/** Hostnames that always name this machine, or the host of the container asking. */
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  // Container → host aliases. Docker Desktop, podman, and Docker's gateway name.
  'host.docker.internal',
  'host.containers.internal',
  'gateway.docker.internal',
]);

/**
 * True when the endpoint names this machine or the private network it sits on.
 *
 * Deliberately covers RFC1918 / link-local ranges as well as loopback: a model
 * server at 192.168.1.40 is exactly as unauthenticated as one at localhost, and
 * a user who pins one is pinning a local box, not a hosted provider.
 *
 * A hostname that merely RESOLVES to a private address is not detected — that
 * would need a DNS lookup on a config-load path, and the answer could differ
 * per machine and per moment. Such an endpoint is treated as remote, which is
 * the conservative direction for reachability but the exposing one for
 * credentials, so name a `credential` explicitly (including `credential =
 * "none"`) when pinning a private host by name.
 */
export function isLocalEndpoint(endpoint: string): boolean {
  if (!endpoint.trim()) return false;
  let host: string;
  try {
    // URL keeps IPv6 literals bracketed; strip so the comparisons below see the
    // address the user wrote.
    host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (!host) return false;
  if (LOCAL_HOSTNAMES.has(host)) return true;

  if (host.includes(':')) {
    // IPv6 literal: loopback, link-local (fe80::/10), unique-local (fc00::/7).
    return host === '::1' || /^fe[89ab]/.test(host) || /^f[cd]/.test(host);
  }

  // IPv4 literals. A name that merely ends in .local / .localhost is local by
  // convention (mDNS, and the reserved .localhost TLD).
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (host === 'local' || host === 'localhost') return true;
  return host.endsWith('.local') || host.endsWith('.localhost');
}
