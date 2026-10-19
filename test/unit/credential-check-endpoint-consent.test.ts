import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkUserCredential } from '../../src/daemon/credential-check';
import { clearUserCredentialCache, putEndpointCredential } from '../../src/daemon/user-credentials';
import { pinConfig } from '../helpers/pin-config';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

let root: string;
let undoConfig: () => void;
let undoBase: () => void;
const member = 'probe@example.com';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-probe-consent-'));
  undoConfig = pinConfig(root);
  undoBase = pinDaemonBaseDir(join(root, 'daemon'));
  clearUserCredentialCache();
});

afterEach(async () => {
  clearUserCredentialCache();
  undoConfig();
  undoBase();
  await rm(root, { recursive: true, force: true });
});

async function connect(origin: string) {
  await putEndpointCredential(root, { userId: member, endpointId: 'builtin:anthropic', origin,
    provider: 'anthropic', kind: 'api-key', token: 'probe-test-secret' });
}

// INVARIANT: a credential probe uses the same origin consent and provider checks as model traffic. A Rails precheck cannot authorize a later daemon destination.
test('changed origin and non-Anthropic consent never send a probe', async () => {
  await writeFile(join(root, 'lazy.toml'), '[proxy]\nupstream = "https://gateway.example"\n');
  let calls = 0;
  const fetchImpl = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
  for (const origin of ['https://api.anthropic.com', 'https://gateway.example']) {
    await connect(origin);
    await expect(checkUserCredential(root, member, { fetchImpl })).rejects.toThrow('No request was sent');
    expect(calls).toBe(0);
  }
});

// INVARIANT: path-only changes retain origin consent, but credential-bearing probes must never follow a redirect to another destination.
test('a consented Anthropic path probes with redirects disabled', async () => {
  await writeFile(join(root, 'lazy.toml'), '[proxy]\nupstream = "https://api.anthropic.com/base"\n');
  await connect('https://api.anthropic.com');
  const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), redirect: init?.redirect });
    return Response.json({});
  }) as typeof fetch;
  expect((await checkUserCredential(root, member, { fetchImpl })).ok).toBe(true);
  expect(requests).toEqual([{ url: 'https://api.anthropic.com/base/v1/models', redirect: 'error' }]);
});
