/**
 * Starting a turn leaves a running task container — and the services a person is
 * using in it — alone (engineer, 2026-10-20: "Every time I start a new turn, the
 * services are turned off or they are reset").
 *
 * One of the causes, reproduced end to end: in team mode a turn's placeholder
 * lives in the env var its owner's credential KIND needs, and a turn whose owner
 * holds a different kind than the previous turn's recreated the container. In
 * Teams that is every turn after a daemon-started one when the member and the
 * service credential differ in kind (OAuth vs API key).
 *
 * INVARIANT: a credential-kind change between turns reuses the running
 * supervisor (the container's stand-in on this seam), the agent of the new turn
 * holds the new placeholder in the env var its kind needs and nothing in the
 * old one — the value the daemon bound for that turn — and the task still parks.
 * And a per-task secret file pushed again unchanged before the turn (as Lazy
 * Teams does every turn) keeps its inode and mtime through the push and launch.
 *
 * Runs on the fake-binary seam (real daemon, real `lazy supervise`, host-process
 * runner): the agent's own env and parent pid are read back from the agent
 * process itself.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario, type ClaudeInvocation } from '../helpers/fake-claude';
import { readTaskStatus } from '../helpers/storage';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { putUserCredential, clearUserCredentialCache, SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { isSessionPlaceholderToken, clearSessionCredentialCache } from '../../src/daemon/session-credentials';
import { getSessionCredentialsPath } from '../../src/daemon/paths';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';

const ALICE = 'alice@example.com';

function workTurns(invocations: ClaudeInvocation[]): ClaudeInvocation[] {
  return invocations.filter(i => i.argv.includes('-p'));
}

describe('starting a turn keeps the task container', () => {
  let ctx: TestContext;
  let baseDir: string;
  let unpin: () => void;

  beforeEach(async () => {
    baseDir = await makeDaemonBaseDir();
    unpin = pinDaemonBaseDir(baseDir);
    ctx = await setupTestLazy({ fakeClaude: true });
    // The fake-binary project runs the host-process runner, which only the
    // harness's child processes may use by default.
    process.env.LAZY_ALLOW_HOST_RUNNER = '1';
  });

  afterEach(async () => {
    delete process.env.LAZY_ALLOW_HOST_RUNNER;
    await ctx.cleanup();
    // AFTER cleanup: the daemon pidfile is resolved from this variable.
    unpin();
    await removeDaemonBaseDir(baseDir);
    clearUserCredentialCache();
    clearSessionCredentialCache();
  });

  test('a credential-kind change between turns reuses the running supervisor and hands the agent the new placeholder', async () => {
    // Team mode. CLI turns are nobody's on a laptop, so they run on the service
    // credential, paid by its holder's own connection: alice's.
    await putUserCredential(ctx.root, { userId: ALICE, kind: 'oauth', token: 'sk-ant-oat01-alice-first' });
    await putUserCredential(ctx.root, { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-service', ownerEmail: ALICE });
    await ctx.recordClaudeEnvKeys(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);

    const taskId = await createTask(ctx, 'Keep my services running', 'Do the first piece');
    await ctx.setClaudeScenario({ sequence: [
      successScenario({ sessionId: 'keep-1', commit: { message: 'First piece', files: [{ path: 'one.txt', content: '1\n' }] } }),
      successScenario({ sessionId: 'keep-1' }),
      successScenario({ sessionId: 'keep-1', result: 'Second piece done.' }),
      successScenario({ sessionId: 'keep-1' }),
    ] });

    // A per-task secret file, pushed the way Lazy Teams pushes it.
    const target = getDaemonTcpTarget(ctx.root);
    const token = readToken(ctx.root);
    if (!target || !token) throw new Error('test daemon did not record a TCP target and token');
    const rpc = (command: string, params: Record<string, unknown>) => DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
    const files = [{ path: '.env', contents: 'API_TOKEN=keep-me-0123456789abcdef\n' }];
    await rpc('taskFiles', { action: 'set', taskId, files });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    const first = workTurns(await ctx.claudeInvocations());
    expect(first.length).toBeGreaterThan(0);
    const firstEnv = first[0].env;
    expect(isSessionPlaceholderToken(String(firstEnv.CLAUDE_CODE_OAUTH_TOKEN))).toBe(true);
    const supervisorPid = first[0].ppid;
    const envFile = join(first[0].cwd, '.env');
    const envBefore = await stat(envFile);
    expect(await readFile(envFile, 'utf-8')).toBe(files[0].contents);

    // The holder's credential is now an API key: the next turn's placeholder
    // must live in ANTHROPIC_API_KEY. Through the daemon, which caches the file.
    await rpc('putUserCredential', { userId: ALICE, kind: 'api-key', token: 'sk-ant-api03-alice-second' });

    // What Lazy Teams does before EVERY turn: push the task's (unchanged) files.
    await Bun.sleep(20);
    await rpc('taskFiles', { action: 'set', taskId, files });
    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'Do the second piece']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expect(await readTaskStatus(ctx.root, taskId)).toBe('blocked');

    const all = workTurns(await ctx.claudeInvocations());
    const second = all.find(i => String(i.stdin).includes('Do the second piece'));
    expect(second, 'the unblocked turn never ran').toBeDefined();

    // THE ASSERTIONS THIS SUITE EXISTS FOR. Same supervisor: nothing was torn
    // down, so services in the container would have kept running.
    expect(second!.ppid).toBe(supervisorPid);
    // The agent holds the new kind's placeholder, and nothing in the old slot.
    const apiKey = String(second!.env.ANTHROPIC_API_KEY);
    expect(isSessionPlaceholderToken(apiKey)).toBe(true);
    expect(second!.env.CLAUDE_CODE_OAUTH_TOKEN ?? null).toBeNull();
    // And it is the value the daemon bound for that turn, with the new kind —
    // what the proxy resolves while the turn runs (else: 401, fatal_auth). The
    // binding is revoked once the turn ends, so it is read from the registry.
    const registry = JSON.parse(await readFile(getSessionCredentialsPath(ctx.root), 'utf-8')) as {
      bindings: Array<{ token: string; kind: string }>;
    };
    expect(registry.bindings.find(b => b.token === apiKey)?.kind).toBe('api-key');
    // The unchanged secret file was neither replaced nor touched by the push
    // and the launch: a dev server watching it would not have restarted.
    const envAfter = await stat(envFile);
    expect([envAfter.ino, envAfter.mtimeMs]).toEqual([envBefore.ino, envBefore.mtimeMs]);
  }, 180_000);
});
