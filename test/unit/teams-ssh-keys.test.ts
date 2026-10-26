import { describe, test, expect } from 'bun:test';
import { registerSshKey } from '../../src/teams/ssh-keys';

function fetcher(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const base = { teamsUrl: 'https://teams.example/', token: 'tok', publicKey: 'ssh-ed25519 AAAA me@laptop', name: 'lazy@laptop' };

describe('registerSshKey', () => {
  // INVARIANT: registering is POSTed to the CLI endpoint with the member's token, and a 201 yields the new record.
  test('201: a new key is registered', async () => {
    const f = fetcher(201, { ssh_key: { id: 7, name: 'lazy@laptop', fingerprint: 'SHA256:abc' } });
    const key = await registerSshKey({ ...base, fetcher: f.fn });
    expect(key).toEqual({ id: '7', name: 'lazy@laptop', fingerprint: 'SHA256:abc' });
    expect(f.calls[0]!.url).toBe('https://teams.example/api/cli/ssh_keys');
    expect(f.calls[0]!.init.method).toBe('POST');
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ public_key: base.publicKey, name: base.name });
  });

  // INVARIANT: re-running --install is safe: an already-registered key (200) is the existing record, not an error.
  test('200: an already-registered key returns the existing record', async () => {
    const f = fetcher(200, { ssh_key: { id: 3, name: 'older-name', fingerprint: 'SHA256:abc' } });
    expect(await registerSshKey({ ...base, fetcher: f.fn })).toEqual({ id: '3', name: 'older-name', fingerprint: 'SHA256:abc' });
  });

  // INVARIANT: a refusal surfaces Teams' own message, naming the server.
  test('422: the error message is carried into the thrown error', async () => {
    const f = fetcher(422, { error: 'Public key is not a valid OpenSSH key' });
    await expect(registerSshKey({ ...base, fetcher: f.fn })).rejects.toThrow(
      'https://teams.example/ refused to register your SSH key: Public key is not a valid OpenSSH key',
    );
  });
});
