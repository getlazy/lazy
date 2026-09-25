/**
 * Liveness for `[serve]` services: is anything actually LISTENING behind the
 * published host port?
 *
 * The probe is the slightest of TCP pings, by contract: connect, and the moment
 * the connect succeeds, close. No bytes are ever written, so the app behind the
 * port sees an accept followed by an immediate close — never a request, never a
 * log line of consequence, never a side effect. That contract is why every
 * surface (CLI `lazy url`, the daemon's `servePorts` RPC, the web Services
 * card) shares THIS implementation instead of rolling its own "quick check".
 *
 * Nothing here is cached: a probe answers "right now", and the surfaces that
 * call it do so once per render. Probes run in parallel with a short per-probe
 * timeout, so the total cost is bounded by the slowest single probe, not the
 * service count.
 */

import { connect } from 'net';
import type { ResolvedService } from './ports';

/**
 * Per-probe timeout. A published loopback port answers a SYN in microseconds;
 * anything that takes longer than this is not going to answer a human's click
 * either, so "slow" and "not listening" may honestly collapse into one answer.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 300;

/** A declared service resolved against live bindings, plus whether it answers. */
export interface ProbedService extends ResolvedService {
  /**
   * true — a TCP connect to the host port succeeded (something is listening).
   * false — the connect was refused or timed out.
   * null — the probe could not be attempted: the port has no live binding
   * (container down, no container runner, or created before this port was
   * declared), so there is nothing to connect to.
   */
  listening: boolean | null;
}

/**
 * One TCP connect against `host:port`. Resolves true on connect, false on
 * refusal or timeout — never throws and never sends a byte.
 */
export function probeTcpListening(
  host: string,
  port: number,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // destroy(), not end(): end() would negotiate a FIN handshake we do not
      // need — the contract is "close immediately, send nothing".
      socket.destroy();
      resolve(result);
    };
    // An explicit timer, not socket.setTimeout(): the socket's own timeout is
    // an INACTIVITY timer and its semantics around the connect phase are
    // subtler than "this probe may cost at most timeoutMs".
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Probe every service that has a live binding, in parallel. A service with no
 * binding gets `listening: null` — there is no port to connect to, and
 * inventing false there would read as "your server crashed" when the truth is
 * "nothing is published".
 */
export async function probeServices(
  services: ResolvedService[],
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbedService[]> {
  return Promise.all(
    services.map(async (service) => ({
      ...service,
      listening: service.binding
        ? await probeTcpListening(service.binding.hostAddress, service.binding.hostPort, timeoutMs)
        : null,
    })),
  );
}
