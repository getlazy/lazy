/**
 * Unit tests: the model credential is required at TURN launch, for the profile
 * the turn runs on — and nowhere earlier.
 *
 * The daemon used to refuse to START without a credential for its role-default
 * profiles, which made registering, cloning and provisioning a project depend
 * on a model credential none of them uses (and on an Anthropic one even for a
 * project whose tasks run codex or cursor). These pin where the requirement
 * lives now: `planTurnCredential` refuses a task's turn whose profile has no
 * credential, naming the profile and what it lacks; the daemon's automations
 * skip with the same reason; `lazy daemon health` reports it as a WARN.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  NO_PROFILE_CREDENTIAL_MARKER,
  getStartupCredentialProblem,
  missingCredentialNotice,
  recordStartupCredentialProblem,
  missingTurnCredentials,
  turnCredentialRefusal,
} from '../../src/daemon/credential-gate';
import {
  NO_OWNER_CREDENTIAL_MARKER,
  NO_SERVICE_CREDENTIAL_MARKER,
  turnCredentialProblem,
  TurnCredentialUnavailableError,
  assertTurnCredentialAvailable,
  planTurnCredential,
  systemTurnBlock,
} from '../../src/daemon/turn-credentials';
import { clearUserCredentialCache, putUserCredential } from '../../src/daemon/user-credentials';
import { NO_OWNER_PROFILE_CREDENTIAL_MARKER } from '../../src/daemon/member-credentials';
import { DEFAULT_OPENAI_UPSTREAM } from '../../src/utils/openai-compat';
import { buildCredentialRows } from '../../src/daemon/daemon-health-rows';
import { setCredential } from '../../src/credentials/store';
import { forgetHydratedEnvValues } from '../../src/credentials/hydrated-env';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import type { Storage } from '../../src/storage/interface';

const ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CHATGPT_AUTH', 'LAZY_CONFIG', 'LAZY_TEST'] as const;

describe('the turn credential gate', () => {
  let projectRoot: string;
  let baseDir: string;
  let undoBaseDir: () => void;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  async function writeConfig(toml: string): Promise<void> {
    const configPath = join(projectRoot, 'lazy.toml');
    await writeFile(configPath, toml);
    process.env.LAZY_CONFIG = configPath;
  }

  /** Just enough Storage for planTurnCredential: the task, and the owner record. */
  function fakeStorage(tasks: Record<string, { agent_id: string }>): Storage {
    return {
      getTask: async (id: string) => (tasks[id] ? { id, ...tasks[id] } : null),
      setSessionTurnOwner: async () => {},
      getSession: async () => null,
    } as unknown as Storage;
  }

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-turn-gate-'));
    baseDir = await mkdtemp(join(tmpdir(), 'lazy-turn-gate-daemon-'));
    undoBaseDir = pinDaemonBaseDir(baseDir);
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    clearUserCredentialCache();
    await writeConfig('[credentials]\nbackend = "file"\n');
  });

  afterEach(async () => {
    undoBaseDir();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    forgetHydratedEnvValues();
    clearUserCredentialCache();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  // INVARIANT: a refusal names the PROFILE and the credential it bills. Claude
  // is one harness of several: a codex task refused with "no Claude
  // credential" sends someone to connect an account the turn never spends.
  test('a non-Anthropic profile is refused by its own name and credential, never "Claude"', async () => {
    const refusal = await turnCredentialRefusal(projectRoot, 'codex', { perUser: false });
    expect(refusal).toStartWith(`${NO_PROFILE_CREDENTIAL_MARKER} "codex"`);
    expect(refusal).toContain('an OpenAI credential');
    expect(refusal).toContain('lazy auth set openai');
    expect(refusal).not.toMatch(/claude|anthropic/i);
  });

  test('a subscription profile names the harness and the subscription it needs', async () => {
    const refusal = await turnCredentialRefusal(projectRoot, 'codex-subscription', { perUser: false });
    expect(refusal).toContain('"codex-subscription" (codex)');
    expect(refusal).toContain('a ChatGPT subscription credential');
    expect(refusal).not.toMatch(/claude|anthropic/i);
  });

  // INVARIANT: a daemon that started with no credential picks one up at the
  // next turn once it is stored — never "restart the daemon" for the
  // missing → present transition. The Anthropic credential is read from the
  // daemon's own env, so the gate loads it there.
  test('an Anthropic credential stored after the daemon started is loaded at the next turn', async () => {
    expect(await turnCredentialRefusal(projectRoot, 'claude-code', { perUser: false }))
      .toContain('an Anthropic credential');

    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'stored-later-token' });

    expect(await turnCredentialRefusal(projectRoot, 'claude-code', { perUser: false })).toBeNull();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('stored-later-token');
  });

  // In team mode EVERY slot is paid by the turn owner's own credential for the
  // profile, which planTurnCredential checks by person; neither the daemon's env
  // nor the project's store is what pays, so their contents must not refuse the
  // turn here (nor let it through — see the per-member tests below).
  test('team mode leaves every slot to the per-member check', async () => {
    expect(await turnCredentialRefusal(projectRoot, 'claude-code', { perUser: true })).toBeNull();
    expect(await turnCredentialRefusal(projectRoot, 'codex', { perUser: true })).toBeNull();
  });

  test('a profile on a server that takes no credential is never refused', async () => {
    await writeConfig(
      '[credentials]\nbackend = "file"\n\n' +
      '[agents.local]\nharness = "claude-code"\nmodel = "qwen"\nendpoint = "http://localhost:11434"\n',
    );
    expect(await turnCredentialRefusal(projectRoot, 'local', { perUser: false })).toBeNull();
  });

  describe('planTurnCredential — the one place every launch path asks', () => {
    // INVARIANT: a task's turn with no credential for its profile is refused
    // BEFORE anything launches, and a turn never runs on nobody's credential.
    test('refuses a task turn whose profile has no credential, naming the profile', async () => {
      const storage = fakeStorage({ 't-codex': { agent_id: 'codex' } });
      const err = await planTurnCredential(projectRoot, { taskId: 't-codex', sessionId: 's', storage })
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(TurnCredentialUnavailableError);
      expect((err as Error).message).toStartWith(`${NO_PROFILE_CREDENTIAL_MARKER} "codex"`);
    });

    test('lets the turn launch once the profile has a credential', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'daemon-token';
      const storage = fakeStorage({ 't-claude': { agent_id: 'claude-code' } });
      expect(await planTurnCredential(projectRoot, { taskId: 't-claude', sessionId: 's', storage }))
        .toEqual({ mode: 'daemon-env' });
    });

    // A launch BESIDE a task (a builder, a member terminal) is paid by its
    // spender, whose own credential the team-mode branch decides — the task's
    // profile is not what that launch runs on.
    test('a spender launch is not gated on the task profile', async () => {
      const storage = fakeStorage({ 't-codex': { agent_id: 'codex' } });
      expect(await planTurnCredential(projectRoot, {
        taskId: 't-codex', sessionId: 's', storage, spender: { email: 'a@example.com' },
      })).toEqual({ mode: 'daemon-env' });
    });

    // Team mode, Anthropic profile, member with no credential: the existing
    // per-user refusal (a wire marker Lazy Teams matches) — now also naming the
    // profile the turn runs on.
    test('team mode still refuses a member with no credential, and names the profile', async () => {
      await putUserCredential(projectRoot, { userId: 'someone@example.com', kind: 'oauth', token: 'tok' });
      const { runAsTurnOwnerRequest } = await import('../../src/daemon/turn-owner');
      const storage = fakeStorage({ 't-claude': { agent_id: 'claude-code' } });
      const err = await runAsTurnOwnerRequest(
        { taskId: 't-claude', owner: { email: 'nobody@example.com', spendable: true } },
        () => planTurnCredential(projectRoot, { taskId: 't-claude', sessionId: 's', storage }),
      ).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(TurnCredentialUnavailableError);
      expect((err as Error).message).toStartWith(NO_OWNER_CREDENTIAL_MARKER);
      expect((err as Error).message).toContain('agent profile "claude-code"');
    });
  });

  // INVARIANT: in team mode a NON-Anthropic turn is paid by its owner's OWN
  // credential for that profile — per-user billing covers every profile, and
  // there is no fallback to the project's key (the OpenAI key in the daemon's
  // env below) or to the owner's Claude credential. The refusal carries the
  // per-profile wire marker Lazy Teams matches and names the profile.
  test('team mode: a codex turn is paid by the owner\'s own codex credential, never the project\'s', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-project';
    await putUserCredential(projectRoot, { userId: 'nobody@example.com', kind: 'oauth', token: 'claude-tok' });
    const { runAsTurnOwnerRequest } = await import('../../src/daemon/turn-owner');
    const storage = fakeStorage({ 't-codex': { agent_id: 'codex' } });
    const err = await runAsTurnOwnerRequest(
      { taskId: 't-codex', owner: { email: 'nobody@example.com', spendable: true } },
      () => planTurnCredential(projectRoot, { taskId: 't-codex', sessionId: 's', storage }),
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TurnCredentialUnavailableError);
    const message = (err as Error).message;
    expect(message).toStartWith(`${NO_OWNER_PROFILE_CREDENTIAL_MARKER} "codex"`);
    expect(message).toContain("user 'nobody@example.com'");
    expect(message).toContain('OpenAI credential');

    // The pre-record check says the same thing, as a 400.
    const early = await runAsTurnOwnerRequest(
      { taskId: 't-codex', owner: { email: 'nobody@example.com', spendable: true } },
      () => assertTurnCredentialAvailable(projectRoot, { taskId: 't-codex', storage }),
    ).then(() => null, (e: unknown) => e);
    expect((early as Error).message).toBe(message);

    // Once the owner connects their own key for the profile, the same turn runs.
    await putUserCredential(projectRoot, {
      userId: 'nobody@example.com', kind: 'api-key', token: 'sk-openai-nobody', profile: 'codex', endpoint: DEFAULT_OPENAI_UPSTREAM,
    });
    const plan = await runAsTurnOwnerRequest(
      { taskId: 't-codex', owner: { email: 'nobody@example.com', spendable: true } },
      () => planTurnCredential(projectRoot, { taskId: 't-codex', sessionId: 's', storage }),
    );
    expect(plan).toMatchObject({ mode: 'session', ownerUserId: 'nobody@example.com' });
  });

  // The daemon's own automations skip with the reason, instead of launching
  // into the refusal on every reconciler tick.
  test('systemTurnBlock reports the task profile\'s missing credential', async () => {
    expect(await systemTurnBlock(projectRoot)).toBeNull();
    expect(await systemTurnBlock(projectRoot, { agent_id: 'codex' })).toContain(NO_PROFILE_CREDENTIAL_MARKER);
    process.env.OPENAI_API_KEY = 'sk-openai';
    expect(await systemTurnBlock(projectRoot, { agent_id: 'codex' })).toBeNull();
  });

  describe('lazy daemon health — a WARN, never a FAIL', () => {
    test('names each profile whose turns would be refused', async () => {
      const missing = await missingTurnCredentials(projectRoot, { perUser: false });
      const rows = buildCredentialRows(missing, null, false);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe('warn');
      expect(rows[0]!.reason).toBe('no credential for profile claude-code; turns on it will be refused');
      expect(rows[0]!.remedy).toContain('lazy auth set anthropic');
    });

    test('one OK row when every configured profile has its credential', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant';
      const rows = buildCredentialRows(await missingTurnCredentials(projectRoot, { perUser: false }), null, false);
      expect(rows.map((r) => [r.id, r.state])).toEqual([['credentials:present', 'ok']]);
    });

    test('a stored credential that failed to load at startup is a WARN with the reason', () => {
      const rows = buildCredentialRows([], 'The credential store says a Anthropic credential is stored, but it could not be loaded:\n\nthe backend did not return one', false);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe('warn');
      expect(rows[0]!.remedy).toContain('the backend did not return one');
    });
  });

  // INVARIANT: health stops reporting a startup load failure once a later
  // turn loads the credential — a WARN that outlives its cause is noise.
  test('a successful load at turn time clears the startup load problem', async () => {
    recordStartupCredentialProblem('The credential store says a Anthropic credential is stored, but it could not be loaded');
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'loaded-later' });
    expect(await turnCredentialRefusal(projectRoot, 'claude-code', { perUser: false })).toBeNull();
    expect(getStartupCredentialProblem()).toBeNull();
  });

  // INVARIANT: the reconciler asks systemTurnBlock on every tick, so it answers
  // from PRESENCE (env and the non-secret index) and never opens the store's
  // backend — a detached daemon must not block on a keychain unlock there.
  test('systemTurnBlock answers from presence and loads nothing', async () => {
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'stored-not-loaded' });
    expect(await systemTurnBlock(projectRoot, { agent_id: 'claude-code' })).toBeNull();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  // INVARIANT: the CLI pre-flight, the pre-record check and the conflict-sync
  // gate share ONE set of rules (turnCredentialProblem), so the pre-flight can
  // never wave through a turn the launch then refuses — team-mode owner and
  // service checks included.
  describe('turnCredentialProblem — the rules every early check shares', () => {
    test('an --agent override is judged, not the stored profile', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant';
      const storage = fakeStorage({ t: { agent_id: 'claude-code' } });
      expect(await turnCredentialProblem(projectRoot, { taskId: 't', storage })).toBeNull();
      expect(await turnCredentialProblem(projectRoot, { taskId: 't', storage, agentId: 'codex' }))
        .toStartWith(`${NO_PROFILE_CREDENTIAL_MARKER} "codex"`);
    });

    test('team mode: an explicit owner with no credential is refused by name', async () => {
      await putUserCredential(projectRoot, { userId: 'someone@example.com', kind: 'oauth', token: 'tok' });
      const storage = fakeStorage({ t: { agent_id: 'claude-code' } });
      expect(await turnCredentialProblem(projectRoot, { taskId: 't', storage, owner: 'nobody@example.com' }))
        .toStartWith(NO_OWNER_CREDENTIAL_MARKER);
      expect(await turnCredentialProblem(projectRoot, { taskId: 't', storage, owner: 'someone@example.com' }))
        .toBeNull();
    });

    test('team mode: nobody asked and no service credential is the service refusal', async () => {
      await putUserCredential(projectRoot, { userId: 'someone@example.com', kind: 'oauth', token: 'tok' });
      const storage = fakeStorage({ t: { agent_id: 'claude-code' } });
      expect(await turnCredentialProblem(projectRoot, { taskId: 't', storage, owner: null }))
        .toStartWith(NO_SERVICE_CREDENTIAL_MARKER);
    });
  });

  // INVARIANT: `daemon restart` / `upgrade` say in ONE line which profiles the
  // new daemon will refuse turns on — a notice, never a refusal.
  test('missingCredentialNotice names the profiles in one line, or nothing', async () => {
    const notice = await missingCredentialNotice(projectRoot);
    expect(notice).toContain('claude-code (Anthropic)');
    expect(notice).toContain('turns on it will be refused');
    expect(notice!.includes('\n')).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    expect(await missingCredentialNotice(projectRoot)).toBeNull();
  });
});
