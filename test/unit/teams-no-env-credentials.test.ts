/**
 * Team mode never reads a credential from the daemon's environment or the
 * project credential store — for ANY credential name, including a custom one
 * the project's admin chose on `[endpoints.*]` (engineer decision 2026-10-07).
 *
 * Each test plants the SAME custom-named secret in both places a solo daemon
 * would find it — `LAZY_CREDENTIAL_<NAME>` in this process's env and the
 * project store — and asserts a team-mode turn neither launches nor spends on
 * it until the member connects their own, and then spends the member's.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../../src/config/loader';
import { namedCredentialEnvVar } from '../../src/credentials/providers';
import { setCredential, resolveCredential } from '../../src/credentials/store';
import { planTurnCredential, turnCredentialProblem } from '../../src/daemon/turn-credentials';
import { putEndpointCredential, setCredentialBillingMode, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import { bindTurnCredential, clearSessionCredentialCache } from '../../src/daemon/session-credentials';
import { buildProxyCredentialDeps, resolveMemberCredential } from '../../src/proxy/credential-deps';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { Storage } from '../../src/storage/interface';
import { pinConfig } from '../helpers/pin-config';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

const ALICE = 'alice@example.com';
const NAME = 'acme-gateway';
const ORIGIN = 'https://gateway.acme.example';
const ENV_VAR = namedCredentialEnvVar(NAME, 'api-key');
const ENV_SECRET = 'daemon-env-secret-must-never-spend';
const STORE_SECRET = 'project-store-secret-must-never-spend';
const TOML = `
[credentials]
backend = "file"
[endpoints.acme]
url = "${ORIGIN}"
credential = "${NAME}"
[agents.acme]
harness = "claude-code"
model = "acme-large"
named_endpoint = "acme"
`;

let root: string;
let undoConfig: () => void;
let undoBase: () => void;
let savedEnv: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-teams-no-env-'));
  await writeFile(join(root, 'lazy.toml'), TOML);
  undoConfig = pinConfig(root);
  undoBase = pinDaemonBaseDir(join(root, 'daemon'));
  clearUserCredentialCache(); clearSessionCredentialCache();
  savedEnv = process.env[ENV_VAR];
  process.env[ENV_VAR] = ENV_SECRET;
  await setCredential(root, { provider: NAME, kind: 'api-key', secret: STORE_SECRET });
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedEnv;
  clearUserCredentialCache(); clearSessionCredentialCache();
  undoConfig(); undoBase();
  await rm(root, { recursive: true, force: true });
});

const task = { id: 'task', agent_id: 'acme' };
const storage = { getTask: async () => task } as unknown as Storage;
const grant: CredentialGrant = {
  token: 'placeholder', role: 'agent', taskId: task.id, taskUuid: task.id, label: 'task',
  envKey: 'ANTHROPIC_API_KEY', profile: 'acme', createdAt: '',
} as CredentialGrant;

// INVARIANT: in team mode a custom-named credential is resolved ONLY from the
// turn owner's connected credentials — a `LAZY_CREDENTIAL_<NAME>` variable in
// the daemon's env and an entry in the project store are never spent, at the
// launch gate or in the proxy. Admins choose these names on the Configuration
// page; a fallback would bill the host's secret for a member's turn.
test('team mode refuses a custom-named credential the member has not connected, despite env and store', async () => {
  // Precondition: a SOLO daemon would find it (env wins over the store).
  expect((await resolveCredential(root, NAME))?.value).toBe(ENV_SECRET);

  await setCredentialBillingMode(root);
  expect(await turnCredentialProblem(root, { taskId: task.id, storage, owner: ALICE })).toContain('"acme"');
  await expect(planTurnCredential(root, { taskId: 'builder', sessionId: 's', spender: { email: ALICE }, spenderProfile: 'acme' }))
    .rejects.toThrow('"acme"');

  // The proxy: the per-upstream map is empty, and the member resolver refuses.
  const config = await loadConfig(root);
  const deps = buildProxyCredentialDeps(root, config, true);
  expect((await deps.targets.forTarget(ORIGIN)).kind).toBe('none');
  await bindTurnCredential(root, { taskId: task.id, sessionId: 's', ownerUserId: ALICE, kind: 'api-key' });
  const refused = await resolveMemberCredential(root, grant, undefined, { endpoint: 'acme', tier: undefined, upstream: ORIGIN, config } as never);
  expect(refused?.outcome.kind).toBe('missing');
  const leaked = JSON.stringify(refused);
  expect(leaked).not.toContain(ENV_SECRET);
  expect(leaked).not.toContain(STORE_SECRET);
});

// INVARIANT: once the member connects their own credential for the endpoint,
// a team-mode turn spends exactly that — never the env or store secret beside it.
test('team mode spends the member’s own connected credential, not env or store', async () => {
  await setCredentialBillingMode(root);
  await putEndpointCredential(root, { userId: ALICE, endpointId: 'acme', origin: ORIGIN, provider: NAME, kind: 'api-key', token: 'alice-own-secret' });
  expect(await turnCredentialProblem(root, { taskId: task.id, storage, owner: ALICE })).toBeNull();
  await bindTurnCredential(root, { taskId: task.id, sessionId: 's', ownerUserId: ALICE, kind: 'api-key' });
  const config = await loadConfig(root);
  const paid = await resolveMemberCredential(root, grant, undefined, { endpoint: 'acme', tier: undefined, upstream: ORIGIN, config } as never);
  expect(paid?.userId).toBe(ALICE);
  expect(paid?.outcome.kind).toBe('credential');
  const wire = JSON.stringify(paid);
  expect(wire).toContain('alice-own-secret');
  expect(wire).not.toContain(ENV_SECRET);
  expect(wire).not.toContain(STORE_SECRET);
});

// INVARIANT: the getAuthEnv RPC never hands a credential out of the daemon's
// env or store in team mode — it is the one path that returned a raw secret
// to any caller, member tokens included. Address-only requests still answer.
test('getAuthEnv refuses credential requests in team mode, and solo still resolves the env secret', async () => {
  const { handleGetAuthEnv } = await import('../../src/daemon/rpc-handlers');
  const params = { proxied: false, role: 'agent', label: 'probe', profile: 'acme' };
  // Positive control: solo resolves the planted env var.
  expect(JSON.stringify(await handleGetAuthEnv(root, params))).toContain(ENV_SECRET);

  await setCredentialBillingMode(root);
  for (const p of [params, { ...params, proxied: true }]) {
    const err = await handleGetAuthEnv(root, p).then(() => null, (e) => e as Error);
    expect(err?.message).toContain('connected credentials');
    expect(err?.message).not.toContain(ENV_SECRET);
    expect(err?.message).not.toContain(STORE_SECRET);
  }
  expect(await handleGetAuthEnv(root, { credentials: false, proxied: false })).toMatchObject({ authEnvVars: [] });
});
