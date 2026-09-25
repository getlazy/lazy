/**
 * Placeholder → proxy credential swap, end to end through a real supervised turn.
 *
 * The POC runbook (docs/design/lazy-teams-poc-runbook.md) records that the
 * per-user path — placeholder in the agent env, proxy lookup, same-header
 * replacement with the owner's real credential — has never executed in one run.
 * Everything is designed and unit-covered; this suite is the automated proof.
 *
 * INVARIANTS exercised live:
 *   - a user-token turn launches with a session placeholder, never the real secret;
 *   - the stub upstream receives the OWNER's credential in the header shape the
 *     placeholder's kind implies (Bearer for OAuth, x-api-key for API keys);
 *   - proxy audit records name the owning user;
 *   - a member with no stored credential is refused with the wire marker — never
 *     billed to the service account or anyone else.
 *
 * Only the fake-binary seam can prove this: a real supervisor launches a real
 * agent process that really holds the launch env and really dials the proxy.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, withPresentedToken } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { credentialSwapScenario } from '../helpers/fake-claude';
import { readTaskStatus, readTurns, storageDirFor } from '../helpers/storage';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { NO_OWNER_CREDENTIAL_MARKER } from '../../src/daemon/turn-credentials';
import { isSessionPlaceholderToken, SESSION_TOKEN_PREFIX } from '../../src/daemon/session-credentials';
import { readAuditRecords } from '../../src/proxy/audit-log';

const ALICE_OAUTH = 'sk-ant-oat01-alice-real-secret-for-swap-proof';
const BOB_API_KEY = 'sk-ant-api03-bob-real-key-for-swap-proof';
const SERVICE_OAUTH = 'sk-ant-oat01-service-real-secret-for-swap-proof';

const ALICE_EMAIL = 'alice@example.com';
const BOB_EMAIL = 'bob@example.com';
const NEMO_EMAIL = 'nemo@example.com';
const NEMO_OAUTH = 'sk-ant-oat01-nemo-real-secret-for-swap-proof';

type Forwarded = { headers: Record<string, string> } | null;

/** Poll until `check` passes or the budget runs out; returns the last value. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, budgetMs: number): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await Bun.sleep(50);
    last = await read();
  }
  return last;
}

describe('credential swap through a live supervised turn', () => {
  let ctx: TestContext;
  let sharedToken: string;
  let target: string;
  let upstream: ReturnType<typeof Bun.serve>;
  let forwarded: Forwarded = null;

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  async function rpcStatus(token: string, command: string, params: Record<string, unknown> = {}) {
    try {
      await rpc(token, command, params);
      return { status: 200, message: '' };
    } catch (err) {
      if (!(err instanceof RpcApplicationError)) throw err;
      return { status: err.status, message: err.message };
    }
  }

  async function mintUserToken(email: string, name?: string): Promise<string> {
    const result = await rpc(sharedToken, 'mintActorToken', { kind: 'user', email, name }) as { token: string };
    expect(typeof result.token).toBe('string');
    return result.token;
  }

  async function putCredential(userId: string, kind: 'oauth' | 'api-key', token: string): Promise<void> {
    await rpc(sharedToken, 'putUserCredential', { userId, kind, token });
  }

  /** Point the daemon proxy at the stub upstream and restart so it takes effect. */
  async function pinUpstream(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const upstreamLine = `http://127.0.0.1:${upstream.port}`;
    if (!before.includes(upstreamLine)) {
      await writeFile(
        configPath,
        `${before}\n[proxy]\nupstream = "${upstreamLine}"\n`,
      );
    }
  }

  async function auditRecordFor(userId: string) {
    const records = await until(
      async () => readAuditRecords(join(ctx.root, '.lazy'), { limit: 20 }),
      (recs) => recs.some((r) => r.userId === userId),
      5_000,
    );
    return records.find((r) => r.userId === userId);
  }

  beforeEach(async () => {
    forwarded = null;
    upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        forwarded = { headers };
        await req.text().catch(() => '');
        return Response.json({ type: 'message', model: 'claude-sonnet-4-6' });
      },
    });

    ctx = await setupTestLazy({
      fakeClaude: true,
    });

    await pinUpstream();
    // Arm managed mode for the proof of the per-user billing mandate.
    // We must provide a storage path, otherwise the daemon refuses to start in managed mode.
    const storagePath = storageDirFor(ctx.root);
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storagePath,
    });
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) {
      throw new Error('test daemon did not record a TCP target and token');
    }
    target = resolvedTarget;
    sharedToken = resolvedToken;
  });

  afterEach(async () => {
    upstream.stop(true);
    await ctx.cleanup();
  });

  test('an OAuth owner: placeholder in the agent, real Bearer token at the upstream', async () => {
    // INVARIANT: Every turn bills the acting member's own credential (per-user billing mandate).
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);

    const userToken = await mintUserToken(ALICE_EMAIL, 'Alice');
    const taskId = await createTask(ctx, 'OAuth credential swap proof', 'Exercise the proxy', { token: userToken });
    await ctx.setClaudeScenario(credentialSwapScenario({ sessionId: 'oauth-swap-1' }));

    await rpc(userToken, 'startTask', { taskId });
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await ctx.claudeInvocations();
    const launched = invocations.filter(i => i.env?.CLAUDE_CODE_OAUTH_TOKEN !== undefined);
    expect(launched.length).toBeGreaterThan(0);

    const placeholder = launched[0]!.env!.CLAUDE_CODE_OAUTH_TOKEN!;
    expect(isSessionPlaceholderToken(placeholder)).toBe(true);
    expect(placeholder).not.toContain('real-secret');
    expect(JSON.stringify(invocations)).not.toContain(ALICE_OAUTH);

    expect(forwarded).not.toBeNull();
    expect(forwarded!.headers.authorization).toBe(`Bearer ${ALICE_OAUTH}`);
    expect(forwarded!.headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(forwarded)).not.toContain(SESSION_TOKEN_PREFIX);

    // The audit record's userId is the credential's stored userId — the member's
    // email, exactly what putUserCredential was called with.
    const rec = await auditRecordFor(ALICE_EMAIL);
    expect(rec, 'expected a proxy audit record attributed to alice').toBeDefined();
    expect(rec!.authDenial ?? null).toBeNull();
  }, 120_000);

  test('an API-key owner: x-api-key shape survives the swap', async () => {
    // INVARIANT: Every turn bills the acting member's own credential (per-user billing mandate).
    await putCredential(BOB_EMAIL, 'api-key', BOB_API_KEY);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);

    const userToken = await mintUserToken(BOB_EMAIL, 'Bob');
    const taskId = await createTask(ctx, 'API-key credential swap proof', 'Exercise the proxy', { token: userToken });
    await ctx.setClaudeScenario(credentialSwapScenario({ sessionId: 'apikey-swap-1' }));

    await rpc(userToken, 'startTask', { taskId });
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await ctx.claudeInvocations();
    const launched = invocations.filter(i => i.env?.ANTHROPIC_API_KEY !== undefined);
    expect(launched.length).toBeGreaterThan(0);
    expect(isSessionPlaceholderToken(launched[0]!.env!.ANTHROPIC_API_KEY!)).toBe(true);
    expect(launched[0]!.env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    expect(forwarded!.headers['x-api-key']).toBe(BOB_API_KEY);
    expect(forwarded!.headers.authorization).toBeUndefined();

    const rec = await auditRecordFor(BOB_EMAIL);
    expect(rec).toBeDefined();
  }, 120_000);

  // INVARIANT: no silent fallback — the same marker lazy-teams matches on.
  test('a user with no stored credential is refused before a turn launches', async () => {
    await putCredential(ALICE_EMAIL, 'oauth', ALICE_OAUTH);
    await putCredential(SERVICE_CREDENTIAL_USER_ID, 'oauth', SERVICE_OAUTH);

    const userToken = await mintUserToken(NEMO_EMAIL, 'Nemo');
    const taskId = await createTask(ctx, 'Uncredentialed swap proof', 'Some work', { token: userToken });
    const statusBeforeStart = readTaskStatus(ctx.root, taskId);
    // `lazy start` must present NEMO's token: startTask is a human-initiated
    // action, and Nemo is the person asking for the turn the refusal is about.
    // The refusal fires at launch, before any supervisor exists, so the CLI
    // exits 1 with the wire marker rather than reporting a started turn.
    const refusedStart = await withPresentedToken(ctx, userToken, () => ctx.lazy(['start', taskId, '--yes']));
    expect(refusedStart.exitCode).toBe(1);
    const refusalText = `${refusedStart.stdout}\n${refusedStart.stderr}`;
    expect(refusalText).toContain(NO_OWNER_CREDENTIAL_MARKER);
    expect(refusalText).toContain(NEMO_EMAIL);

    // Nothing reached the stub and no agent ever ran: the refusal is the whole
    // outcome of the launch.
    expect(forwarded).toBeNull();
    expect(await ctx.claudeInvocations()).toHaveLength(0);

    // INVARIANT: a start refused for a missing credential leaves the task
    // exactly where it was — its pre-start status and no recorded turn. It once
    // left `working` + a turn + no supervisor: unblock then 409'd and nothing
    // automatic retried the launch, so the member was wedged by the refusal.
    expect(readTaskStatus(ctx.root, taskId)).toBe(statusBeforeStart);
    expect(readTurns(ctx.root, taskId)).toHaveLength(0);

    // The same marker on the unblock path — the route a control plane uses to
    // resume a paused task. Set one up with a member who DOES hold a credential,
    // so the task reaches `blocked` through a real completed turn.
    const aliceToken = await mintUserToken(ALICE_EMAIL, 'Alice');
    const unblockTaskId = await createTask(ctx, 'Uncredentialed unblock proof', 'Some work', { token: aliceToken });
    await ctx.setClaudeScenario(credentialSwapScenario({ sessionId: 'uncred-1' }));
    await rpc(aliceToken, 'startTask', { taskId: unblockTaskId });
    expectSuccess(await ctx.lazy(['wait', unblockTaskId]));
    expect(readTaskStatus(ctx.root, unblockTaskId)).toBe('blocked');
    // Discard the setup turn's proxy traffic: from here, ANY request to the
    // stub would mean Nemo's refused turn reached it somehow.
    forwarded = null;

    const refused = await rpcStatus(userToken, 'unblockTask', {
      taskId: unblockTaskId,
      message: 'Please continue',
    });

    expect(refused.status).toBe(400);
    expect(refused.message).toContain(NO_OWNER_CREDENTIAL_MARKER);
    expect(refused.message).toContain(NEMO_EMAIL);
    expect(readTaskStatus(ctx.root, unblockTaskId)).toBe('blocked');
    // Nothing reached the stub: the refusal is the whole outcome.
    expect(forwarded).toBeNull();

    // And the refusal is recoverable by the obvious route: once the control
    // plane provisions the member's credential, the same start just runs.
    await putCredential(NEMO_EMAIL, 'oauth', NEMO_OAUTH);
    await ctx.setClaudeScenario(credentialSwapScenario({ sessionId: 'uncred-retry-1' }));
    expectSuccess(await withPresentedToken(ctx, userToken, () => ctx.lazy(['start', taskId, '--yes'])));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(forwarded).not.toBeNull();
    expect(forwarded!.headers.authorization).toBe(`Bearer ${NEMO_OAUTH}`);
  }, 120_000);
});
