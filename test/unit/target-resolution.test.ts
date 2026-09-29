import { describe, test, expect } from 'bun:test';
import { resolveTargetAddresses, describeTargetResolution } from '../../src/utils/target-resolution';

// INVARIANT: a "could not reach the daemon" message names what the target's
// host resolved to. A dead address is not proof the daemon is down, and the
// addresses are what tell "down" apart from "up, but not at the address this
// name gave".
describe('target resolution for unreachable-daemon messages', () => {
  test('names an IPv6-only answer as such', async () => {
    const r = await resolveTargetAddresses('http://host.docker.internal:26025', async () => ['fdc4:f303:9324::254']);
    expect(describeTargetResolution(r)).toBe('host.docker.internal resolved to fdc4:f303:9324::254 (IPv6 only)');
  });

  test('lists both families without a qualifier', async () => {
    const r = await resolveTargetAddresses('http://h:1', async () => ['192.168.65.254', 'fdc4::254']);
    expect(describeTargetResolution(r)).toBe('h resolved to 192.168.65.254, fdc4::254');
  });

  test('a failed lookup is named, not hidden', async () => {
    const r = await resolveTargetAddresses('http://nowhere:1', async () => { throw new Error('ENOTFOUND nowhere'); });
    expect(describeTargetResolution(r)).toBe('nowhere did not resolve (ENOTFOUND nowhere)');
  });

  test('IP literals add nothing', async () => {
    expect(await resolveTargetAddresses('http://127.0.0.1:1')).toBeNull();
    expect(await resolveTargetAddresses('http://[::1]:1')).toBeNull();
    expect(describeTargetResolution(null)).toBe('');
  });
});
