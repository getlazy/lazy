/**
 * Identity on a laptop: lazy takes it from git, refuses without it, and has
 * exactly one path for it.
 *
 * The subject is what a person experiences when nobody has told lazy who they
 * are. Three claims, each with a failure mode worth a test of its own:
 *
 *   - a store write is REFUSED, in git's own words, and a READ is not
 *   - the refusal reaches the human BEFORE `$EDITOR` opens (CLAUDE.md's first
 *     invariant: feedback a human typed is never discarded)
 *   - identity arrives ONE way — from the daemon's git config, never on a
 *     request and never on a per-user token, neither of which exists here
 *
 * A `withDaemon` suite, because every claim is about a decision the daemon
 * makes in its own environment from its own git config.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile, chmod, mkdtemp } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTurns, readTaskStatus, storageDirFor, taskFilePath } from '../helpers/storage';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';

describe('git identity (single-person install)', () => {
  let ctx: TestContext;
  let sharedToken: string;
  let target: string;

  async function rpcStatus(token: string, command: string, params: Record<string, unknown> = {}) {
    try {
      await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
      return { status: 200, message: '' };
    } catch (err) {
      if (!(err instanceof RpcApplicationError)) throw err;
      return { status: err.status, message: err.message };
    }
  }

  /**
   * Take this project's identity away.
   *
   * A repo-local EMPTY value, not an unset one: the machine running this suite
   * has a `~/.gitconfig` of its own, and Bun snapshots the environment at
   * process start — so `GIT_CONFIG_GLOBAL` set from here would never reach the
   * daemon's git anyway. An empty repo-local value shadows every outer level,
   * and is a state git itself refuses to commit under.
   *
   * The restart is not decoration: a SUCCESSFUL resolution is cached for a
   * minute, so a daemon that has already written something for this project
   * would keep believing the identity this test just removed. (The opposite
   * direction — a FAILURE — is never cached, which is what "the fix takes
   * effect without restarting anything" below proves.)
   */
  async function clearIdentity(): Promise<void> {
    ctx.git('-C', ctx.root, 'config', 'user.email', '');
    ctx.git('-C', ctx.root, 'config', 'user.name', '');
    await ctx.restartDaemon();
  }

  /** An `$EDITOR` that leaves a marker file behind if it is ever run. */
  async function markerEditor(): Promise<{ path: string; marker: string }> {
    const marker = join(ctx.root, 'editor-ran.marker');
    const path = join(ctx.root, 'marker-editor.sh');
    await writeFile(path, `#!/bin/sh\ntouch "${marker}"\necho "feedback" >> "$1"\n`);
    await chmod(path, 0o755);
    return { path, marker };
  }

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) {
      throw new Error('test daemon did not record a TCP target and token');
    }
    target = resolvedTarget;
    sharedToken = resolvedToken;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // --- The refusal, and what it does not touch ---

  // INVARIANT (CLAUDE.md's first): the human must never type feedback into
  // $EDITOR only to have a pre-flight failure discard it. The identity check is
  // therefore a PREFLIGHT — it asks the daemon before the editor opens — and
  // this test proves the editor never ran at all, not merely that the words
  // survived somewhere.
  test('unblock refuses in git\'s words and never opens $EDITOR', async () => {
    const taskId = await createTask(ctx, 'Unconfigured identity task', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    await clearIdentity();
    const editor = await markerEditor();

    const refused = await ctx.lazy(['unblock', taskId], {
      env: { LAZY_FORCE_TTY: '1', EDITOR: editor.path, VISUAL: editor.path },
    });

    expect(refused.exitCode).not.toBe(0);
    // Git's own text, because a developer has read it before.
    expect(refused.stderr).toContain('Please tell me who you are');
    expect(refused.stderr).toContain('git config --global user.email');
    // The single-warning-surface rule: one pointer at the point of occurrence.
    expect(refused.stderr).toContain('lazy doctor');

    expect(existsSync(editor.marker)).toBe(false);
    // And nothing the editor would have produced was recorded — the task still
    // has only its own start turn.
    const feedback = readTurns(ctx.root, taskId).filter(t => String(t.content).includes('feedback'));
    expect(feedback).toHaveLength(0);
  }, 120_000);

  // The same invariant on the command where the typed text is worth the most:
  // `lazy accept` collects a sign-off reason at a prompt — and on a protected
  // task the approval passphrase at a second one — before its RPC is made. The
  // preflight is what stops a reviewer composing all of that and then being
  // told the daemon does not know who they are.
  test('accept refuses before it asks for a sign-off reason', async () => {
    const taskId = await createTask(ctx, 'Accept-without-identity task', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    await clearIdentity();

    const refused = await ctx.lazy(['accept', taskId], { env: { LAZY_FORCE_TTY: '1' } });

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('Please tell me who you are');
    // The prompt never ran: its text is the tell, and so is the task still
    // being where it was.
    expect(`${refused.stdout}${refused.stderr}`).not.toContain('Accept reason');
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  }, 120_000);

  // Reading is how most people will DISCOVER the problem, so it must not be
  // taken away with everything else.
  test('reads keep working with no identity configured', async () => {
    const taskId = await createTask(ctx, 'Readable task');
    await clearIdentity();

    const list = await ctx.lazy(['list']);
    expectSuccess(list);
    expect(list.stdout).toContain(taskId);

    expectSuccess(await ctx.lazy(['show', taskId]));
    expectSuccess(await ctx.lazy(['search', 'Readable']));

    // And `lazy doctor` — the one surface that EXPLAINS the refusal — reports
    // it as a failed check rather than refusing to run.
    const doctor = await ctx.lazy(['doctor']);
    expect(`${doctor.stdout}${doctor.stderr}`).toContain('Please tell me who you are');
  }, 120_000);

  test('creating a task is refused, and the refusal names the remedy', async () => {
    await clearIdentity();

    const refused = await ctx.lazy(['create', '--goal', 'Should not exist']);

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('Please tell me who you are');

    const list = await ctx.lazy(['list']);
    expectSuccess(list);
    expect(list.stdout).not.toContain('Should not exist');
  }, 120_000);

  // A daemon that refused a minute ago must believe a fix immediately: the
  // resolution caches success only, so nothing has to be restarted.
  test('the fix takes effect without restarting anything', async () => {
    const taskId = await createTask(ctx, 'Recovering task');
    await clearIdentity();

    expect((await ctx.lazy(['comment', taskId, '--message', 'nope'])).exitCode).not.toBe(0);

    ctx.git('-C', ctx.root, 'config', 'user.email', 'fixed@example.com');
    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'now it lands']));
  }, 120_000);

  // --- Whose identity, exactly ---

  // Git's precedence is git's: the address this repository commits under is the
  // address lazy records, even when the machine has a different global one.
  // Proven through a real turn, because the turn is where it matters.
  test('a repository-local identity beats the global one, and lands on the turn', async () => {
    const globalHome = await mkdtemp(join(tmpdir(), 'lazy-global-gitconfig-'));
    const globalConfig = join(globalHome, 'gitconfig');
    await writeFile(globalConfig, '[user]\n\temail = global@example.com\n\tname = Global Person\n');
    // Passed at spawn time: Bun snapshots the environment, so a variable set in
    // this process after the daemon started would never reach its git.
    await ctx.restartDaemon({ GIT_CONFIG_GLOBAL: globalConfig });

    ctx.git('-C', ctx.root, 'config', 'user.email', 'repo-local@example.com');
    ctx.git('-C', ctx.root, 'config', 'user.name', 'Repo Local');

    const taskId = await createTask(ctx, 'Precedence task', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'Please also handle the empty case']));

    const feedback = readTurns(ctx.root, taskId)
      .find(t => t.role === 'human' && String(t.content).includes('Please also handle the empty case'));
    expect(feedback).toBeDefined();
    expect(feedback!.actor_email).toBe('repo-local@example.com');
    expect(feedback!.actor_name).toBe('Repo Local');
  }, 120_000);

  // --- One identity path ---

  // INVARIANT: identity comes from the daemon's environment, never from a
  // request. A client naming a person is REFUSED rather than silently
  // overwritten: it believes something about how its write will be attributed
  // that is not true, and the refusal is the only thing that tells it.
  test('a request that names a person is refused', async () => {
    const taskId = await createTask(ctx, 'Forged person task');

    const refused = await rpcStatus(sharedToken, 'storage', {
      method: 'createComment',
      args: {
        taskId,
        content: 'signed by somebody else',
        actor: { role: 'human', email: 'mallory@example.com', name: 'Mallory' },
      },
    });

    expect(refused.status).toBe(403);
    expect(refused.message).toContain('git config');
  }, 120_000);

  // INVARIANT: the refusal holds WHEREVER the actor sits in the request, not
  // just where the common writers put it. The Storage proxy's argument shapes
  // are not uniform — a raised-item decision carries its actor inside
  // `resolution` — and an enumeration of containers left that one open: a
  // caller holding the daemon token could record somebody else as having
  // decided the item that gates an accept, permanently, while the identical
  // attempt through `createComment` was refused. Posted over the wire in the
  // nested shape, because a unit call on the helper would not have caught it.
  test('a person nested deeper in the request is refused too, and the decision still names the daemon', async () => {
    ctx.git('-C', ctx.root, 'config', 'user.email', 'solo@example.com');
    ctx.git('-C', ctx.root, 'config', 'user.name', 'Solo Dev');
    const taskId = await createTask(ctx, 'Nested person task');
    const item = await DaemonClient.fromTarget(target, sharedToken).rpc('storage', ctx.root, {
      method: 'createRaisedItem',
      args: { taskId, input: { content: 'Should this ship?', blocking: true } },
    }) as { id: string };

    const refused = await rpcStatus(sharedToken, 'storage', {
      method: 'resolveRaisedItem',
      args: {
        taskId,
        itemId: item.id,
        resolution: {
          action: 'dismiss',
          response: 'not now',
          actor: { role: 'human', email: 'mallory@example.com', name: 'Mallory' },
        },
      },
    });

    expect(refused.status).toBe(403);
    expect(refused.message).toContain('git config');

    // Nothing was recorded — and the decision a REAL caller makes (the CLI
    // names the role, never the person) is stamped with the identity the daemon
    // resolved for itself, at the same nested location.
    expectSuccess(await ctx.lazy(['raised', 'dismiss', taskId, item.id.slice(0, 8), 'not now']));

    const items = JSON.parse(
      readFileSync(taskFilePath(ctx.root, taskId, 'raised-items.json'), 'utf-8'),
    ) as { raised_items: Array<{ resolved_by?: string; resolved_by_email?: string; resolved_by_name?: string }> };
    expect(items.raised_items[0]!.resolved_by).toBe('human');
    expect(items.raised_items[0]!.resolved_by_email).toBe('solo@example.com');
    expect(items.raised_items[0]!.resolved_by_name).toBe('Solo Dev');
  }, 120_000);

  // INVARIANT: outside managed mode, `/rpc/*` takes the daemon token and
  // nothing else. Leaving the per-user path technically open would mean two
  // ways identity could arrive with only one of them ever exercised — so
  // minting is refused too, and the refusal says why rather than 400-ing on a
  // missing field.
  test('a user token cannot be minted, and one minted elsewhere is refused', async () => {
    const mint = await rpcStatus(sharedToken, 'mintActorToken', { kind: 'user', email: 'ada@example.com' });
    expect(mint.status).toBe(400);
    expect(mint.message).toContain('managed mode');

    // A token minted while the daemon WAS managed, presented after it is not —
    // the only way a user token can exist on a laptop at all.
    await ctx.restartDaemon({
      LAZY_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
    });
    const minted = await DaemonClient.fromTarget(target, sharedToken).rpc('mintActorToken', ctx.root, {
      kind: 'user', email: 'ada@example.com', name: 'Ada',
    }) as { token: string };

    await ctx.restartDaemon();

    const refused = await rpcStatus(minted.token, 'list');
    expect(refused.status).toBe(401);
    // Actionable: the credential is real and this install does not take it.
    expect(refused.message).toContain('per-user token');
  }, 120_000);

  // A control token still names the ROLE — that is the CHANNEL a write came
  // through, and every CLI, supervisor and MCP path sets it deliberately. Only
  // the PERSON is the daemon's to decide.
  test('the role is still the caller\'s to name, and the person is the daemon\'s', async () => {
    ctx.git('-C', ctx.root, 'config', 'user.email', 'solo@example.com');
    ctx.git('-C', ctx.root, 'config', 'user.name', 'Solo Dev');
    const taskId = await createTask(ctx, 'Role and person task');

    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'From the builder'], {
      env: { LAZY_ACTOR: 'builder' },
    }));

    const comments = JSON.parse(
      readFileSync(taskFilePath(ctx.root, taskId, 'comments.json'), 'utf-8'),
    ).comments as Array<{ actor?: string; actor_email?: string; actor_name?: string }>;

    expect(comments[0]!.actor).toBe('builder');
    expect(comments[0]!.actor_email).toBe('solo@example.com');
    expect(comments[0]!.actor_name).toBe('Solo Dev');
  }, 120_000);
});
