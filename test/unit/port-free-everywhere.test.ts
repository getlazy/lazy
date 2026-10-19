import { describe, test, expect } from 'bun:test';
import { kernelChosenPort, pickPortFreeEverywhere, portFreeEverywhere } from '../helpers/port-free-everywhere';
import { SECOND_LOOPBACK_HOST, secondLoopbackSuiteSkipped } from '../helpers/second-loopback';

describe.skipIf(secondLoopbackSuiteSkipped('free-port helper'))('pickPortFreeEverywhere', () => {
  for (const hostname of ['0.0.0.0', SECOND_LOOPBACK_HOST]) {
    // INVARIANT: a port held on any address the forwarder test touches is skipped, even when 127.0.0.1 alone would accept it.
    test(`skips a port held on ${hostname}`, () => {
      const held = kernelChosenPort();
      const holder = Bun.listen({ hostname, port: held, socket: { data() {} } });
      try {
        expect(portFreeEverywhere(held)).toBe(false);
        const free = kernelChosenPort();
        const queue = [held, free];
        expect(pickPortFreeEverywhere(() => queue.shift() as number)).toBe(free);
      } finally {
        holder.stop(true);
      }
    });
  }
});
