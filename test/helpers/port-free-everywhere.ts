/**
 * Picks a TCP port free on every address a forwarder-style test touches.
 *
 * INVARIANT: port 0 only promises the port is free on the ONE address it was
 * bound on. A test that serves on 127.0.0.1 and has socat listen on
 * 127.0.0.2:<same port> must also know 0.0.0.0 and 127.0.0.2 are free, or any
 * other suite listening there makes socat's bind fail at once. (A 127.0.0.2
 * listener does not stop a 127.0.0.1 bind; a 0.0.0.0 one stops both.)
 */
import { SECOND_LOOPBACK_HOST } from './second-loopback';

const ADDRESSES = ['0.0.0.0', SECOND_LOOPBACK_HOST, '127.0.0.1'];

export function portFreeEverywhere(port: number): boolean {
  for (const hostname of ADDRESSES) {
    try {
      Bun.listen({ hostname, port, socket: { data() {} } }).stop(true);
    } catch {
      return false;
    }
  }
  return true;
}

/** A kernel-chosen candidate, released at once. */
export function kernelChosenPort(): number {
  const probe = Bun.listen({ hostname: '0.0.0.0', port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

export function pickPortFreeEverywhere(candidate: () => number = kernelChosenPort, attempts = 20): number {
  for (let i = 0; i < attempts; i++) {
    const port = candidate();
    if (portFreeEverywhere(port)) return port;
  }
  throw new Error(`no port free on ${ADDRESSES.join(', ')} after ${attempts} tries`);
}
