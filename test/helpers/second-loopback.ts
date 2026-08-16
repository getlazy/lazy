/**
 * Availability gate for tests that need a SECOND loopback address.
 *
 * The daemon's dual-bind (one port, loopback + the container bridge) is a
 * socket-level mechanism, and the honest way to check it is to actually bind
 * two listeners on two local IPs. `127.0.0.2` is the cheap stand-in for a
 * second interface — but only on Linux, where the kernel gives the loopback
 * device the whole `127.0.0.0/8` range. macOS configures `lo0` with `127.0.0.1`
 * alone, so binding `127.0.0.2` fails with EADDRNOTAVAIL until someone adds an
 * alias by hand.
 *
 * That is a property of the HOST's interface list, not of the dual-bind
 * mechanism: nothing about macOS makes two listeners on one port across two
 * real interfaces behave differently. So a Mac without the alias has no way to
 * run this check, and skipping is the honest outcome.
 *
 * INVARIANT, same rule as `slowSuiteSkipped` / `sandboxSuiteSkipped`: a skipped
 * suite must never be silently green-by-omission. This prints exactly one line
 * saying what is missing and how to get it.
 */

/** The stand-in second interface. Loopback range, no privileges needed on Linux. */
export const SECOND_LOOPBACK_HOST = '127.0.0.2';

/**
 * Returns true when a suite needing {@link SECOND_LOOPBACK_HOST} should be
 * skipped, printing one line saying so. Intended for
 * `describe.skipIf(secondLoopbackSuiteSkipped('name'))(...)`.
 *
 * Probes by actually binding, rather than by branching on `process.platform`:
 * a Mac WITH the alias configured can run the check, and a Linux host with an
 * unusual network namespace might not.
 */
export function secondLoopbackSuiteSkipped(suiteName: string): boolean {
  try {
    const server = Bun.serve({
      hostname: SECOND_LOOPBACK_HOST,
      port: 0,
      fetch: async () => new Response('ok'),
    });
    server.stop(true);
    return false;
  } catch (err) {
    // Bun's bind error message guesses at "port in use", which is the wrong
    // diagnosis here — the errno (EADDRNOTAVAIL) is the part that identifies a
    // missing interface, so surface it when the runtime provides one.
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : null;
    const message = (err instanceof Error ? err.message : String(err)) + (code ? ` [${code}]` : '');
    console.log(
      `skipped: suite "${suiteName}" — this host cannot bind ${SECOND_LOOPBACK_HOST} ` +
        `(${message}). Linux gives loopback all of 127.0.0.0/8; macOS configures only ` +
        `127.0.0.1. Add the alias to run it: sudo ifconfig lo0 alias ${SECOND_LOOPBACK_HOST} up`,
    );
    return true;
  }
}
