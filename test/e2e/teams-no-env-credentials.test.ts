/**
 * A managed (Teams) daemon never satisfies a credential from its own
 * environment — not even a custom name the project's admin chose for an
 * `[endpoints.*]` block, whose `LAZY_CREDENTIAL_<NAME>` variable a solo daemon
 * WOULD read (engineer decision 2026-10-07).
 *
 * Managed daemon, real supervisor, fake `codex` on PATH; the custom-named
 * secret is planted in the daemon's own env before it starts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, withPresentedToken } from '../helpers/fixtures';
import { readTaskStatus, readTurns, storageDirFor } from '../helpers/storage';
import { expectSuccess } from '../helpers/assertions';
import { codexSuccessScenario } from '../helpers/fake-codex';
import { looksLikeLazyPlaceholder } from '../../src/proxy/credential-broker';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { NO_OWNER_ENDPOINT_CREDENTIAL_MARKER } from '../../src/daemon/member-credentials';
import { namedCredentialEnvVar } from '../../src/credentials/providers';
import type { EndpointCredentialsResult } from '../../src/daemon/endpoint-credentials';

const ALICE_EMAIL = 'alice@example.com';
const NAME = 'acme-gateway';
const ENV_SECRET = 'daemon-env-acme-secret-must-never-spend';

describe('Teams never reads a credential from the daemon environment', () => {
  let ctx: TestContext;
  let target: string;
  let sharedToken: string;
  let soloAuthEnv = '';
  let gateway: ReturnType<typeof Bun.serve> | undefined;
  let gatewayOrigin = '';
  const probe = { proxied: false, role: 'agent', label: 'probe', profile: 'acme' };

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  beforeEach(async () => {
    // A reachable stand-in for the admin-chosen gateway: the launch preflight
    // probes it. Nothing here asserts on what it receives.
    gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({}) });
    gatewayOrigin = `http://127.0.0.1:${gateway.port}`;
    ctx = await setupTestLazy({ fakeCodex: true });
    const configPath = join(ctx.root, 'lazy.toml');
    const config = (await readFile(configPath, 'utf-8')) + `
[endpoints.acme]
url = "${gatewayOrigin}/v1"
credential = "${NAME}"
[agents.acme]
harness = "codex"
model = "acme-large"
named_endpoint = "acme"
`;
    await writeFile(configPath, config);
    const controlPlaneDir = join(ctx.root, '..', `${ctx.root.split('/').pop()}-control-plane`);
    await mkdir(controlPlaneDir, { recursive: true });
    const controlPlaneConfig = join(controlPlaneDir, 'lazy.toml');
    await writeFile(controlPlaneConfig, config);
    // Positive control: a SOLO daemon started with the planted variable really
    // holds it, and its getAuthEnv hands it out — so the refusals below are the
    // team-mode rule, not a variable that never arrived.
    await ctx.restartDaemon({ [namedCredentialEnvVar(NAME, 'api-key')]: ENV_SECRET });
    {
      const t = getDaemonTcpTarget(ctx.root);
      const tok = readToken(ctx.root);
      if (!t || !tok) throw new Error('test daemon did not record a TCP target and token');
      soloAuthEnv = JSON.stringify(await DaemonClient.fromTarget(t, tok).rpc('getAuthEnv', ctx.root, probe));
    }
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MANAGED_CONFIG_PATH: controlPlaneConfig,
      [namedCredentialEnvVar(NAME, 'api-key')]: ENV_SECRET,
    });
    const t = getDaemonTcpTarget(ctx.root);
    const tok = readToken(ctx.root);
    if (!t || !tok) throw new Error('test daemon did not record a TCP target and token');
    target = t;
    sharedToken = tok;
    // The owner's save: a managed load honours the control plane's
    // [agents]/[endpoints] only once they are applied, so without it the
    // custom endpoint this suite is about does not exist.
    expect(await rpc(sharedToken, 'applyProjectConfig', { toml: config, origin: 'control-plane' }))
      .toMatchObject({ applied: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
    gateway?.stop(true);
  });

  // INVARIANT: in team mode a custom-named endpoint credential comes only from
  // the turn owner's connected credentials. A LAZY_CREDENTIAL_<NAME> variable in
  // the daemon's environment neither counts as connected nor lets a turn start.
  test('a member who has not connected the custom credential is refused despite the env var', async () => {
    expect(soloAuthEnv).toContain(ENV_SECRET);
    await rpc(sharedToken, 'setCredentialBillingMode', { mode: 'member' });
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL })) as { token: string };

    // Team mode: getAuthEnv hands no credential to anybody, member or control.
    for (const token of [alice.token, sharedToken]) {
      for (const params of [probe, { ...probe, proxied: true }]) {
        const err = await rpc(token, 'getAuthEnv', params).then(() => null, (e) => e as Error);
        expect(err?.message).toContain('connected credentials');
        expect(err?.message).not.toContain(ENV_SECRET);
      }
    }
    expect(await rpc(sharedToken, 'getAuthEnv', { credentials: false, proxied: false })).toMatchObject({ authEnvVars: [] });

    const state = (await rpc(alice.token, 'endpointCredentials')) as EndpointCredentialsResult;
    expect(state.endpoints.find((e) => e.endpointId === 'acme')?.yours?.state).toBe('missing');

    const taskId = await createTask(ctx, 'Custom endpoint turn', 'Do it', { token: alice.token, agent: 'acme' });
    const refused = await withPresentedToken(ctx, alice.token, () => ctx.lazy(['start', taskId, '--yes']));
    const out = `${refused.stdout}\n${refused.stderr}`;
    expect(refused.exitCode).toBe(1);
    expect(out).toContain(`${NO_OWNER_ENDPOINT_CREDENTIAL_MARKER} "acme"`);
    expect(out).not.toContain(ENV_SECRET);
    expect(readTurns(ctx.root, taskId)).toHaveLength(0);
    expect((await ctx.codexInvocations()).filter((i) => i.argv.includes('exec'))).toHaveLength(0);

    // Connecting her own makes it connected — the env var never did.
    // Carrying the endpoint she was SHOWN — her consent covers that scope, path included.
    await rpc(sharedToken, 'putEndpointCredential', {
      userId: ALICE_EMAIL, endpointId: 'acme', origin: state.endpoints.find((e) => e.endpointId === 'acme')!.scope, kind: 'api-key', token: 'alice-own-acme',
    });
    const after = (await rpc(alice.token, 'endpointCredentials')) as EndpointCredentialsResult;
    expect(after.endpoints.find((e) => e.endpointId === 'acme')?.yours?.state).toBe('connected');

    // ...and her turn now runs, holding only a placeholder — never her key or the env's.
    await ctx.setCodexScenario({
      sequence: [
        codexSuccessScenario({ sessionId: '01a00000-0000-7000-8000-00000000ac01', result: 'Done.' }),
        codexSuccessScenario({ sessionId: '01a00000-0000-7000-8000-00000000ac01', result: 'Done again.' }),
      ],
    });
    expectSuccess(await withPresentedToken(ctx, alice.token, () => ctx.lazy(['start', taskId, '--yes'])));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    const launches = (await ctx.codexInvocations()).filter((i) => i.argv.includes('exec'));
    expect(launches.length).toBeGreaterThan(0);
    expect(looksLikeLazyPlaceholder(launches[0]!.env.OPENAI_API_KEY ?? '')).toBe(true);
    const seen = JSON.stringify(launches);
    expect(seen).not.toContain(ENV_SECRET);
    expect(seen).not.toContain('alice-own-acme');
  }, 240_000);
});
