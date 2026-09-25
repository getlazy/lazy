import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile } from 'fs/promises';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import {
  readTaskStatus, readTurns, taskFilePath, storageDirFor, setTaskStatus, readSessionJson, writeSessionJson,
  findFullTaskId,
} from '../helpers/storage';
import { consumeResponse, protocolDir as getProtocolDir } from '../../src/protocol';
import { seedFinal } from '../helpers/final';
import { runMcpSession } from '../helpers/mcp-session';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { getSessionCredentialsPath } from '../../src/daemon/paths';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { NO_OWNER_CREDENTIAL_MARKER } from '../../src/daemon/turn-credentials';

/**
 * Actor identity on the daemon's `/rpc/*` surface.
 *
 * The subject is WHO the daemon believes is calling: before this, identity on a
 * mutating RPC was a caller-supplied `actor` string, so anything holding the
 * shared token could claim to be anyone. Now the token proves it — the legacy
 * shared token proves `control` (and keeps its freedom to name an actor, which
 * is what makes single-user installs unaffected), while a minted per-user token
 * proves that user and CANNOT name anyone else.
 *
 * This is a `withDaemon` suite because every assertion is about a real HTTP
 * request against a real daemon: the auth decision lives in the server's
 * request path, and an in-process call would skip exactly the code under test.
 * Requests go through DaemonClient so the heartbeat envelope is unwrapped for
 * us — the same client every real caller uses.
 */
describe('daemon actor tokens', () => {
  let ctx: TestContext;
  /** The legacy shared bearer token — the thing that must keep working. */
  let sharedToken: string;
  /** Has this test's daemon been restarted into managed mode? */
  let managed = false;
  let target: string;

  /** An RPC call as some actor. Returns the parsed body; throws RpcApplicationError. */
  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  /** The HTTP status an RPC was refused with. Fails the test if it succeeded. */
  async function rpcStatus(token: string, command: string, params: Record<string, unknown> = {}) {
    try {
      await rpc(token, command, params);
      return { status: 200, message: '' };
    } catch (err) {
      if (!(err instanceof RpcApplicationError)) throw err;
      return { status: err.status, message: err.message };
    }
  }

  /**
   * Put this daemon in the posture where per-user tokens exist at all.
   *
   * A user token is a MANAGED-MODE credential: outside managed mode identity is
   * the daemon's own git config and a request never carries one, so `/rpc/*`
   * refuses a user token and `mintActorToken` refuses to mint one
   * (docs/design/actor-identity-and-remote-clients.md §3.4, and the
   * single-person suite). Armed in the DAEMON's environment, out of band, the
   * way the fleet supervisor arms it — and through the harness's own restart,
   * which keeps the module-mock preload, or every task launch below would go
   * looking for a real docker.
   *
   * Idempotent, and called by mintUserToken itself so no test can forget it.
   *
   * EVERY CONTROL-TOKEN SET-UP WRITE MUST HAPPEN BEFORE THE FIRST MINT — a
   * task to work on, a turn to unblock, a commit to carve regions from. That is
   * not a harness quirk but the subject of this suite's managed-mode half: on a
   * managed host a human action may not ride the control token, and creating a
   * task is a human action. A fixture built after arming gets the same 403 a
   * control plane would.
   */
  async function armManagedMode(): Promise<void> {
    if (managed) return;
    await ctx.restartDaemon({
      LAZY_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
    });
    managed = true;
  }

  /**
   * Mint a user actor token as the control plane.
   *
   * `(email, name)` BY NAME: a person is named the way the store names people,
   * and both halves land on every row the token writes.
   */
  async function mintUserToken(email: string, name?: string): Promise<string> {
    await armManagedMode();
    const result = await rpc(sharedToken, 'mintActorToken', { kind: 'user', email, name }) as { token: string };
    expect(typeof result.token).toBe('string');
    return result.token;
  }

  function readComments(shortId: string): Array<{ content: string; actor?: string; actor_email?: string; actor_name?: string }> {
    try {
      return JSON.parse(readFileSync(taskFilePath(ctx.root, shortId, 'comments.json'), 'utf-8')).comments;
    } catch {
      return [];
    }
  }

  /** A task's journal, as it is on disk — where an EDIT is attributed. */
  function readJournal(shortId: string): Array<{ content: string; actor?: string; actor_email?: string; actor_name?: string }> {
    try {
      return JSON.parse(readFileSync(taskFilePath(ctx.root, shortId, 'journal.json'), 'utf-8')).journal;
    } catch {
      return [];
    }
  }

  /** A task's status changelog, as it is on disk. */
  function readStatusChangelog(shortId: string): Array<{ status?: string; actor?: string; actor_email?: string; actor_name?: string }> {
    try {
      return JSON.parse(readFileSync(taskFilePath(ctx.root, shortId, 'status-changelog.json'), 'utf-8')).changes;
    } catch {
      return [];
    }
  }

  beforeEach(async () => {
    managed = false;
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

  // --- Back-compat: the load-bearing requirement ---

  // INVARIANT: the legacy shared token maps to {kind:'control'}. A single-user
  // install mints nothing and must be completely unaffected — including the
  // ordinary CLI paths, which authenticate with exactly this token.
  test('the legacy shared token still authenticates /rpc/*', async () => {
    const taskId = await createTask(ctx, 'Legacy token task');

    const result = await rpc(sharedToken, 'list', {}) as { tree: unknown[] };
    expect(Array.isArray(result.tree)).toBe(true);

    // And through the CLI, which is the real single-user path.
    const list = await ctx.lazy(['list']);
    expectSuccess(list);
    expect(list.stdout).toContain(taskId);
  });

  // INVARIANT: a control caller may still name the actor explicitly. This is
  // how MCP-originated commands are attributed today (LAZY_ACTOR=builder makes
  // the CLI pass actor='builder'), and how a control plane attributes an action
  // it performs on a user's behalf. Pinning must NOT have taken this away.
  test('a control caller may still supply an explicit actor', async () => {
    const taskId = await createTask(ctx, 'Explicit actor task');

    // Over the wire, as the control plane would.
    await rpc(sharedToken, 'storage', {
      method: 'createComment',
      args: { taskId, content: 'From the control plane', actor: 'builder' },
    });

    // And through the CLI's own actor plumbing.
    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'From the CLI'], {
      env: { LAZY_ACTOR: 'builder' },
    }));

    const comments = readComments(taskId);
    expect(comments.map(c => c.actor)).toEqual(['builder', 'builder']);
  });

  // --- Minting and revocation ---

  test('a minted user token authenticates /rpc/*', async () => {
    await createTask(ctx, 'User token task');
    const userToken = await mintUserToken('ada@example.com', 'Ada');
    expect(userToken).not.toBe(sharedToken);

    const result = await rpc(userToken, 'list', {}) as { tree: unknown[] };
    expect(Array.isArray(result.tree)).toBe(true);
  });

  test('mintActorToken reports the identity it bound, and rotate replaces the secret', async () => {
    // Built BEFORE the first mint: creating a task is itself a human action, so
    // a managed daemon refuses it on the control token (see armManagedMode).
    const graceTask = await createTask(ctx, 'Grace attribution task');
    await armManagedMode();
    const first = await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: 'grace@example.com', name: 'Grace' }) as
      { token: string; kind: string; email: string; name: string };
    expect(first.kind).toBe('user');
    expect(first.email).toBe('grace@example.com');
    expect(first.name).toBe('Grace');

    // Minting again without rotate returns the SAME secret (idempotent), so a
    // second call from the control plane doesn't lock out a live session.
    const again = await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: 'grace@example.com', name: 'Grace' }) as { token: string };
    expect(again.token).toBe(first.token);

    // The identity is the EMAIL, so a corrected display name reaches the same
    // person rather than minting a second equally valid credential for them.
    const renamed = await rpc(sharedToken, 'mintActorToken', {
      kind: 'user', email: 'grace@example.com', name: 'Grace Hopper',
    }) as { token: string };
    expect(renamed.token).toBe(first.token);

    // INVARIANT: and the correction actually LANDS on the next row she writes.
    // Reusing the token must not mean ignoring the pair it was re-minted with:
    // the record kept its old name, so every row stayed stamped 'Grace' forever
    // and the only remedy was `rotate: true`, which logs a member out
    // mid-session. A wrong name is worse than no name, and a stale one is a
    // wrong one by another route — on rows that are append-only.
    await rpc(renamed.token, 'storage', {
      method: 'createComment',
      args: { taskId: graceTask, content: 'after the correction' },
    });
    const graceComments = readComments(graceTask);
    expect(graceComments[0]!.actor_email).toBe('grace@example.com');
    expect(graceComments[0]!.actor_name).toBe('Grace Hopper');

    // Clearing it is expressible too: a mint carrying no name unsets the stored
    // one rather than leaving the previous value standing.
    const unnamed = await rpc(sharedToken, 'mintActorToken', {
      kind: 'user', email: 'grace@example.com',
    }) as { token: string };
    expect(unnamed.token).toBe(first.token);
    await rpc(unnamed.token, 'storage', {
      method: 'createComment',
      args: { taskId: graceTask, content: 'after the name was cleared' },
    });
    expect(readComments(graceTask)[1]!.actor_name).toBeUndefined();

    // Rotation is the opposite: a fresh secret, and the old one stops working.
    const rotated = await rpc(sharedToken, 'mintActorToken', {
      kind: 'user', email: 'grace@example.com', name: 'Grace', rotate: true,
    }) as { token: string };
    expect(rotated.token).not.toBe(first.token);

    expect((await rpcStatus(first.token, 'list')).status).toBe(401);
    expect((await rpcStatus(rotated.token, 'list')).status).toBe(200);
  });

  test('revokeActorToken invalidates the token', async () => {
    const userToken = await mintUserToken('revoked@example.com');
    expect((await rpcStatus(userToken, 'list')).status).toBe(200);

    const revoked = await rpc(sharedToken, 'revokeActorToken', { email: 'revoked@example.com' }) as { revoked: number };
    expect(revoked.revoked).toBe(1);

    expect((await rpcStatus(userToken, 'list')).status).toBe(401);

    // Idempotent — revoking again is not an error, it just finds nothing.
    const second = await rpc(sharedToken, 'revokeActorToken', { email: 'revoked@example.com' }) as { revoked: number };
    expect(second.revoked).toBe(0);
  });

  // INVARIANT: a person's address is stored canonically (trimmed, case-folded),
  // so one person has exactly one key. `isPersonEmail` trims before testing, so
  // a padded or mixed-case address VALIDATES — and storing the raw string let
  // one member exist under several keys at once: a revoke answered "revoked 0"
  // (indistinguishable from "already gone") while the token kept authenticating,
  // the credential registry filed the secret under its own trimmed spelling so
  // the member was refused with the no-credential marker, and attribution split
  // into two actor_email values that nothing downstream reconciles.
  test('a padded, mixed-case address mints and revokes as the same person', async () => {
    await armManagedMode();
    const minted = await rpc(sharedToken, 'mintActorToken', {
      kind: 'user', email: '  Ada.Lovelace@Example.COM ', name: 'Ada',
    }) as { token: string; email: string };

    // The mint REPORTS the canonical form, so a control plane that echoes what
    // it was given back into its own records stays in step with the daemon.
    expect(minted.email).toBe('ada.lovelace@example.com');
    expect((await rpcStatus(minted.token, 'list')).status).toBe(200);

    // Minting the canonical spelling reaches the SAME identity rather than
    // handing this person a second, equally valid credential.
    const again = await rpc(sharedToken, 'mintActorToken', {
      kind: 'user', email: 'ada.lovelace@example.com', name: 'Ada',
    }) as { token: string };
    expect(again.token).toBe(minted.token);

    // And the revoke reaches it — the failure this test exists for.
    const revoked = await rpc(sharedToken, 'revokeActorToken', {
      email: 'ada.lovelace@example.com',
    }) as { revoked: number };
    expect(revoked.revoked).toBe(1);
    expect((await rpcStatus(minted.token, 'list')).status).toBe(401);
  });

  test('revokeActorToken requires exactly one selector', async () => {
    const none = await rpcStatus(sharedToken, 'revokeActorToken', {});
    expect(none.status).toBe(400);

    const both = await rpcStatus(sharedToken, 'revokeActorToken', { email: 'a@example.com', label: 'l' });
    expect(both.status).toBe(400);
  });

  // --- Managed mode: a human action goes out on that human's token ---
  //
  // The flip this section is about. A control token names the CONTROL PLANE and
  // nobody in particular, and it used to be able to name any actor on any verb
  // — which is how five verbs came to be attributed to people and the rest to a
  // machine. On a managed host the daemon refuses instead, and says what to do
  // about it (docs/design/actor-identity-and-remote-clients.md §3.6).

  // INVARIANT: an ACCEPT is a person's decision. On a managed host the control
  // token may not take it, and the refusal names the remedy rather than leaving
  // a caller to guess — a 403 that does not say "mint a user token for the
  // acting member" is a dead end for the one party who could fix it.
  test('a control-token accept is refused in managed mode, and the same accept on a user token lands', async () => {
    const taskId = await createTask(ctx, 'Managed accept task', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Something to merge, committed in the task's own worktree.
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
    expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);

    const userToken = await mintUserToken('ada@example.com', 'Ada Lovelace');

    const refused = await rpcStatus(sharedToken, 'acceptTask', { taskId });
    expect(refused.status).toBe(403);
    expect(refused.message).toContain('human-initiated');
    expect(refused.message).toContain('mintActorToken');
    // Refused before any work: the task is untouched, not half-accepted.
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    // The same call on the acting member's token lands, and the row it writes
    // names her — which is the whole point of refusing the other one.
    await rpc(userToken, 'acceptTask', { taskId });
    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');

    const accepted = readStatusChangelog(taskId).filter(c => c.status === 'complete');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.actor_email).toBe('ada@example.com');
    expect(accepted[0]!.actor_name).toBe('Ada Lovelace');
  });

  // INVARIANT: an EDIT names whoever made it. `editTask` read no actor at all
  // before this, so a per-user token on it bought nothing and "who put this
  // task on the expensive model?" had no answer on a shared project. The Task
  // record carries no actor, so the change is recorded where attribution CAN
  // live: an attributed journal entry, which — unlike a comment — is never
  // delivered into the agent's prompt as guidance.
  test("a team member's model change through editTask names them", async () => {
    const taskId = await createTask(ctx, 'Managed edit task', 'Some work');
    const userToken = await mintUserToken('ada@example.com', 'Ada Lovelace');

    const refused = await rpcStatus(sharedToken, 'editTask', { taskId, model: 'opus' });
    expect(refused.status).toBe(403);
    expect(refused.message).toContain('human-initiated');
    expect(readJournal(taskId)).toHaveLength(0);

    const result = await rpc(userToken, 'editTask', { taskId, model: 'opus' }) as { changes: string[] };
    expect(result.changes).toContain('model');

    const journal = readJournal(taskId);
    expect(journal).toHaveLength(1);
    // The VALUE, not just the field name: "model" alone answers a different
    // question than "model → opus".
    expect(journal[0]!.content).toContain('model → opus');
    expect(journal[0]!.actor).toBe('human');
    expect(journal[0]!.actor_email).toBe('ada@example.com');
    expect(journal[0]!.actor_name).toBe('Ada Lovelace');
  });

  // INVARIANT: the control plane keeps every surface that is IT acting rather
  // than a person — otherwise a fleet host could not hand out tokens, push a
  // member's credential, or read anything, and the refusal above would lock the
  // whole system out instead of directing it. §3.6 enumerates these.
  test('managed mode leaves the control-plane surfaces and every read alone', async () => {
    const taskId = await createTask(ctx, 'Control surfaces task');
    await mintUserToken('ada@example.com', 'Ada');

    expect((await rpcStatus(sharedToken, 'list')).status).toBe(200);
    expect((await rpcStatus(sharedToken, 'show', { taskId })).status).toBe(200);
    expect((await rpcStatus(sharedToken, 'search', { query: 'task' })).status).toBe(200);
    expect((await rpcStatus(sharedToken, 'getProjectSettings')).status).toBe(200);
    expect((await rpcStatus(sharedToken, 'putUserCredential', {
      userId: 'ada@example.com', kind: 'oauth', token: 'oat-for-ada',
    })).status).toBe(200);
    expect((await rpcStatus(sharedToken, 'mintActorToken', { kind: 'control', label: 'second-client' })).status)
      .toBe(200);
    expect((await rpcStatus(sharedToken, 'concurrency', {})).status).toBe(200);
  });

  // INVARIANT: none of this exists outside managed mode. There is no control
  // plane on a laptop, the control token IS the machine's owner, and identity
  // comes from the daemon's own git config — so the same two calls that are
  // 403s above must behave exactly as they did before this change. This is the
  // back-compat case that must not regress.
  test('unmanaged mode is unchanged: a control-token edit lands and records the git identity', async () => {
    ctx.git('-C', ctx.root, 'config', 'user.email', 'solo@example.com');
    ctx.git('-C', ctx.root, 'config', 'user.name', 'Solo Dev');
    const taskId = await createTask(ctx, 'Unmanaged edit task', 'Some work');

    // No armManagedMode() anywhere in this test — this daemon is a laptop's.
    const result = await rpc(sharedToken, 'editTask', { taskId, model: 'opus' }) as { changes: string[] };
    expect(result.changes).toContain('model');

    const journal = readJournal(taskId);
    expect(journal).toHaveLength(1);
    expect(journal[0]!.content).toContain('model → opus');
    expect(journal[0]!.actor_email).toBe('solo@example.com');
    expect(journal[0]!.actor_name).toBe('Solo Dev');

    // And a comment, the other shape of write, still records the git identity
    // rather than being refused for want of a user token.
    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'Still works']));
    expect(readComments(taskId)[0]!.actor_email).toBe('solo@example.com');
  });

  // INVARIANT: the refusal cannot be walked around through the storage proxy.
  // `editTask`'s own writers carry no actor (`updateTaskModel`,
  // `updateTaskGoal`, `updateTaskPrompt`), so a gate that looked only at rows
  // WITH a person column would refuse the verb and allow the identical change
  // one `storage` call lower — which is how the widest mutating surface in the
  // daemon becomes the way around every rule above it.
  test('the storage proxy is not a way around the managed-mode refusal', async () => {
    const taskId = await createTask(ctx, 'Proxy bypass task');
    await mintUserToken('ada@example.com', 'Ada');

    for (const [method, args] of [
      ['updateTaskModel', { taskId, model: 'opus' }],
      ['updateTaskGoal', { taskId, goal: 'Something else entirely' }],
      ['createComment', { taskId, content: 'On nobody\'s behalf' }],
    ] as const) {
      const refused = await rpcStatus(sharedToken, 'storage', { method, args });
      expect(refused.status).toBe(403);
      expect(refused.message).toContain('human-initiated');
    }

    // A READ through the same proxy is untouched, on the same token.
    expect((await rpcStatus(sharedToken, 'storage', { method: 'listTasks', args: {} })).status).toBe(200);
  });

  // INVARIANT: actor tokens and agent MCP tokens are different populations. The
  // control plane must not be able to strip a RUNNING agent of its tools
  // mid-turn; agent tokens are revoked by the session lifecycle that owns them.
  test('revokeActorToken refuses an MCP session token', async () => {
    const mcpToken = await mintBuilderMcpToken();

    const refused = await rpcStatus(sharedToken, 'revokeActorToken', { token: mcpToken });
    expect(refused.status).toBe(400);
    expect(refused.message).toContain('MCP session token');
  });

  // --- The two surfaces are disjoint ---

  // INVARIANT: an agent's MCP token authenticates POST /mcp/* and nothing else.
  // If it reached /rpc/*, a task agent would inherit the whole control surface —
  // the exact impersonation per-identity tokens exist to prevent.
  test('an MCP session token is refused on /rpc/*', async () => {
    const mcpToken = await mintBuilderMcpToken();

    const refused = await rpcStatus(mcpToken, 'list');
    expect(refused.status).toBe(401);
    // Actionable: the caller has a VALID credential and the wrong endpoint.
    expect(refused.message).toContain('MCP session token');
  });

  // --- User-kind callers may not impersonate ---

  // INVARIANT: a user token's identity comes from the token only. Naming a
  // different actor is refused (403) rather than silently ignored — a caller
  // acting under an identity it did not ask for is worse than a hard error.
  test('a user token may not supply an actor on a mutating RPC', async () => {
    const taskId = await createTask(ctx, 'Impersonation task');
    const userToken = await mintUserToken('mallory@example.com');

    const refused = await rpcStatus(userToken, 'unblockTask', {
      taskId, message: 'feedback', actor: 'builder',
    });
    expect(refused.status).toBe(403);

    // The refusal happens before any work: no turn was written.
    expect(readTurns(ctx.root, taskId)).toHaveLength(0);
  });

  // The storage proxy nests its arguments one level down, and is the widest
  // mutating surface there is (createTask, updateTaskStatus, createComment,
  // addTaskTag, saveMemory…). A gate that only inspected top-level params
  // would be bypassable by anyone who knew to use it.
  test('a user token may not supply an actor through the storage proxy', async () => {
    const taskId = await createTask(ctx, 'Proxy impersonation task');
    const userToken = await mintUserToken('mallory@example.com');

    const refused = await rpcStatus(userToken, 'storage', {
      method: 'createComment',
      args: { taskId, content: 'not really the builder', actor: 'builder' },
    });
    expect(refused.status).toBe(403);
    expect(readComments(taskId)).toHaveLength(0);
  });

  // INVARIANT: naming somebody ELSE as the person is refused exactly like
  // naming another role is. The stored value would be unforgeable either way
  // (it comes from the token), but a client that thinks it is writing as
  // another user is confused about whose identity it holds — silently
  // rewriting the row it asked for would hide that from it.
  test('a user token may not supply a foreign email', async () => {
    const taskId = await createTask(ctx, 'Foreign email task');
    const userToken = await mintUserToken('mallory@example.com');

    const refused = await rpcStatus(userToken, 'unblockTask', {
      taskId, message: 'feedback', actor: { role: 'human', email: 'ada@example.com' },
    });
    expect(refused.status).toBe(403);
    // The refusal names the token's OWN user, so the caller can see the
    // identity it actually holds rather than guessing.
    expect(refused.message).toContain('mallory@example.com');
    expect(refused.message).toContain('ada@example.com');

    // Refused before any work, same as the foreign-role case.
    expect(readTurns(ctx.root, taskId)).toHaveLength(0);
  });

  // The nested surfaces need the same rule, or the refusal is one `storage`
  // call away from being bypassed.
  test('a user token may not supply a foreign email through the storage proxy', async () => {
    const taskId = await createTask(ctx, 'Proxy foreign email task');
    const userToken = await mintUserToken('mallory@example.com');

    const refused = await rpcStatus(userToken, 'storage', {
      method: 'createComment',
      args: { taskId, content: 'signed by somebody else', actor: { role: 'human', email: 'ada@example.com' } },
    });
    expect(refused.status).toBe(403);
    expect(readComments(taskId)).toHaveLength(0);
  });

  // INVARIANT: the pre-identity `{ role, userId }` spelling is refused by NAME
  // rather than ignored. This path replaces the supplied actor wholesale, so a
  // client still sending an opaque id would lose its attribution silently —
  // the row comes back with nobody on it and nothing failed.
  test('the pre-identity userId spelling is refused, naming the replacement', async () => {
    const taskId = await createTask(ctx, 'Legacy actor spelling task');
    const userToken = await mintUserToken('ada@example.com');

    const refused = await rpcStatus(userToken, 'storage', {
      method: 'createComment',
      args: { taskId, content: 'named by an id', actor: { role: 'human', userId: 'ada@example.com' } },
    });
    expect(refused.status).toBe(400);
    expect(refused.message).toContain('email');
    expect(readComments(taskId)).toHaveLength(0);
  });

  // Its OWN address, spelled out, is redundant rather than wrong — the pin
  // would write exactly that. Refusing it would make an honest client's
  // explicit request fail for no reason.
  test('a user token may supply its own email redundantly', async () => {
    const taskId = await createTask(ctx, 'Redundant email task');
    const userToken = await mintUserToken('ada@example.com');

    const accepted = await rpcStatus(userToken, 'storage', {
      method: 'createComment',
      args: { taskId, content: 'mine, said twice', actor: { role: 'human', email: 'ada@example.com' } },
    });
    expect(accepted.status).toBe(200);

    const comments = readComments(taskId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.actor_email).toBe('ada@example.com');
  });

  // INVARIANT: a token-derived person is pinned only where a person FITS —
  // the locations PERSON_ATTRIBUTED_STORAGE_ACTORS declares. Most of Storage's
  // writers take a bare Actor ROLE STRING and their rows have no person columns
  // at all; the proxy passes the argument through as `any`, so pinning an
  // ActorRef object into one of them persisted `{"role":"human",...}` verbatim
  // into append-only state, rendering as "[object Object]". The daemon's own
  // stamping path consulted this map already — the token-pinning path did not,
  // and on a managed host it is the ONLY route these writes take.
  test('a user token does not pin an actor object into a writer typed for a role', async () => {
    const userToken = await mintUserToken('ada@example.com');

    const saved = await rpcStatus(userToken, 'storage', {
      method: 'saveMemory',
      args: {
        input: {
          name: 'pinning-check',
          description: 'a record written with no actor supplied',
          type: 'project',
          body: 'The pin must not reach this writer.',
        },
      },
    });
    expect(saved.status).toBe(200);

    const record = await rpc(userToken, 'storage', {
      method: 'getMemory',
      args: { name: 'pinning-check' },
    }) as { updated_by?: unknown; created_by?: unknown } | null;

    // Supplied no actor, so the row records none — NOT an ActorRef object. This
    // is the shape the bug produced: `updated_by: {"role":"human","email":…}`.
    expect(typeof record?.updated_by).not.toBe('object');
    expect(typeof record?.created_by).not.toBe('object');

    // The same writer WITH a legitimate bare role keeps that role verbatim: a
    // plain string reaches `saveMemory`, which is what its signature promises.
    await rpc(userToken, 'storage', {
      method: 'saveMemory',
      args: {
        input: {
          name: 'pinning-check',
          description: 'a record written with a bare role',
          type: 'project',
          body: 'Still a role string, not an object.',
        },
        actor: 'human',
      },
    });

    const withRole = await rpc(userToken, 'storage', {
      method: 'getMemory',
      args: { name: 'pinning-check' },
    }) as { updated_by: unknown };
    expect(withRole.updated_by).toBe('human');
  });

  // The other half of the same rule: a method that IS declared still gets the
  // person, so narrowing the pin did not quietly stop attributing anything.
  test('a declared storage writer still receives the token holder', async () => {
    const taskId = await createTask(ctx, 'Declared writer task');
    const userToken = await mintUserToken('ada@example.com', 'Ada Lovelace');

    await rpc(userToken, 'storage', {
      method: 'createComment',
      args: { taskId, content: 'attributed without being asked' },
    });

    const comments = readComments(taskId);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.actor_email).toBe('ada@example.com');
    expect(comments[0]!.actor_name).toBe('Ada Lovelace');
  });

  // INVARIANT: a reply on a raised item names the person who wrote it. A raised
  // item is what GATES an accept, so its conversation is the human-written
  // record a reviewer reads right beside the attributed resolution — the one
  // place an anonymous row is most conspicuous. This needs the method to be
  // declared in PERSON_ATTRIBUTED_STORAGE_ACTORS: being a top-level `actor` arg
  // is necessary but not sufficient, since both the pinning and the stamping
  // paths write only at a declared path.
  test('a raised-item reply carries the person who wrote it', async () => {
    const taskId = await createTask(ctx, 'Raised comment attribution task');
    const userToken = await mintUserToken('ada@example.com', 'Ada Lovelace');

    const item = await rpc(userToken, 'storage', {
      method: 'createRaisedItem',
      args: {
        taskId,
        input: { content: 'Should the flag default on?', blocking: true },
      },
    }) as { id: string };

    await rpc(userToken, 'storage', {
      method: 'addRaisedItemComment',
      args: { taskId, itemId: item.id, content: 'Answered: it defaults off.' },
    });

    const items = JSON.parse(
      readFileSync(taskFilePath(ctx.root, taskId, 'raised-items.json'), 'utf-8'),
    ).raised_items as Array<{
      comments?: Array<{ actor?: unknown; actor_email?: string; actor_name?: string }>;
    }>;

    const comment = items[0]!.comments![0]!;
    expect(comment.actor_email).toBe('ada@example.com');
    expect(comment.actor_name).toBe('Ada Lovelace');
    // The role stays a plain STRING beside the person, never an ActorRef object.
    expect(typeof comment.actor).toBe('string');
  });

  // INVARIANT: minting and revoking credentials is a control-plane action. A
  // user token that could mint could mint itself a control token.
  test('a user token may not mint or revoke actor tokens', async () => {
    const userToken = await mintUserToken('ada@example.com');

    const mint = await rpcStatus(userToken, 'mintActorToken', { kind: 'control', label: 'escalated' });
    expect(mint.status).toBe(403);

    const revoke = await rpcStatus(userToken, 'revokeActorToken', { email: 'ada@example.com' });
    expect(revoke.status).toBe(403);
  });

  // INVARIANT: a per-user token exists to work on tasks, not to take the daemon
  // away from everyone else on it.
  test('a user token may not shut the daemon down', async () => {
    const userToken = await mintUserToken('ada@example.com');

    const response = await fetch(`${target}/daemon/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(response.status).toBe(403);

    // Still serving — the refusal was a refusal, not a slow shutdown.
    expect((await rpcStatus(sharedToken, 'list')).status).toBe(200);
  });

  // --- The actor a user token proves is what gets recorded ---

  test('a user token records its own actor on a comment it writes', async () => {
    const taskId = await createTask(ctx, 'User comment task');
    const userToken = await mintUserToken('ada@example.com', 'Ada');

    await rpc(userToken, 'storage', {
      method: 'createComment',
      args: { taskId, content: 'From Ada' },
    });

    const comments = readComments(taskId);
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toBe('From Ada');
    // 'human' is the channel taxonomy value for a person acting directly, and
    // `actor_email` is WHICH person — both derived from the token, both in the
    // store, so an export carries who-did-what without Rails.
    expect(comments[0].actor).toBe('human');
    expect(comments[0].actor_email).toBe('ada@example.com');
  });

  // INVARIANT: a user token stamps BOTH halves of the pair it was minted with,
  // and the display name comes from the MINT — never from the token's
  // free-text label, which names the token rather than a person. The earlier
  // rule (stamp the email, no name) existed because the one control plane
  // minting these passed the member's address as the label beside an opaque id,
  // so adopting the label would have inverted the two halves and persisted a
  // person who does not exist. The mint taking `(email, name)` by name is what
  // makes the name safe to stamp — nothing else about the posture changed, and
  // there is still no request field for either half.
  test('a user token stamps the (email, name) pair the mint carried', async () => {
    const taskId = await createTask(ctx, 'Named token task');
    // Both fixtures FIRST: once managed mode is armed, the control token this
    // harness holds may no longer take a human action, which includes creating
    // a task (see armManagedMode).
    const { taskId: regionTaskId, regionId } = await taskWithARegion('Named token region');
    const userToken = await mintUserToken('ada@example.com', 'Ada Lovelace');

    await rpc(userToken, 'storage', {
      method: 'createComment',
      args: { taskId, content: 'From Ada' },
    });

    const comments = readComments(taskId);
    expect(comments[0]!.actor_email).toBe('ada@example.com');
    expect(comments[0]!.actor_name).toBe('Ada Lovelace');

    // And the same on a region overlay, which derives its person the same way.
    const result = await rpc(userToken, 'regionOverlay', {
      taskId: regionTaskId, region: regionId, signOff: true,
    }) as { overlay: { signed_off_by?: unknown } };
    expect(result.overlay.signed_off_by).toEqual({ email: 'ada@example.com', name: 'Ada Lovelace' });
  });

  // The other half of the pair is optional, and an absent name is ABSENT — not
  // an empty string and not the address repeated. A row with no name renders as
  // the email alone, exactly as a pre-identity row does.
  test('a mint with no display name stamps the email alone', async () => {
    const taskId = await createTask(ctx, 'Nameless token task');
    const userToken = await mintUserToken('nameless@example.com');

    await rpc(userToken, 'storage', {
      method: 'createComment',
      args: { taskId, content: 'From somebody with no display name' },
    });

    const comments = readComments(taskId);
    expect(comments[0]!.actor_email).toBe('nameless@example.com');
    expect('actor_name' in comments[0]!).toBe(false);
  });

  // INVARIANT: a user token names a PERSON, so the mint refuses anything that
  // cannot be one. Every row it writes promises an email, and the migration
  // clears a value it cannot read as one — a token minting `user-12` would
  // write back exactly what that migration exists to remove.
  test('minting a user token refuses an opaque id, and the old field names', async () => {
    await armManagedMode();

    const opaque = await rpcStatus(sharedToken, 'mintActorToken', { kind: 'user', email: 'user-12' });
    expect(opaque.status).toBe(400);
    expect(opaque.message).toContain('email');

    // The pre-identity spelling is refused BY NAME rather than mapped: the two
    // fields were in practice passed inverted, so accepting them would persist
    // a person who does not exist.
    const legacy = await rpcStatus(sharedToken, 'mintActorToken', {
      kind: 'user', userId: 'user-12', label: 'ada@example.com',
    });
    expect(legacy.status).toBe(400);
    expect(legacy.message).toContain("'email'");
    expect(legacy.message).toContain("'name'");

    const legacyRevoke = await rpcStatus(sharedToken, 'revokeActorToken', { userId: 'user-12' });
    expect(legacyRevoke.status).toBe(400);
    expect(legacyRevoke.message).toContain('email');
  });

  // The point of naming people git's way: the pair a write carried comes back
  // out of `lazy show` as `name <email>`, on the human surface AND on `--json`,
  // so a reader of either can answer "which person" without a directory to
  // resolve an id against. The pair comes from GIT — on a laptop that is the
  // only place it can come from, and a request naming a person is refused (see
  // the single-person suite).
  test('an (email, name) pair round-trips through lazy show and --json', async () => {
    ctx.git('-C', ctx.root, 'config', 'user.email', 'ada@example.com');
    ctx.git('-C', ctx.root, 'config', 'user.name', 'Ada Lovelace');
    const taskId = await createTask(ctx, 'Git-named comment task');

    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'From Ada, by name']));

    const comments = readComments(taskId);
    expect(comments[0]!.actor_email).toBe('ada@example.com');
    expect(comments[0]!.actor_name).toBe('Ada Lovelace');

    const shown = await ctx.lazy(['show', taskId, '--full']);
    expectSuccess(shown);
    expect(shown.stdout).toContain('Ada Lovelace <ada@example.com>');

    const json = await ctx.lazy(['show', taskId, '--json']);
    expectSuccess(json);
    const payload = JSON.parse(json.stdout) as {
      comments: Array<{ actor_email: string | null; actor_name: string | null }>;
    };
    expect(payload.comments[0]!.actor_email).toBe('ada@example.com');
    expect(payload.comments[0]!.actor_name).toBe('Ada Lovelace');
  });

  test('a user token records its actor on the feedback turn of an unblock', async () => {
    const taskId = await createTask(ctx, 'Unblock attribution task', 'Some work');

    // A real turn, so the task reaches `blocked` with a live session — unblock
    // refuses anything else, and staging the state by hand would test a state
    // the daemon never produces.
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const waited = await ctx.lazy(['wait', taskId]);
    if (waited.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waited.stderr}\n${waited.stdout}`);
    }

    const userToken = await mintUserToken('ada@example.com', 'Ada');
    await rpc(userToken, 'unblockTask', { taskId, message: 'Please also handle the empty case' });

    const waitedAgain = await ctx.lazy(['wait', taskId]);
    if (waitedAgain.exitCode !== 0) {
      throw new Error(`second wait failed for ${taskId}: ${waitedAgain.stderr}\n${waitedAgain.stdout}`);
    }

    const feedbackTurn = readTurns(ctx.root, taskId)
      .find(t => t.role === 'human' && String(t.content).includes('Please also handle the empty case'));
    expect(feedbackTurn).toBeDefined();
    expect(feedbackTurn!.actor).toBe('human');
    // The web-initiated turn names the PERSON, not just the kind of actor.
    expect(feedbackTurn!.actor_email).toBe('ada@example.com');
  });

  /**
   * A started task with one real commit in its worktree, so its changes carve
   * into at least one region. Returns the id of a region to write an overlay on.
   */
  async function taskWithARegion(goal: string): Promise<{ taskId: string; regionId: string }> {
    const taskId = await createTask(ctx, goal, 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const waited = await ctx.lazy(['wait', taskId]);
    if (waited.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waited.stderr}\n${waited.stdout}`);
    }

    // The in-daemon agent uses the daemon's own mock response, so the commit
    // this task's regions are carved from is made here (see CLAUDE.md).
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], { cwd: worktree });
      if (r.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr)}`);
      }
    };
    git('config', 'user.email', 'test@lazy.test');
    git('config', 'user.name', 'Lazy Test');
    writeFileSync(join(worktree, 'carved.txt'), 'one\ntwo\nthree\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'A commit to carve', '--no-verify');

    // An overlay is keyed to a PRESENTED region — the walkthrough a park
    // filed — so the fixture has to file one. A carve id from before the task
    // presented has nothing for a sign-off to land on (regions-service §6.3).
    await runMcpSession(ctx.root, taskId, worktree, [
      {
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Carved a region to sign off on' }],
            presentation: {
              groups: [{ title: 'Carved', tier: 'core', items: [{ kind: 'file', file: 'carved.txt' }] }],
            },
          },
        },
      },
    ]);

    const cover = await rpc(sharedToken, 'regions', { taskId }) as
      { regions: Array<{ id: string }> };
    const regionId = cover.regions[0]?.id;
    if (!regionId) throw new Error(`no regions carved for ${taskId}`);
    return { taskId, regionId };
  }

  // INVARIANT: a sign-off names the person whose TOKEN made it. An approval
  // with nobody on it reads as "somebody checked this", which on a review
  // several people share is worse than no approval — nobody can tell who to
  // ask. The name is the daemon's to derive, so there is deliberately no
  // request field for it.
  test('a user token signs off and assigns an owner in its own name', async () => {
    const { taskId, regionId } = await taskWithARegion('Region attribution task');
    const userToken = await mintUserToken('ada@example.com', 'Ada');

    const result = await rpc(userToken, 'regionOverlay', {
      taskId,
      region: regionId,
      owner: 'ierceg',
      signOff: true,
    }) as { overlay: { owner_set_by?: unknown; signed_off_by?: unknown } };

    expect(result.overlay.owner_set_by).toEqual({ email: 'ada@example.com', name: 'Ada' });
    expect(result.overlay.signed_off_by).toEqual({ email: 'ada@example.com', name: 'Ada' });
  });

  // INVARIANT: identity comes from the TOKEN, never from the request. A field a
  // caller could fill would let any token record an approval in somebody else's
  // name — the one thing a sign-off may not allow — so the parameter does not
  // exist and a hand-rolled caller sending one changes nothing.
  test('a name supplied in the request body is ignored', async () => {
    const { taskId, regionId } = await taskWithARegion('Forged attribution task');
    const userToken = await mintUserToken('ada@example.com', 'Ada');

    const result = await rpc(userToken, 'regionOverlay', {
      taskId,
      region: regionId,
      signOff: true,
      signed_off_by: { email: 'mallory@example.com', name: 'Mallory' },
      reviewer: 'Mallory',
    }) as { overlay: { signed_off_by?: unknown } };

    expect(result.overlay.signed_off_by).toEqual({ email: 'ada@example.com', name: 'Ada' });
  });

  // The other half, as everywhere else here: a caller the daemon cannot
  // attribute to a person records NOTHING. A single-machine install has one
  // user and needs no name; a placeholder would put a name on an approval
  // nobody gave.
  test('a control-plane sign-off records no person', async () => {
    const { taskId, regionId } = await taskWithARegion('Unattributed sign-off task');

    const result = await rpc(sharedToken, 'regionOverlay', {
      taskId,
      region: regionId,
      owner: 'ierceg',
      signOff: true,
    }) as { overlay: { owner_set_by?: unknown; signed_off_by?: unknown } };

    expect(result.overlay.owner_set_by).toBeUndefined();
    expect(result.overlay.signed_off_by).toBeUndefined();
  });

  // The other half of the same claim, on the install that has no control plane:
  // the person is not absent there, it is the GIT IDENTITY — the same address
  // git stamps on the commits these rows describe. The ROLE still says which
  // channel the write came through; the email says which human is behind the
  // machine. (Who asked for an AGENT's turn specifically is
  // `agent-turns-carry-the-turn-owner`; on a one-person install they are the
  // same person either way.)
  test('a CLI action on a laptop records the git identity', async () => {
    ctx.git('-C', ctx.root, 'config', 'user.email', 'solo@example.com');
    ctx.git('-C', ctx.root, 'config', 'user.name', 'Solo Dev');
    const taskId = await createTask(ctx, 'CLI attribution task', 'Some work');

    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'From the terminal']));

    const comments = readComments(taskId);
    expect(comments).toHaveLength(1);
    expect(comments[0].actor).toBe('human');
    expect(comments[0].actor_email).toBe('solo@example.com');
    expect(comments[0].actor_name).toBe('Solo Dev');
  });

  // The reason attribution lives in the STORE and not only in the control
  // plane's own audit: the store is what a user takes with them. Every
  // assertion above reads the daemon's persisted files directly, and this one
  // says so explicitly for the whole set of attribution-bearing rows.
  test('the persisted store files carry the person on turns, comments, status and tags', async () => {
    const taskId = await createTask(ctx, 'Portable attribution task', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const waited = await ctx.lazy(['wait', taskId]);
    if (waited.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waited.stderr}\n${waited.stdout}`);
    }

    const userToken = await mintUserToken('ada@example.com', 'Ada');
    await rpc(userToken, 'storage', { method: 'createComment', args: { taskId, content: 'From Ada' } });
    await rpc(userToken, 'storage', { method: 'addTaskTag', args: { taskId, tag: 'reviewed' } });
    // A REAL transition: the task is already `blocked` after the turn, and a
    // same-state write is an idempotent no-op that appends no changelog entry.
    await rpc(userToken, 'storage', { method: 'updateTaskStatus', args: { taskId, status: 'working' } });

    const changelog = JSON.parse(
      readFileSync(taskFilePath(ctx.root, taskId, 'status-changelog.json'), 'utf-8')
    ).changes as Array<{ actor_email?: string }>;
    const tagHistory = JSON.parse(
      readFileSync(taskFilePath(ctx.root, taskId, 'tag-history.json'), 'utf-8')
    ).events as Array<{ actor_email?: string }>;

    expect(changelog.some(c => c.actor_email === 'ada@example.com')).toBe(true);
    expect(tagHistory.some(e => e.actor_email === 'ada@example.com')).toBe(true);
    expect(readComments(taskId).some(c => c.actor_email === 'ada@example.com')).toBe(true);
  });

  // --- Whose Anthropic account the turn actually spends ---
  //
  // The section above is about the NAME on an action. This one is about the
  // BILL for it, which is the reason per-user tokens exist: a turn a member
  // launched from a web UI must run on that member's own Anthropic account —
  // so usage is traceable to a person, a member's quota stays theirs, and one
  // account is never shared between people. The proof has to be live, because
  // the decision is made in the daemon process from the identity the token
  // proved, and the artefact it leaves is the session-credential binding the
  // container's placeholder resolves through.

  /** The credential bindings this daemon has written, as they are on disk. */
  async function readBindings(): Promise<Array<{
    taskId: string; ownerUserId: string; kind: string; revokedAt: number | null;
  }>> {
    try {
      const raw = await readFile(getSessionCredentialsPath(ctx.root), 'utf-8');
      return JSON.parse(raw).bindings ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Store a user's Anthropic credential, as the control plane does. */
  async function putCredential(userId: string): Promise<void> {
    await rpc(sharedToken, 'putUserCredential', {
      userId, kind: 'oauth', token: `oat-for-${userId}`,
    });
  }

  /** One real turn, so the task reaches `blocked` with a live session. */
  async function runOneTurn(taskId: string): Promise<void> {
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const waited = await ctx.lazy(['wait', taskId]);
    if (waited.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waited.stderr}\n${waited.stdout}`);
    }
  }

  // INVARIANT: the turn is billed to the identity the TOKEN proved. A service
  // credential being configured must not change that by a penny — the whole
  // point is that a member's usage is theirs and is visible as theirs.
  test("a turn launched on a user token binds that user's own credential", async () => {
    const taskId = await createTask(ctx, 'Billing attribution task', 'Some work');
    await runOneTurn(taskId);

    // Team mode: this project now runs on per-user credentials, and it has a
    // service credential too — the thing a fallback would silently reach for.
    await putCredential(SERVICE_CREDENTIAL_USER_ID);
    await putCredential('ada@example.com');

    const userToken = await mintUserToken('ada@example.com', 'Ada');
    await rpc(userToken, 'unblockTask', { taskId, message: 'Please also handle the empty case' });

    const bindings = await readBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].ownerUserId).toBe('ada@example.com');
    expect(bindings[0].ownerUserId).not.toBe(SERVICE_CREDENTIAL_USER_ID);
    // Live for the duration of the turn: this is the placeholder the container
    // was launched with, and the proxy swaps it for Ada's real token.
    expect(bindings[0].revokedAt).toBeNull();
  });

  // The other half of the same claim: attribution comes from the token, not
  // from "a turn happened". A control-token caller is the daemon's own control
  // plane, has no person behind it, and runs on the project's service account.
  test('a turn launched on the control token runs on the service credential', async () => {
    const taskId = await createTask(ctx, 'System-initiated task', 'Some work');
    await putCredential(SERVICE_CREDENTIAL_USER_ID);
    await putCredential('ada@example.com');

    // `lazy start` authenticates with the shared token — i.e. as control.
    await runOneTurn(taskId);

    const bindings = await readBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].ownerUserId).toBe(SERVICE_CREDENTIAL_USER_ID);
  });

  // INVARIANT: NO SILENT FALLBACK. A member with no credential of their own is
  // REFUSED — never quietly billed to the service account or to anyone else —
  // and the refusal carries the marker the control plane matches on to turn it
  // into "connect your Claude account" rather than a stack trace. That string
  // is a wire contract with lazy-teams (see NO_OWNER_CREDENTIAL_MARKER).
  test('a user with no stored credential is refused, and their words are kept', async () => {
    const taskId = await createTask(ctx, 'Uncredentialed member task', 'Some work');
    await runOneTurn(taskId);

    // A colleague has connected an account (which is what puts this project on
    // per-user credentials at all), and a service credential exists too — so a
    // fallback would have two places to go. It goes to neither.
    await putCredential('ada@example.com');
    await putCredential(SERVICE_CREDENTIAL_USER_ID);
    const userToken = await mintUserToken('nemo@example.com', 'Nemo');

    const refused = await rpcStatus(userToken, 'unblockTask', { taskId, message: 'Carry on please' });
    expect(refused.status).toBe(400);
    expect(refused.message).toContain(NO_OWNER_CREDENTIAL_MARKER);
    expect(refused.message).toContain('nemo@example.com');

    // Nothing was bound: the refusal is the whole outcome.
    expect(await readBindings()).toHaveLength(0);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    // INVARIANT (root CLAUDE.md's first): a refusal never costs the human what
    // they typed. The feedback turn is written before the credential decision.
    const kept = readTurns(ctx.root, taskId)
      .find(t => t.role === 'human' && String(t.content).includes('Carry on please'));
    expect(kept).toBeDefined();
  });

  // INVARIANT: the review surface bills the same way every other turn-launching
  // command does. This is not a second mechanism — it is the SAME one, and the
  // reason it needs its own test is that the review commands are named
  // differently (`reviewUnblock`, not `unblockTask`) and were therefore invisible
  // to the list of commands that record a turn's owner. A member unblocking from
  // the web review UI — which is how a Teams member actually works — silently
  // took the system-initiated branch and spent the project's service account.
  test('a turn launched from the review surface is billed to the user who asked for it', async () => {
    const taskId = await createTask(ctx, 'Review-surface billing task', 'Some work');
    await runOneTurn(taskId);

    await putCredential(SERVICE_CREDENTIAL_USER_ID);
    await putCredential('ada@example.com');
    const userToken = await mintUserToken('ada@example.com', 'Ada');

    await rpc(userToken, 'reviewUnblock', { taskId, message: 'Please also handle the empty case' });

    const bindings = await readBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].ownerUserId).toBe('ada@example.com');
    expect(bindings[0].ownerUserId).not.toBe(SERVICE_CREDENTIAL_USER_ID);
  });

  // INVARIANT: the acceptance gate bills NOBODY. Its predecessor, the
  // pre-accept AGENT turn, was a full agent turn on a real Anthropic account,
  // and this test used to pin that it was billed to the member who accepted —
  // the mechanical gate (no agent, plain shell commands in a mechanical
  // container) removed the billing, not the attribution. A gate that resolved a
  // credential binding would be attributing an Anthropic request that never
  // happens, and would also make accept REQUIRE a stored credential for a step
  // that costs nothing.
  test('the acceptance gate of an accept records no credential binding', async () => {
    const taskId = await createTask(ctx, 'Pre-accept billing task', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Something to merge, and a gate to run before merging it.
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
    expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(
      configPath,
      `${readFileSync(configPath, 'utf-8')}\n[automation.pre_accept]\nenabled = true\ncommands = ["true"]\ntimeout = 60\n`,
    );
    // Fixture setup, not the subject (see test/helpers/final.ts).
    await seedFinal(ctx, taskId);

    await putCredential(SERVICE_CREDENTIAL_USER_ID);
    await putCredential('ada@example.com');
    const userToken = await mintUserToken('ada@example.com', 'Ada');

    await rpc(userToken, 'acceptTask', { taskId });

    // The gate ran (the accept merged), and no credential was bound for it: no
    // agent turn launched, so there is nothing to attribute to u-ada — and
    // accept did not require her credential to get here.
    const bindings = await readBindings();
    expect(bindings).toHaveLength(0);
  });

  // INVARIANT: a recorded turn owner belongs to the turn it was recorded for and
  // to no other. The owner is remembered when the daemon ACCEPTS a turn-launching
  // RPC, before it knows whether a turn will actually start; when the command then
  // refuses, no turn was launched and nothing is owed to that user. Leaving the
  // record behind billed the NEXT turn on that task to them — including a turn the
  // daemon started by itself, which is exactly the attribution this feature exists
  // to prevent. Only `working` tasks are reconciled, so a task whose turn never
  // started was never swept.
  //
  // The next turn here is one NOBODY asked for — the reconciler auto-resuming a
  // crashed task — because that is the only kind of turn that proves the refused
  // record was cleared. A turn somebody else asks for overwrites the pending
  // record with their own, so it would pass with the clear deleted.
  test('a turn-launching RPC that refuses leaves no owner behind for the next turn', async () => {
    // Fixtures on the control token before managed mode is armed: a task with a
    // live session, whose first turn ran before any credential existed and so
    // bound none.
    const taskId = await createTask(ctx, 'Refused-owner task', 'Some work');
    await runOneTurn(taskId);
    expect(await readBindings()).toHaveLength(0);

    await putCredential(SERVICE_CREDENTIAL_USER_ID);
    await putCredential('ada@example.com');
    const adaToken = await mintUserToken('ada@example.com', 'Ada');

    // Refused: the task has already been started, so start cannot launch
    // anything — but the daemon recorded Ada as the owner before it knew that.
    const refused = await rpcStatus(adaToken, 'startTask', { taskId });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await readBindings()).toHaveLength(0);

    // Crash the task mid-turn: `working`, with no response to settle and a
    // container that is not there, its last interaction backdated past the
    // reconciler's grace period so one tick finds it (the same recipe as
    // system-identity-attribution.test.ts). The daemon's own reconciler
    // resumes it — nobody asked.
    const session = readSessionJson(ctx.root, taskId);
    if (!session) throw new Error('task has no session to crash');
    session.last_interaction_at = new Date(Date.now() - 120_000).toISOString();
    session.container_name = 'lazy-container-that-is-gone';
    writeSessionJson(ctx.root, taskId, session);
    setTaskStatus(ctx.root, taskId, 'working');
    consumeResponse(getProtocolDir(findFullTaskId(ctx.root, taskId)));

    const bindings = await waitForBindings(1);
    // Ada's refused call left nothing behind: the turn nobody asked for is paid
    // for by the service credential, not by the last person who knocked.
    expect(bindings).toHaveLength(1);
    expect(bindings[0].ownerUserId).toBe(SERVICE_CREDENTIAL_USER_ID);
    expect(bindings[0].ownerUserId).not.toBe('ada@example.com');
  }, 45000);

  // INVARIANT: a sync that merges cleanly on the host launched no turn, so it
  // leaves no owner behind for the next one. That is the ORDINARY sync outcome
  // whenever the parent moved without conflicts — no agent, no supervisor — and
  // the record it used to leave billed the member who pressed Sync for whatever
  // turn the task ran next, including one the daemon started by itself.
  //
  // As above, the next turn is one NOBODY asked for, the only kind that proves
  // the record is gone.
  test('a sync that merges cleanly leaves no owner behind for the next turn', async () => {
    const taskId = await createTask(ctx, 'Clean-sync owner task', 'Some work');
    await runOneTurn(taskId);

    // The parent moves, without touching anything the task touched: the sync
    // below merges on the host and launches nothing.
    const base = ctx.git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    writeFileSync(join(ctx.root, 'upstream-only.txt'), 'moved on the parent\n');
    expect(ctx.git('add', 'upstream-only.txt').exitCode).toBe(0);
    expect(ctx.git('commit', '-m', `Move ${base}`).exitCode).toBe(0);

    await putCredential(SERVICE_CREDENTIAL_USER_ID);
    await putCredential('ada@example.com');
    const adaToken = await mintUserToken('ada@example.com', 'Ada');

    const synced = await rpc(adaToken, 'syncTask', { taskId }) as { status: string };
    expect(synced.status).toBe('merged');
    expect(await readBindings()).toHaveLength(0);

    // INVARIANT: a clean host sync records its merge commit, and only that —
    // first-parent, so the parent's own commit is never claimed as this task's.
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    const mergeSha = ctx.git('-C', worktree, 'rev-parse', 'HEAD').stdout.trim();
    const upstreamSha = ctx.git('rev-parse', 'HEAD').stdout.trim();
    const recorded = (JSON.parse(readFileSync(taskFilePath(ctx.root, taskId, 'commits.json'), 'utf-8')).commits as Array<{ sha: string }>)
      .map(c => c.sha);
    expect(recorded).toContain(mergeSha);
    expect(recorded).not.toContain(upstreamSha);

    // Crash the task mid-turn, exactly as in the refusal test above; the
    // reconciler resumes it by itself.
    //
    // INVARIANT: the host merge commit is recorded by the sync itself, so this
    // crash is an ordinary interruption and resumes. It used to stay unrecorded,
    // and an unrecorded commit made the crashed task look like a finished turn
    // whose finalize was lost — parked `blocked` as "[Recovered]" work nobody did.
    const session = readSessionJson(ctx.root, taskId);
    if (!session) throw new Error('task has no session to crash');
    session.last_interaction_at = new Date(Date.now() - 120_000).toISOString();
    session.container_name = 'lazy-container-that-is-gone';
    writeSessionJson(ctx.root, taskId, session);
    setTaskStatus(ctx.root, taskId, 'working');
    consumeResponse(getProtocolDir(findFullTaskId(ctx.root, taskId)));

    const bindings = await waitForBindings(1);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].ownerUserId).toBe(SERVICE_CREDENTIAL_USER_ID);
    expect(bindings[0].ownerUserId).not.toBe('ada@example.com');
  }, 45000);

  /** Poll the on-disk bindings until there are `count` of them, or time out. */
  async function waitForBindings(count: number, timeoutMs = 30_000): Promise<Awaited<ReturnType<typeof readBindings>>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const bindings = await readBindings();
      if (bindings.length >= count || Date.now() > deadline) return bindings;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  /**
   * Mint a builder MCP token the way production does — over the wire, via the
   * RPC that writes a daemon MCP config — and read the secret back out of the
   * config file. Deliberately NOT minted in-process: that would test a token
   * this suite made up rather than one the daemon issued.
   */
  async function mintBuilderMcpToken(): Promise<string> {
    const { configPath } = await rpc(sharedToken, 'getDaemonMcpConfig', { name: 'builder-actor-token-test' }) as
      { configPath: string };
    const config = JSON.parse(await readFile(configPath, 'utf-8')) as { token: string };
    expect(typeof config.token).toBe('string');
    return config.token;
  }
});
