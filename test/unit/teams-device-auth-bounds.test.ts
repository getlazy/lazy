/**
 * Unit tests: what the poll loop accepts from a Teams install, and how it paces
 * itself.
 *
 * Confirming the TYPE of a response field is not confirming its VALUE, and this
 * is an external surface — the thing on the other end of the URL is whatever the
 * person typed. Three groups: the bounds on the timings the install chooses,
 * which failures inside the loop are "not yet" rather than an answer, and the
 * backoff that keeps several logins behind one address from deadlocking.
 */

import { describe, test, expect } from 'bun:test';
import { pollDeviceToken, requestDeviceCode } from '../../src/teams/device-auth';
import { backedOffWaitMs } from '../../src/cli/commands/login';

const GRANT = {
  user_code: 'KTPX-9QFD',
  device_code: 'device-code-0123456789',
  verification_uri: 'https://teams.example.com/device',
};

function stubFetcher(extra: Record<string, unknown>): typeof fetch {
  return (async () => Response.json({ ...GRANT, ...extra }, { status: 201 })) as unknown as typeof fetch;
}

describe('device grant bounds', () => {
  test('the server-chosen timings are taken when they are sane', async () => {
    const grant = await requestDeviceCode(
      'https://teams.example.com',
      'ada-laptop',
      stubFetcher({ interval: 5, expires_in: 900 }),
    );
    expect(grant.interval).toBe(5);
    expect(grant.expiresIn).toBe(900);
  });

  // INVARIANT: both timings are clamped on read. An `expires_in` of 999999999 is
  // a number, and taking it at face value made `lazy login` poll essentially
  // forever while telling the person their code expired in sixteen million
  // minutes — the CLI prints this same clamped value, so the message and the
  // behaviour cannot disagree.
  test('an absurd expiry is clamped to an hour', async () => {
    const grant = await requestDeviceCode(
      'https://teams.example.com',
      'ada-laptop',
      stubFetcher({ interval: 5, expires_in: 999999999 }),
    );
    expect(grant.expiresIn).toBe(3600);
  });

  test('a busy-loop interval is clamped up and a glacial one down', async () => {
    const fast = await requestDeviceCode(
      'https://teams.example.com',
      'ada-laptop',
      stubFetcher({ interval: 0.001 }),
    );
    expect(fast.interval).toBe(1);

    const slow = await requestDeviceCode(
      'https://teams.example.com',
      'ada-laptop',
      stubFetcher({ interval: 86400 }),
    );
    expect(slow.interval).toBe(60);
  });

  test('a missing or nonsense timing falls back rather than poisoning the loop', async () => {
    const grant = await requestDeviceCode(
      'https://teams.example.com',
      'ada-laptop',
      stubFetcher({ interval: 'soon', expires_in: null }),
    );
    expect(grant.interval).toBe(5);
    expect(grant.expiresIn).toBe(900);
  });
});

describe('poll resilience', () => {
  const respondWith = (body: BodyInit, init: ResponseInit): typeof fetch =>
    (async () => new Response(body, init)) as unknown as typeof fetch;

  // INVARIANT: inside the poll loop, infrastructure failures are "not yet". A
  // proxy restarting in front of the install answers an HTML 502, and treating
  // that as an answer ended the login with "check the address" — fatal, wrong,
  // and reachable AFTER the human clicked Approve, which strands the token it
  // created with nobody told about it. The loop's own deadline is what ends a
  // login that never recovers.
  test('an HTML 502 from a proxy is treated as pending, not as a bad address', async () => {
    const outcome = await pollDeviceToken(
      'https://teams.example.com',
      'device-code-0123456789',
      respondWith('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
    expect(outcome.status).toBe('pending');
  });

  test('a non-JSON body with a 200 is also treated as pending', async () => {
    const outcome = await pollDeviceToken(
      'https://teams.example.com',
      'device-code-0123456789',
      respondWith('<html>maintenance</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    expect(outcome.status).toBe('pending');
  });

  // Still refused where the install gives a real answer: a dead end has a remedy
  // and must not be retried until the code expires.
  test('a JSON refusal is still a refusal', async () => {
    const outcome = await pollDeviceToken(
      'https://teams.example.com',
      'device-code-0123456789',
      respondWith(JSON.stringify({ status: 'denied', error: 'This request was denied.' }), {
        status: 410,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(outcome).toEqual({ status: 'refused', reason: 'This request was denied.' });
  });
});

describe('poll backoff', () => {
  // INVARIANT: `slow_down` makes the client wait LONGER. Adopting the interval
  // the server names is not backing off — it is the same interval the client was
  // already using. Where the limit is keyed by address, several logins from one
  // office or CI egress exhaust it together, every poll is refused, nobody thins
  // out, and each person is eventually told "nobody approved this login", which
  // is false.
  test('the wait grows on repeated slow_down, up to a ceiling', async () => {
    const server = 5_000;
    let wait = server;

    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      wait = backedOffWaitMs(wait, server);
      seen.push(wait);
    }

    expect(seen[0]).toBeGreaterThan(server);
    // Strictly increasing until it saturates, and never past the ceiling.
    expect(seen[0]).toBe(10_000);
    expect(seen[1]).toBe(20_000);
    expect(seen.at(-1)).toBe(60_000);
    expect(Math.max(...seen)).toBe(60_000);
  });

  // A server naming a LARGER interval still wins: it knows something we do not.
  test('a larger server interval is honoured over our own doubling', async () => {
    expect(backedOffWaitMs(5_000, 45_000)).toBe(45_000);
  });
});
