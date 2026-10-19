/**
 * A Lazy Teams project that runs ONLY on Codex, with no service credential and
 * no Anthropic credential anywhere — the shape of the engineer's first
 * Codex-only project (2026-10-05).
 *
 * Managed daemon, real supervisor, fake `codex` on PATH. Members hold nothing
 * but their own OpenAI key for the `codex` profile, if that.
 *
 * INVARIANTS exercised live:
 *   - the project is usable from its first moment: nothing about it reports a
 *     missing project/daemon credential, because a managed daemon bills every
 *     turn to the person who asked for it;
 *   - a member's turn runs on THAT member's own Codex credential and is
 *     attributed to them, with no service credential configured at all;
 *   - a member with no credential for the profile is refused before anything
 *     runs, naming the endpoint — never billed to the daemon or a teammate;
 *   - accept works with no service credential.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, withPresentedToken } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { codexSuccessScenario } from '../helpers/fake-codex';
import { readTaskStatus, readTurns, storageDirFor } from '../helpers/storage';
import { turnProtectionOff } from '../helpers/managed-protection';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { NO_OWNER_ENDPOINT_CREDENTIAL_MARKER } from '../../src/daemon/member-credentials';
import { looksLikeLazyPlaceholder } from '../../src/proxy/credential-broker';

const ALICE_EMAIL = 'alice@example.com';
const BOB_EMAIL = 'bob@example.com';
const ALICE_OPENAI = 'sk-alice-openai-key-for-codex-only-project';

describe('a Codex-only Teams project with no service credential', () => {
  let ctx: TestContext;
  let sharedToken: string;
  let target: string;

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeCodex: true });
    // The control plane's copy of the config — the file a managed daemon reads.
    const config = await readFile(join(ctx.root, 'lazy.toml'), 'utf-8');
    const controlPlaneDir = join(ctx.root, '..', `${ctx.root.split('/').pop()}-control-plane`);
    await mkdir(controlPlaneDir, { recursive: true });
    const controlPlaneConfig = join(controlPlaneDir, 'lazy.toml');
    await writeFile(controlPlaneConfig, config);
    // Protection is not what this suite tests; see test/helpers/managed-protection.ts.
    await turnProtectionOff(controlPlaneConfig);
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MANAGED_CONFIG_PATH: controlPlaneConfig,
    });
    const t = getDaemonTcpTarget(ctx.root);
    const tok = readToken(ctx.root);
    if (!t || !tok) throw new Error('test daemon did not record a TCP target and token');
    target = t;
    sharedToken = tok;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a fresh project with no credentials at all reports none missing', async () => {
    // Before anyone has connected anything. A managed daemon bills per person,
    // so "the daemon holds no OpenAI credential" is not a fact about anything a
    // turn would spend — saying it sent the engineer looking for a system
    // credential the project does not need.
    const doctor = await ctx.lazy(['doctor']);
    const text = `${doctor.stdout}\n${doctor.stderr}`;
    expect(text).toContain('Daemon health');
    expect(text).not.toContain('The daemon holds no OpenAI credential');
    expect(text).not.toMatch(/OpenAI credential — run lazy daemon health/);
  }, 120_000);

  test('a member runs and accepts a task on their own Codex credential; one without is refused by endpoint', async () => {
    await rpc(sharedToken, 'putUserCredential', {
      userId: ALICE_EMAIL, profile: 'codex', kind: 'api-key', token: ALICE_OPENAI, endpoint: 'https://api.openai.com',
    });
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL })) as { token: string };
    const bob = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: BOB_EMAIL })) as { token: string };

    // Bob connected nothing: refused before anything runs, naming the endpoint.
    const bobTask = await createTask(ctx, 'Bob has no credential', 'Nope', { token: bob.token });
    const refused = await withPresentedToken(ctx, bob.token, () => ctx.lazy(['start', bobTask, '--yes']));
    expect(refused.exitCode).toBe(1);
    expect(`${refused.stdout}\n${refused.stderr}`).toContain(`${NO_OWNER_ENDPOINT_CREDENTIAL_MARKER} "builtin:openai"`);
    expect(readTurns(ctx.root, bobTask)).toHaveLength(0);
    expect((await ctx.codexInvocations()).filter((i) => i.argv.includes('exec'))).toHaveLength(0);

    // Alice runs a turn on her own key.
    const taskId = await createTask(ctx, 'Codex-only turn', 'Do the codex thing', { token: alice.token });
    await ctx.setCodexScenario({
      sequence: [
        codexSuccessScenario({
          sessionId: '01a00000-0000-7000-8000-00000000c001',
          result: 'Done.',
          commit: { message: 'Codex work', files: [{ path: 'codex.txt', content: 'one\n' }] },
        }),
        codexSuccessScenario({ sessionId: '01a00000-0000-7000-8000-00000000c001', result: 'Done again.' }),
      ],
    });
    expectSuccess(await withPresentedToken(ctx, alice.token, () => ctx.lazy(['start', taskId, '--yes'])));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    // Attributed to her, and the agent held a placeholder — never her key.
    const agentTurns = readTurns(ctx.root, taskId).filter((t) => t.role === 'agent');
    expect(agentTurns.length).toBeGreaterThan(0);
    for (const turn of agentTurns) expect(JSON.stringify(turn)).toContain(ALICE_EMAIL);
    const launches = (await ctx.codexInvocations()).filter((i) => i.argv.includes('exec'));
    expect(launches.length).toBeGreaterThan(0);
    expect(looksLikeLazyPlaceholder(launches[0]!.env.OPENAI_API_KEY ?? '')).toBe(true);
    expect(JSON.stringify(launches)).not.toContain(ALICE_OPENAI);

    // Accept needs no service credential either.
    expectSuccess(await withPresentedToken(ctx, alice.token, () => ctx.lazy(['accept', taskId, '--yes'])));
    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
  }, 240_000);
});
