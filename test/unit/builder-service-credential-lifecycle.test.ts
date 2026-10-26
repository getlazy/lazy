import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleEndBuilderSession, handleStartBuilderSession, handleStopBuilderSession } from '../../src/daemon/builder-sessions';
import { closeAllStorage, getOrCreateStorage, initDaemonStorage } from '../../src/daemon/rpc-handlers';
import { createSessionCredentialResolver, planTurnCredential } from '../../src/daemon/turn-credentials';
import { clearSessionCredentialCache, getTaskSessionBinding, lookupSessionBinding } from '../../src/daemon/session-credentials';
import { clearUserCredentialCache, putEndpointCredential, putUserCredential, SERVICE_CREDENTIAL_USER_ID, setCredentialBillingMode } from '../../src/daemon/user-credentials';
import { pinConfig } from '../helpers/pin-config';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';

enableInProcessTestMode();
let root: string;
let unpin: () => void;
let unpinBase: () => void;
let previousHomes: string | undefined;
let previousHostRunner: string | undefined;
const BUILDER_ID = 'd0e5a075';
const HOLDER = 'holder@example.com';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-service-builder-lifecycle-'));
  await writeFile(join(root, 'lazy.toml'), `
[storage]
backend = "external"
external_path = "${join(root, 'store')}"
[runner]
type = "dangerously-host-process-without-any-isolation"
`);
  unpin = pinConfig(root);
  unpinBase = pinDaemonBaseDir(join(root, 'daemon'));
  previousHomes = process.env.LAZY_BUILDER_HOMES_BASE_DIR;
  process.env.LAZY_BUILDER_HOMES_BASE_DIR = join(root, 'homes');
  previousHostRunner = process.env.LAZY_ALLOW_HOST_RUNNER;
  process.env.LAZY_ALLOW_HOST_RUNNER = '1';
  clearUserCredentialCache(); clearSessionCredentialCache();
  await setCredentialBillingMode(root);
  await putUserCredential(root, { userId: SERVICE_CREDENTIAL_USER_ID, ownerEmail: HOLDER, kind: 'api-key', token: 'service-reference' });
  await putEndpointCredential(root, { userId: HOLDER, endpointId: 'builtin:anthropic', origin: 'https://api.anthropic.com', provider: 'anthropic', kind: 'api-key', token: 'holder-test-secret' });
  initDaemonStorage(root);
});

afterEach(async () => {
  await closeAllStorage();
  clearUserCredentialCache(); clearSessionCredentialCache();
  unpin(); unpinBase();
  if (previousHomes === undefined) delete process.env.LAZY_BUILDER_HOMES_BASE_DIR;
  else process.env.LAZY_BUILDER_HOMES_BASE_DIR = previousHomes;
  if (previousHostRunner === undefined) delete process.env.LAZY_ALLOW_HOST_RUNNER;
  else process.env.LAZY_ALLOW_HOST_RUNNER = previousHostRunner;
  await rm(root, { recursive: true, force: true });
});

async function serviceSession(state: 'running' | 'stopped') {
  const plan = await planTurnCredential(root, { taskId: BUILDER_ID, sessionId: BUILDER_ID, spenderProfile: 'claude-code' });
  if (plan.mode !== 'session') throw new Error('expected a service-holder binding');
  const now = new Date().toISOString();
  const session = await (await getOrCreateStorage()).createBuilderSession({
    id: 'service-session', projectRoot: root, memberEmail: null, kind: 'interactive',
    state, builderId: BUILDER_ID, containerName: null, agentSessionId: state === 'stopped' ? 'prior-conversation' : null,
    createdAt: now, updatedAt: now, endedAt: null,
  });
  expect((await createSessionCredentialResolver(root)(plan.token)).ok).toBe(true);
  return { session, token: plan.token };
}

// INVARIANT: stopping or ending a service-backed builder revokes its placeholder even when its session has no member email. An ended launch cannot keep spending the holder's account.
for (const verb of ['stop', 'end'] as const) test(`${verb} revokes the service-backed session binding`, async () => {
  const { session, token } = await serviceSession('running');
  const result = verb === 'stop'
    ? await handleStopBuilderSession(root, { id: session.id })
    : await handleEndBuilderSession(root, { id: session.id });
  expect(result.state).toBe(verb === 'stop' ? 'stopped' : 'ended');
  expect(await lookupSessionBinding(root, token)).toBeNull();
  expect((await createSessionCredentialResolver(root)(token)).ok).toBe(false);
});

// INVARIANT: a failed service-backed launch releases the binding created before infrastructure checks. Refusing an unsupported runner must not leave a spendable placeholder.
test('a failed fresh launch revokes its planned service binding', async () => {
  await expect(handleStartBuilderSession(root, {})).rejects.toThrow('require the docker/podman runner');
  const [session] = await (await getOrCreateStorage()).listBuilderSessions(root);
  expect(session.state).toBe('ended');
  const binding = await getTaskSessionBinding(root, session.builderId);
  expect(binding).not.toBeNull();
  expect(binding!.revokedAt).not.toBeNull();
  expect((await createSessionCredentialResolver(root)(binding!.token)).ok).toBe(false);
});

// INVARIANT: resuming retires the outgoing launch's binding before forgetting its id, and a failed replacement revokes its new binding too. Neither placeholder may outlive that launch.
test('a failed resume revokes both outgoing and replacement service bindings', async () => {
  const { session, token } = await serviceSession('stopped');
  await expect(handleStartBuilderSession(root, { id: session.id })).rejects.toThrow('require the docker/podman runner');
  const resumed = await (await getOrCreateStorage()).getBuilderSession(session.id);
  expect(resumed!.builderId).not.toBe(BUILDER_ID);
  expect(resumed!.state).toBe('stopped');
  expect(await lookupSessionBinding(root, token)).toBeNull();
  const replacement = await getTaskSessionBinding(root, resumed!.builderId);
  expect(replacement).not.toBeNull();
  expect(replacement!.revokedAt).not.toBeNull();
  expect((await createSessionCredentialResolver(root)(replacement!.token)).ok).toBe(false);
});
