/**
 * Per-member credentials PER AGENT PROFILE, end to end through live supervised
 * turns on a managed daemon with real per-member tokens.
 *
 * A project defines a second Claude profile (`claude-gw`) with an endpoint of
 * its own in the CONTROL PLANE's config — the file a project owner edits on
 * Lazy Teams' Configuration page. One member runs a turn on the default Claude
 * profile and one on `claude-gw`; each stub upstream proves which of the
 * member's credentials that turn spent.
 *
 * INVARIANTS exercised live:
 *   - each turn bills the acting member's own credential FOR THAT TURN'S
 *     PROFILE: their Claude credential for the default profile, the one they
 *     connected for `claude-gw` for that one — never the other, never the
 *     project's, never a teammate's;
 *   - a member who has not connected a credential for the profile is refused
 *     before a turn launches, with the per-profile wire marker Lazy Teams
 *     matches, and the task is left exactly where it was;
 *   - a profile's traffic reaches that profile's endpoint, carrying a
 *     placeholder in the agent and the real secret only upstream.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, withPresentedToken } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { credentialSwapScenario } from '../helpers/fake-claude';
import { readTaskStatus, readTurns, storageDirFor } from '../helpers/storage';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { NO_OWNER_PROFILE_CREDENTIAL_MARKER } from '../../src/daemon/member-credentials';
import { readAuditRecords } from '../../src/proxy/audit-log';

const ALICE_EMAIL = 'alice@example.com';
const ALICE_CLAUDE = 'sk-ant-oat01-alice-claude-for-profile-proof';
const ALICE_GW_KEY = 'gw-key-alice-for-profile-proof';
const SERVICE_CLAUDE = 'sk-ant-oat01-service-for-profile-proof';

type Seen = Array<Record<string, string>>;

function stub(seen: Seen): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      // Model calls only: lazy also probes a pinned endpoint for reachability
      // (at create, on a managed host) without any credential.
      if (req.method !== 'POST' || !new URL(req.url).pathname.endsWith('/v1/messages')) {
        return new Response('ok');
      }
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      seen.push(headers);
      await req.text().catch(() => '');
      return Response.json({ type: 'message', model: 'claude-sonnet-4-6', content: [] });
    },
  });
}

describe('per-member credentials per agent profile, through live turns', () => {
  let ctx: TestContext;
  let sharedToken: string;
  let target: string;
  let primary: ReturnType<typeof Bun.serve>;
  let gateway: ReturnType<typeof Bun.serve>;
  const atPrimary: Seen = [];
  const atGateway: Seen = [];

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  beforeEach(async () => {
    atPrimary.length = 0;
    atGateway.length = 0;
    primary = stub(atPrimary);
    gateway = stub(atGateway);

    ctx = await setupTestLazy({ fakeClaude: true });

    // The profile goes into the CONTROL PLANE's config (what a project owner
    // saves on the Configuration page), which is where a managed project may
    // pin one. The repository's lazy.toml carries the same text so the CLI,
    // which does not run managed, knows the profile name too.
    const configPath = join(ctx.root, 'lazy.toml');
    const config =
      `${await readFile(configPath, 'utf-8')}\n` +
      `[proxy]\nupstream = "http://127.0.0.1:${primary.port}"\n\n` +
      `[agents.claude-gw]\nharness = "claude-code"\nmodel = "claude-sonnet-4-6"\n` +
      `endpoint = "http://127.0.0.1:${gateway.port}"\ncredential = "gw-claude"\n`;
    await writeFile(configPath, config);
    const controlPlaneDir = join(ctx.root, '..', `${ctx.root.split('/').pop()}-control-plane`);
    await mkdir(controlPlaneDir, { recursive: true });
    const controlPlaneConfig = join(controlPlaneDir, 'lazy.toml');
    await writeFile(controlPlaneConfig, config);

    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MANAGED_CONFIG_PATH: controlPlaneConfig,
    });
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) throw new Error('test daemon did not record a TCP target and token');
    target = resolvedTarget;
    sharedToken = resolvedToken;
  });

  afterEach(async () => {
    primary.stop(true);
    gateway.stop(true);
    await ctx.cleanup();
  });

  test('each turn spends the member\'s own credential for its profile, at that profile\'s endpoint', async () => {
    await rpc(sharedToken, 'putUserCredential', { userId: ALICE_EMAIL, kind: 'oauth', token: ALICE_CLAUDE });
    await rpc(sharedToken, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: SERVICE_CLAUDE });
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL })) as { token: string };

    // What a connect page renders: the daemon says what each profile takes.
    const listed = (await rpc(alice.token, 'agentCredentialProfiles')) as {
      profiles: Array<{ name: string; paidBy: string; endpoint: string | null }>;
    };
    expect(listed.profiles.find((p) => p.name === 'claude-gw')).toMatchObject({
      paidBy: 'profile', endpoint: `http://127.0.0.1:${gateway.port}`,
    });
    expect(listed.profiles.find((p) => p.name === 'claude-code')).toMatchObject({ paidBy: 'claude' });

    // 1. The default profile: Alice's Claude credential, at the primary upstream.
    const onClaude = await createTask(ctx, 'Default profile turn', 'Exercise the proxy', { token: alice.token });
    await ctx.setClaudeScenario(credentialSwapScenario({ sessionId: 'profile-claude-1' }));
    await rpc(alice.token, 'startTask', { taskId: onClaude });
    expectSuccess(await ctx.lazy(['wait', onClaude]));
    expect(atPrimary.length).toBeGreaterThan(0);
    for (const call of atPrimary) expect(call.authorization).toBe(`Bearer ${ALICE_CLAUDE}`);
    expect(atGateway).toHaveLength(0);
    const primaryCalls = atPrimary.length;

    // 2. The gateway profile, before Alice connected a credential for it:
    // refused before anything runs — never paid by her Claude credential.
    const onGateway = await createTask(ctx, 'Gateway profile turn', 'Exercise the proxy', {
      token: alice.token, agent: 'claude-gw',
    });
    const before = readTaskStatus(ctx.root, onGateway);
    const invocations = (await ctx.claudeInvocations()).length;
    const refused = await withPresentedToken(ctx, alice.token, () => ctx.lazy(['start', onGateway, '--yes']));
    expect(refused.exitCode).toBe(1);
    expect(`${refused.stdout}\n${refused.stderr}`).toContain(`${NO_OWNER_PROFILE_CREDENTIAL_MARKER} "claude-gw"`);
    expect(readTaskStatus(ctx.root, onGateway)).toBe(before);
    expect(readTurns(ctx.root, onGateway)).toHaveLength(0);
    expect((await ctx.claudeInvocations()).length).toBe(invocations);
    expect(atGateway).toHaveLength(0);

    // 3. Alice connects her own key for the profile; the same start now runs,
    // and the gateway sees THAT key — nothing else of hers, nothing of anyone's.
    // Carrying the endpoint she was SHOWN — her consent to where it goes.
    await rpc(sharedToken, 'putUserCredential', {
      userId: ALICE_EMAIL, profile: 'claude-gw', kind: 'api-key', token: ALICE_GW_KEY,
      endpoint: listed.profiles.find((p) => p.name === 'claude-gw')!.endpoint,
    });
    await ctx.setClaudeScenario(credentialSwapScenario({ sessionId: 'profile-gw-1' }));
    expectSuccess(await withPresentedToken(ctx, alice.token, () => ctx.lazy(['start', onGateway, '--yes'])));
    expectSuccess(await ctx.lazy(['wait', onGateway]));

    // Every model call of the turn (its work and lazy's own steps inside it).
    expect(atGateway.length).toBeGreaterThan(0);
    for (const call of atGateway) {
      expect(call['x-api-key']).toBe(ALICE_GW_KEY);
      expect(call.authorization).toBeUndefined();
    }
    expect(JSON.stringify(atGateway)).not.toContain(ALICE_CLAUDE);
    expect(JSON.stringify(atGateway)).not.toContain(SERVICE_CLAUDE);
    // ...and the gateway turn sent nothing to the primary upstream.
    expect(atPrimary.length).toBe(primaryCalls);

    // The agent held a placeholder, never the key.
    const gwLaunch = (await ctx.claudeInvocations()).at(-1)!;
    expect(JSON.stringify(gwLaunch)).not.toContain(ALICE_GW_KEY);
    expect(gwLaunch.env?.ANTHROPIC_AUTH_TOKEN).toBeDefined();

    // And the proxy's record names whose credential paid.
    const records = await readAuditRecords(join(ctx.root, '.lazy'), { limit: 50 });
    const gwRecord = records.find((r) => r.upstream === `http://127.0.0.1:${gateway.port}`);
    expect(gwRecord?.userId).toBe(ALICE_EMAIL);
    expect(gwRecord?.credentialProfile).toBe('claude-gw');
  }, 180_000);
});
