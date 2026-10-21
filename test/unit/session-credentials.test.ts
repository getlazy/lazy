/**
 * Session-bound placeholder tokens, and the turn-credential decision built on
 * them.
 *
 * The two decisions from docs/design/lazy-teams.md §3 that everything else
 * rests on are asserted here:
 *   - the placeholder's KIND mirrors the owner's stored credential kind, so it
 *     lands in the env var that makes Claude Code emit the matching shape;
 *   - an unknown (or revoked) placeholder resolves to NOTHING — there is no
 *     unattributed bucket.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { getSessionCredentialsPath } from '../../src/daemon/paths';
import {
  bindTurnCredential,
  getTaskSessionBinding,
  lookupSessionBinding,
  revokeTaskSessionBinding,
  isSessionPlaceholderToken,
  clearSessionCredentialCache,
  SESSION_TOKEN_PREFIX,
} from '../../src/daemon/session-credentials';
import {
  putUserCredential,
  clearUserCredentialCache,
  SERVICE_CREDENTIAL_USER_ID,
} from '../../src/daemon/user-credentials';
import {
  planTurnCredential,
  releaseTurnCredential,
  systemTurnBlock,
  envVarForCredentialKind,
  sessionCredentialEnvFor,
  mustRecreateForCredentialPlan,
  turnCredentialCommandEnv,
  createSessionCredentialResolver,
  TurnCredentialUnavailableError,
} from '../../src/daemon/turn-credentials';
import { runAsTurnOwnerRequest } from '../../src/daemon/turn-owner';
import { recordContainerCredentialLaunch } from '../../src/daemon/container-credential-launch';
import { closeAllStorage, initDaemonStorage } from '../../src/daemon/rpc-handlers';
import { pinConfig } from '../helpers/pin-config';

const TASK = '11111111-2222-3333-4444-555555555555';
const SESSION = 'session-1';

/**
 * Plan a turn as the request `email` sent. A turn has an owner only inside the
 * request that asked for it (src/daemon/turn-owner.ts), so that is how these
 * tests give one an owner.
 */
function planAs(
  email: string,
  root: string,
  input: { taskId: string; sessionId: string },
): ReturnType<typeof planTurnCredential> {
  return runAsTurnOwnerRequest(
    { taskId: input.taskId, owner: { email, spendable: true } },
    () => planTurnCredential(root, input),
  );
}

describe('session credentials', () => {
  let root: string;
  let base: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-sesscred-'));
    base = await mkdtemp(join(tmpdir(), 'lzd-sesscred-'));
    unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    clearSessionCredentialCache();
  });

  afterEach(async () => {
    unpin();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  test('mints a prefixed placeholder and stores it 0600 outside the repo', async () => {
    const bound = await bindTurnCredential(root, {
      taskId: TASK, sessionId: SESSION, ownerUserId: 'alice', kind: 'oauth',
    });
    expect(isSessionPlaceholderToken(bound.token)).toBe(true);
    expect(bound.token.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    expect(bound.kindChanged).toBe(true); // no prior binding

    const path = getSessionCredentialsPath(root);
    expect(path.startsWith(base)).toBe(true);
    expect(path.startsWith(root)).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  // INVARIANT: a task container is reused across turns and its env is fixed at
  // create time. Re-pointing the OWNER must therefore keep the token VALUE, or
  // every turn would need a new container.
  test('re-pointing to another owner of the same kind keeps the token value', async () => {
    const first = await bindTurnCredential(root, {
      taskId: TASK, sessionId: SESSION, ownerUserId: 'alice', kind: 'oauth',
    });
    const second = await bindTurnCredential(root, {
      taskId: TASK, sessionId: 'session-2', ownerUserId: 'bob', kind: 'oauth',
    });

    expect(second.token).toBe(first.token);
    expect(second.kindChanged).toBe(false);
    expect((await getTaskSessionBinding(root, TASK))?.ownerUserId).toBe('bob');
  });

  // INVARIANT: the KIND decides the env var name, and a running container's env
  // cannot be changed — so a kind change is the one case that costs a container.
  test('a kind change mints a new token and reports kindChanged', async () => {
    const first = await bindTurnCredential(root, {
      taskId: TASK, sessionId: SESSION, ownerUserId: 'alice', kind: 'oauth',
    });
    const second = await bindTurnCredential(root, {
      taskId: TASK, sessionId: 'session-2', ownerUserId: 'bob', kind: 'api-key',
    });

    expect(second.token).not.toBe(first.token);
    expect(second.kindChanged).toBe(true);
  });

  // INVARIANT: unknown session token ⇒ nothing resolves. The proxy turns this
  // into a 401 unconditionally.
  test('an unknown or revoked placeholder resolves to nothing', async () => {
    const bound = await bindTurnCredential(root, {
      taskId: TASK, sessionId: SESSION, ownerUserId: 'alice', kind: 'oauth',
    });
    expect(await lookupSessionBinding(root, bound.token)).not.toBeNull();
    expect(await lookupSessionBinding(root, `${SESSION_TOKEN_PREFIX}nope`)).toBeNull();
    // A real credential is not a placeholder and must never be looked up.
    expect(await lookupSessionBinding(root, 'sk-ant-api-real')).toBeNull();

    expect(await revokeTaskSessionBinding(root, TASK)).toBe(true);
    expect(await lookupSessionBinding(root, bound.token)).toBeNull();
  });

  // A revoked binding is KEPT so the next turn can reuse the token value the
  // still-running container holds. It confers no authority (asserted above).
  test('a revoked binding still remembers the token for the next turn', async () => {
    const first = await bindTurnCredential(root, {
      taskId: TASK, sessionId: SESSION, ownerUserId: 'alice', kind: 'oauth',
    });
    await revokeTaskSessionBinding(root, TASK);

    const second = await bindTurnCredential(root, {
      taskId: TASK, sessionId: 'session-2', ownerUserId: 'alice', kind: 'oauth',
    });
    expect(second.token).toBe(first.token);
    expect(second.kindChanged).toBe(false);
    expect(await lookupSessionBinding(root, first.token)).not.toBeNull();
  });
});

describe('turn credential planning', () => {
  let root: string;
  let base: string;
  let unpin: () => void;
  let unpinConfig: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-turncred-'));
    base = await mkdtemp(join(tmpdir(), 'lzd-turncred-'));
    unpin = pinDaemonBaseDir(base);
    // INVARIANT: the turn owner is recorded into THIS file's own temp store.
    // The daemon's project root is process-wide and survives closeAllStorage(),
    // so without this pin the recording went through whatever root an earlier
    // file left behind — a deleted temp dir, opened as a store under ~/.lazy.
    await closeAllStorage();
    await writeFile(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`);
    unpinConfig = pinConfig(root);
    initDaemonStorage(root);
    clearUserCredentialCache();
    clearSessionCredentialCache();
  });

  afterEach(async () => {
    await closeAllStorage();
    unpinConfig();
    unpin();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  // INVARIANT: single-user installs are untouched. With no per-user credential
  // stored, the plan is the daemon env and no placeholder is ever minted.
  test('a project with no per-user credentials plans the daemon env', async () => {
    const plan = await planTurnCredential(root, { taskId: TASK, sessionId: SESSION });
    expect(plan.mode).toBe('daemon-env');
    expect(await getTaskSessionBinding(root, TASK)).toBeNull();
    expect(await sessionCredentialEnvFor(root, TASK)).toBeNull();
    expect(await systemTurnBlock(root)).toBeNull();
  });

  // KIND MIRRORING: the env var follows the OWNER's stored credential kind.
  test('the placeholder lands in the env var mirroring the owner credential', async () => {
    await putUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'oat-alice' });
    await putUserCredential(root, { userId: 'bob', kind: 'api-key', token: 'key-bob' });

    const alicePlan = await planAs('alice', root, { taskId: TASK, sessionId: SESSION });
    expect(alicePlan.mode).toBe('session');
    expect(await sessionCredentialEnvFor(root, TASK)).toEqual([
      { key: 'CLAUDE_CODE_OAUTH_TOKEN', value: alicePlan.mode === 'session' ? alicePlan.token : '' },
    ]);

    const bobPlan = await planAs('bob', root, { taskId: TASK, sessionId: 'session-2' });
    expect(bobPlan.mode === 'session' && bobPlan.kindChanged).toBe(true);
    expect(await sessionCredentialEnvFor(root, TASK)).toEqual([
      { key: 'ANTHROPIC_API_KEY', value: bobPlan.mode === 'session' ? bobPlan.token : '' },
    ]);

    expect(envVarForCredentialKind('oauth')).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(envVarForCredentialKind('api-key')).toBe('ANTHROPIC_API_KEY');
  });

  test('a turn owned by a user with no credential is refused, not guessed', async () => {
    await putUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'oat-alice' });
    await expect(
      planAs('carol', root, { taskId: TASK, sessionId: SESSION }),
    ).rejects.toThrow(TurnCredentialUnavailableError);
  });

  // §3.2: a turn nobody initiated runs on the project service credential, and
  // when there is none the automation is disabled with a stated reason rather
  // than billed to an arbitrary member.
  test('system turns need a service credential and say so when there is none', async () => {
    await putUserCredential(root, { userId: 'alice@example.com', kind: 'oauth', token: 'oat-alice' });

    const blocked = await systemTurnBlock(root);
    expect(blocked).toContain('No service credential for automated turns');
    await expect(
      planTurnCredential(root, { taskId: TASK, sessionId: SESSION }),
    ).rejects.toThrow(TurnCredentialUnavailableError);

    await putUserCredential(root, {
      userId: SERVICE_CREDENTIAL_USER_ID, ownerEmail: 'alice@example.com', kind: 'api-key', token: 'svc-secret',
    });
    expect(await systemTurnBlock(root)).toBeNull();
    const plan = await planTurnCredential(root, { taskId: TASK, sessionId: SESSION });
    expect(plan.mode === 'session' && plan.ownerUserId).toBe('alice@example.com');
  });

  // A container launched outside any turn must not be handed the daemon's real
  // credential just because no binding exists yet.
  test('team mode never falls back to the daemon credential for an unbound task', async () => {
    await putUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'oat-alice' });
    const env = await sessionCredentialEnvFor(root, TASK);
    expect(env).not.toBeNull();
    expect(isSessionPlaceholderToken(env![0].value)).toBe(true);
    // Bound to nobody: it resolves to nothing, so every request it makes is 401.
    const resolver = createSessionCredentialResolver(root);
    expect((await resolver(env![0].value)).ok).toBe(false);
  });

  // REGRESSION (fix-resume-auth-after-restart): a solo install can retain a
  // binding on disk from before durable member mode existed, while its
  // container keeps the placeholder in its env. Reusing that container runs
  // the whole turn on a placeholder no live binding backs: 401 on the agent's
  // first request, `fatal_auth`, dead on attempt one. Two halves, both needed:
  // the env must go back to the daemon's own credential, and the container
  // holding the stale placeholder must be recreated to receive it.
  test('a leftover placeholder does not survive into a daemon-env turn', async () => {
    await bindTurnCredential(root, { taskId: TASK, sessionId: SESSION, ownerUserId: 'alice', kind: 'oauth' });
    // A stale binding cannot make a genuine solo install spend through it.
    expect(await getTaskSessionBinding(root, TASK)).not.toBeNull();

    const plan = await planTurnCredential(root, { taskId: TASK, sessionId: SESSION });
    expect(plan.mode).toBe('daemon-env');
    // The daemon's own credential, not the orphaned placeholder.
    expect(await sessionCredentialEnvFor(root, TASK)).toBeNull();
    // And the container that still holds the placeholder cannot be reused.
    expect(await mustRecreateForCredentialPlan(root, TASK, plan)).toBe(true);
  });

  // The other side of the same decision: a genuine single-user install with no
  // binding at all must keep reusing its container exactly as before.
  test('a single-user task with no binding still reuses its container', async () => {
    const plan = await planTurnCredential(root, { taskId: TASK, sessionId: SESSION });
    expect(plan.mode).toBe('daemon-env');
    expect(await mustRecreateForCredentialPlan(root, TASK, plan)).toBe(false);
  });

  // Re-binding the same owner keeps the token VALUE, so the running container's
  // env is still correct and it is reused. Only a KIND change forces a rebuild.
  test('a second turn for the same owner reuses the container', async () => {
    await putUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'oat-alice' });
    await planAs('alice', root, { taskId: TASK, sessionId: SESSION });
    const second = await planAs('alice', root, { taskId: TASK, sessionId: 'session-2' });
    expect(await mustRecreateForCredentialPlan(root, TASK, second)).toBe(false);
  });

  // INVARIANT: alternating turn owners whose credentials are of DIFFERENT kinds
  // — a member on OAuth, then someone on an API key (another member, or the
  // service credential for a turn nobody asked for), then the first member
  // again — never recreates the task's container. The
  // container keeps the task's services running while the agent works; starting
  // a turn must leave them alone (engineer, 2026-10-20). What makes it safe: each
  // command carries the turn's placeholder in the env var its kind needs, and the
  // supervisor installs it (src/supervisor/turn-credential-env.ts).
  // INVARIANT: a container launched WITHOUT a session placeholder — created under
  // solo billing before the project switched to member billing — IS recreated
  // for a session turn. The supervisor only replaces a placeholder the container
  // holds, so reusing it would leave the agent on the solo grant and the proxy
  // would refuse the turn (auth_kind_mismatch). Once relaunched holding one, the
  // container is reused again. A review container's record never stands in for
  // the work container's.
  test('a container launched under solo billing is recreated for a member turn; one holding a placeholder is not', async () => {
    await recordContainerCredentialLaunch(root, TASK, 'lazy-review-task', 'other');
    await recordContainerCredentialLaunch(root, TASK, 'lazy-task', 'other');
    await putUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'oat-alice' });

    const plan = await planAs('alice', root, { taskId: TASK, sessionId: SESSION });
    expect(plan.mode).toBe('session');
    expect(await mustRecreateForCredentialPlan(root, TASK, plan)).toBe(true);

    await recordContainerCredentialLaunch(root, TASK, 'lazy-task', 'session');
    expect(await mustRecreateForCredentialPlan(root, TASK, plan)).toBe(false);
  });

  // INVARIANT: only the work container the next turn would reuse decides. A
  // stale 'other' entry under a work-run name no longer in use (an earlier
  // container of this task) never forces a recreate — otherwise every turn
  // would recreate the container, the very bug this task removes.
  test('a stale solo-billing record under an old work-run name does not force a recreate', async () => {
    await recordContainerCredentialLaunch(root, TASK, 'lazy-old-name', 'other');
    await recordContainerCredentialLaunch(root, TASK, 'lazy-task', 'session');
    await putUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'oat-alice' });
    const plan = await planAs('alice', root, { taskId: TASK, sessionId: SESSION });
    expect(await mustRecreateForCredentialPlan(root, TASK, plan)).toBe(false);
  });

  test('alternating credential kinds reuse the container and hand each turn its own placeholder', async () => {
    await putUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'oat-alice' });
    await putUserCredential(root, { userId: 'bob', kind: 'api-key', token: 'key-bob' });

    const member = await planAs('alice', root, { taskId: TASK, sessionId: SESSION });
    const other = await planAs('bob', root, { taskId: TASK, sessionId: 'session-2' });
    const memberAgain = await planAs('alice', root, { taskId: TASK, sessionId: 'session-3' });

    for (const plan of [member, other, memberAgain]) {
      expect(plan.mode).toBe('session');
      expect(await mustRecreateForCredentialPlan(root, TASK, plan)).toBe(false);
    }
    const token = (p: typeof member) => (p.mode === 'session' ? p.token : '');
    const onSession = (harness: string) => ({ harness, credential: 'anthropic', endpoint: '' });
    expect(turnCredentialCommandEnv(other, onSession('claude-code'))).toEqual([{ key: 'ANTHROPIC_API_KEY', value: token(other) }]);
    expect(turnCredentialCommandEnv(memberAgain, onSession('claude-code'))).toEqual([{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: token(memberAgain) }]);
    // pi is handed the same placeholder; the supervisor mirrors it for pi.
    expect(turnCredentialCommandEnv(memberAgain, onSession('pi'))).toEqual([{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: token(memberAgain) }]);
    // A codex or cursor container holds no Anthropic placeholder on purpose, and
    // a command never hands it one; a solo install's daemon env carries none either.
    expect(turnCredentialCommandEnv(memberAgain, onSession('codex'))).toBeUndefined();
    expect(turnCredentialCommandEnv(memberAgain, onSession('cursor'))).toBeUndefined();
    expect(turnCredentialCommandEnv({ mode: 'daemon-env' }, onSession('claude-code'))).toBeUndefined();
  });

  // INVARIANT: the member's session placeholder rides a command ONLY to a
  // container whose launch was handed it — claude-code / pi on the primary
  // Anthropic profile (teamSessionPathTarget, the rule teamModeLaunchCreds
  // applies). A claude-code or pi profile with its own endpoint, or paid by a
  // non-Anthropic credential, is launched with a per-profile grant; writing the
  // session placeholder into its command file would hand that container a
  // credential its launch deliberately withheld.
  test('a profile off the session path never gets the session placeholder in its command', async () => {
    await putUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'oat-alice' });
    const plan = await planAs('alice', root, { taskId: TASK, sessionId: SESSION });
    expect(plan.mode).toBe('session');
    for (const harness of ['claude-code', 'pi']) {
      expect(turnCredentialCommandEnv(plan, { harness, credential: 'anthropic', endpoint: 'http://gateway.internal:8080' })).toBeUndefined();
      expect(turnCredentialCommandEnv(plan, { harness, credential: 'openrouter', endpoint: '' })).toBeUndefined();
      expect(turnCredentialCommandEnv(plan, { harness, credential: 'anthropic', endpoint: '' })).toHaveLength(1);
    }
  });

  test('the resolver maps a live placeholder to its owner and current secret', async () => {
    await putUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'oat-alice' });
    const plan = await planAs('alice', root, { taskId: TASK, sessionId: SESSION });
    const token = plan.mode === 'session' ? plan.token : '';

    const resolver = createSessionCredentialResolver(root);
    const resolved = await resolver(token);
    expect(resolved).toEqual({ ok: true, userId: 'alice', endpoint: 'builtin:anthropic', kind: 'oauth', secret: 'oat-alice' });

    // The STORED kind wins over the bind-time kind: a user who rotated to an
    // API key must produce a loud mismatch at the proxy, not a silent swap.
    await putUserCredential(root, { userId: 'alice', kind: 'api-key', token: 'key-alice' });
    const afterRotation = await resolver(token);
    expect(afterRotation).toEqual({ ok: true, userId: 'alice', endpoint: 'builtin:anthropic', kind: 'api-key', secret: 'key-alice' });

    // Turn over: the placeholder stops resolving even though the container
    // still holds it.
    await releaseTurnCredential(root, TASK);
    expect((await resolver(token)).ok).toBe(false);
  });
});
