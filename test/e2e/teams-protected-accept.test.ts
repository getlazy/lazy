/**
 * Branch protection in Lazy Teams: a signed-in member's own Accept is the
 * approval (src/daemon/member-accept-approval.ts), and a managed project's
 * default branch is protected unless its config says otherwise.
 *
 * Driven against a real daemon restarted in managed mode with a control-plane
 * lazy.toml, exactly as the Teams app reaches it: the browser's Accept arrives
 * on the member's user token with `memberAccept: true`; a bound clone's
 * `lazy accept` arrives on the same token WITHOUT it (the Teams CLI proxy
 * refuses the key); the app's background calls use the control token.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile, mkdtemp, rm } from 'fs/promises';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskStatus, storageDirFor } from '../helpers/storage';
import { seedFinal } from '../helpers/final';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';

describe('Teams: protected accept is a member pressing Accept', () => {
  let ctx: TestContext;
  let controlDir: string | undefined;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
    if (controlDir) await rm(controlDir, { recursive: true, force: true });
    controlDir = undefined;
  });

  async function blockedTask(name: string): Promise<string> {
    const id = await createTask(ctx, `Protected ${name}`, 'Add a file');
    expectSuccess(await ctx.lazyMocked(['start', id, '--yes'], MOCK_CLAUDE_SUCCESS, { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } }));
    expectSuccess(await ctx.lazy(['wait', id]));
    const worktree = join(ctx.root, '.lazy', 'worktrees', id);
    writeFileSync(join(worktree, `${name}.txt`), 'content\n');
    ctx.git('-C', worktree, 'add', `${name}.txt`);
    ctx.git('-C', worktree, 'commit', '-m', `Add ${name}.txt`);
    await seedFinal(ctx, id);
    expect(readTaskStatus(ctx.root, id)).toBe('blocked');
    return id;
  }

  /** Restart managed, with a control-plane config derived from init's. */
  async function goManaged(edit: (toml: string) => string = (t) => t) {
    controlDir = await mkdtemp(join(tmpdir(), 'protected-accept-control-'));
    const controlConfig = join(controlDir, 'lazy.toml');
    await writeFile(controlConfig, edit(await readFile(join(ctx.root, 'lazy.toml'), 'utf8')));
    await ctx.restartDaemon({ LAZY_TEST_FORCE_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root), LAZY_MANAGED_CONFIG_PATH: controlConfig });
    const target = getDaemonTcpTarget(ctx.root), token = readToken(ctx.root);
    if (!target || !token) throw new Error('daemon did not publish its TCP target and control token');
    const control = DaemonClient.fromTarget(target, token);
    const minted = await control.rpc('mintActorToken', ctx.root, { kind: 'user', email: 'ada@example.com', name: 'Ada' }) as { token: string };
    return { control, member: DaemonClient.fromTarget(target, minted.token) };
  }

  // INVARIANT: on a managed daemon the default branch is protected by default,
  // and the gate is satisfied ONLY by a member's own browser Accept — never by
  // the same member's token without the browser marker (a bound clone's CLI,
  // where an agent on their laptop could drive it), never by the control
  // token, and never on a non-human channel. The accept records who approved.
  test('member Accept approves; bound-clone CLI, control token and a member naming another channel are refused', async () => {
    const id = await blockedTask('gated');
    const { control, member } = await goManaged();

    await expect(member.rpc('acceptTask', ctx.root, { taskId: id, actor: 'human' }))
      .rejects.toThrow('press Accept on this task in Lazy Teams');
    // The control token names nobody, so it can never approve: on a managed
    // host any accept on it is refused before the gate is even reached.
    await expect(control.rpc('acceptTask', ctx.root, { taskId: id, actor: 'human', memberAccept: true }))
      .rejects.toThrow('control-plane token');
    await expect(member.rpc('acceptTask', ctx.root, { taskId: id, actor: 'builder', memberAccept: true }))
      .rejects.toThrow('may not act as');
    expect(readTaskStatus(ctx.root, id)).toBe('blocked');

    await member.rpc('acceptTask', ctx.root, { taskId: id, actor: 'human', memberAccept: true, reason: 'Ship it' });
    expect(readTaskStatus(ctx.root, id)).toBe('complete');
    const shown = JSON.stringify(await control.rpc('show', ctx.root, { taskId: id }));
    expect(shown).toContain('Protected merge approved by Ada <ada@example.com> (Accept in Lazy Teams).');
  }, 180_000);

  // INVARIANT: the owner's off switch is the config key — a managed project
  // whose config sets `[protection] enabled = false` is not gated at all.
  test('a project that turns protection off accepts without approval', async () => {
    const id = await blockedTask('ungated');
    const { member } = await goManaged((t) => {
      const out = t.replace('[protection]\n', '[protection]\nenabled = false\n');
      if (out === t) throw new Error('init template has no [protection] section to edit');
      return out;
    });

    await member.rpc('acceptTask', ctx.root, { taskId: id, actor: 'human' });
    expect(readTaskStatus(ctx.root, id)).toBe('complete');
  }, 180_000);

  // INVARIANT: on a managed daemon the builder (and any MCP caller) can never
  // complete a protected accept, and is told the real route — a member's Accept
  // in Lazy Teams — not a terminal passphrase that does not exist there. The
  // CLI preflight likewise names that route instead of passphrase enrollment.
  test('builder lazy_accept over MCP is refused and names the Teams Accept route', async () => {
    const id = await blockedTask('mcp');
    const { member } = await goManaged();

    const pre = await member.rpc('acceptTaskPreflight', ctx.root, { taskId: id }) as {
      gate: { gated: boolean; enrollment: string; teamsAcceptOnly: string | null };
    };
    expect(pre.gate.gated).toBe(true);
    expect(pre.gate.teamsAcceptOnly).toContain('pressing Accept');
    expect(pre.gate.enrollment).not.toBe('not-enrolled');

    clearMcpTokenCache();
    const token = await mintMcpToken(ctx.root, { kind: 'builder' }, 'e2e-builder');
    const target = getDaemonTcpTarget(ctx.root)!;
    const base = target.startsWith('http') ? target : `http://${target}`;
    const resp = await fetch(`${base}/mcp/_/lazy_accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-Lazy-Project': ctx.root },
      body: JSON.stringify({ arguments: { task_id: id, reason: 'Looks good' } }),
    });
    const body = await resp.text();
    expect(body).toContain('Accept on task');
    expect(body).toContain('Lazy Teams');
    expect(body).not.toContain('approval passphrase');
    expect(readTaskStatus(ctx.root, id)).toBe('blocked');
  }, 180_000);
});
