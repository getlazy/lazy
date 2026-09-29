/**
 * Say which ADDRESSES a daemon target's host name resolved to, for the message
 * a client prints when that target did not answer.
 *
 * A recorded address that does not answer is not proof the daemon is down: a
 * stopped daemon, a moved port and an address this process cannot reach all
 * look the same from here. Naming the address and what its host name resolved
 * to is what lets the reader tell them apart instead of restarting a daemon
 * that was fine.
 */
import { lookup } from 'node:dns/promises';

export interface TargetResolution {
  /** The host part of the target (brackets stripped for an IPv6 literal). */
  host: string;
  /** Resolved addresses, in resolver order; empty when resolution failed. */
  addresses: string[];
  /** Why resolution failed, when it did. */
  error?: string;
}

/** Bound on the lookup: this runs on an error path and must not add a hang. */
const RESOLVE_TIMEOUT_MS = 2_000;

export async function resolveTargetAddresses(
  target: string,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<TargetResolution | null> {
  let host: string;
  try {
    host = new URL(target).hostname.replace(/^\[|\]$/g, '');
  } catch {
    // Not a URL: there is no host to resolve, so there is nothing to add to the
    // message — the caller already prints the target verbatim beside this.
    return null;
  }
  // An IP literal resolves to itself; there is nothing to add.
  if (/^[\d.]+$/.test(host) || host.includes(':')) return null;
  try {
    const addresses = await Promise.race([
      resolve(host),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`no answer within ${RESOLVE_TIMEOUT_MS}ms`)), RESOLVE_TIMEOUT_MS).unref?.(),
      ),
    ]);
    return { host, addresses };
  } catch (err) {
    return { host, addresses: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function defaultResolve(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
}

/**
 * One clause for an error message: "host.docker.internal resolved to
 * fdc4::254 (IPv6 only)". Empty for an IP literal or an unparsable target.
 */
export function describeTargetResolution(resolution: TargetResolution | null): string {
  if (!resolution) return '';
  if (resolution.addresses.length === 0) {
    return `${resolution.host} did not resolve${resolution.error ? ` (${resolution.error})` : ''}`;
  }
  const v6 = resolution.addresses.filter((a) => a.includes(':')).length;
  const family = v6 === resolution.addresses.length ? ' (IPv6 only)'
    : v6 === 0 ? ' (IPv4 only)' : '';
  return `${resolution.host} resolved to ${resolution.addresses.join(', ')}${family}`;
}
