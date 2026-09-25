/**
 * e2e: `lazy auth` — store, list and remove model-provider credentials, and the
 * acceptance case the whole credential store exists for.
 *
 * THE ACCEPTANCE CASE (observed live, repeatedly): `lazy upgrade` restarts the
 * daemon from whatever shell ran the upgrade, and that shell routinely has no
 * token exported — so the restart hit the credential gate and the upgrade
 * aborted with "Daemon refuses to start: no authentication credential found in
 * the environment." The fix is that the daemon no longer depends on its
 * launching shell: it reads the credential store. The last two tests here pin
 * that down end to end — refusal with an empty environment, then the SAME empty
 * environment succeeding once a credential is stored.
 *
 * These run the real CLI with LAZY_TEST='' (so the production daemon start path
 * really executes) and HOME pinned to a temp dir, so the developer's own daemon
 * directory and credentials are untouched.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';

describe('lazy auth', () => {
  let ctx: TestContext;
  let tmpHome: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-auth-home-'));
    // The `file` backend, explicitly: this suite must behave identically on a
    // Mac with a Keychain and in a container with no secret service at all.
    const configPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(configPath, 'utf-8');
    await writeFile(configPath, `${toml}\n[credentials]\nbackend = "file"\n`);
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(tmpHome, { recursive: true, force: true });
  });

  /** Environment with the real daemon start path live and no credential in it. */
  const emptyCredentialEnv = (extra: Record<string, string> = {}) => ({
    HOME: tmpHome,
    LAZY_TEST: '',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ...extra,
  });

  test('list reports nothing stored on a fresh project', async () => {
    const result = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('anthropic');
    expect(result.stdout).toContain('none');
  });

  test('set stores a credential read from piped stdin, and list reports it', async () => {
    const set = await ctx.lazy(['auth', 'set', 'anthropic'], {
      env: emptyCredentialEnv(),
      input: 'sk-ant-stored-secret-abcd\n',
    });
    expect(set.exitCode).toBe(0);
    // The secret itself must never be echoed back.
    expect(set.stdout).not.toContain('sk-ant-stored-secret-abcd');

    const list = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('store');
    expect(list.stdout).toContain('file');
    // Only a last-four hint, never the credential.
    expect(list.stdout).toContain('abcd');
    expect(list.stdout).not.toContain('sk-ant-stored-secret-abcd');
  });

  // SECURITY: a secret passed as an argument lands in shell history and is
  // visible in `ps` to every user on the machine. There is no way to make that
  // safe, so the form does not exist — and saying so has to include "rotate it",
  // because by the time the user reads the error the secret is already exposed.
  test('a secret passed as an argument is refused, with a rotate warning', async () => {
    const result = await ctx.lazy(['auth', 'set', 'anthropic', 'sk-ant-oops'], {
      env: emptyCredentialEnv(),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('ROTATE');
    expect(result.stderr).toContain('Nothing was stored');
  });

  // PRE-EXISTING FAILURE, fixed here rather than left red: this test asserted
  // that `lazy auth set mistral` is REFUSED, which stopped being true when named
  // credentials landed — any well-formed name is now storable and referencable
  // as `[agents.<p>] credential = "mistral"`. It was failing at this task's base
  // commit (e8470219b), unrelated to the ChatGPT work. What is still refused is a
  // name of the wrong SHAPE, and that is what it now pins.
  test('a well-formed unknown name stores as a named credential', async () => {
    const result = await ctx.lazy(['auth', 'set', 'mistral'], {
      env: emptyCredentialEnv(),
      input: 'whatever-key\n',
    });
    expect(result.exitCode).toBe(0);
    const list = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
    expect(list.stdout).toContain('mistral');
  });

  test('a malformed credential name is refused, naming the shape rule', async () => {
    const result = await ctx.lazy(['auth', 'set', 'Not A Name'], {
      env: emptyCredentialEnv(),
      input: 'whatever\n',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Invalid credential name');
  });

  // The OpenAI-compatible providers ride the same store and the same surfaces
  // as every other provider — `lazy auth` lists, sets and removes them.
  test('openai and openrouter credentials store and list like any provider', async () => {
    const fresh = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
    expect(fresh.stdout).toContain('openai');
    expect(fresh.stdout).toContain('openrouter');

    const setOpenAI = await ctx.lazy(['auth', 'set', 'openai'], {
      env: emptyCredentialEnv(),
      input: 'sk-proj-stored-openai-key-wxyz\n',
    });
    expect(setOpenAI.exitCode).toBe(0);
    expect(setOpenAI.stdout).not.toContain('sk-proj-stored-openai-key-wxyz');

    const setOpenRouter = await ctx.lazy(['auth', 'set', 'openrouter'], {
      env: emptyCredentialEnv(),
      input: 'sk-or-v1-stored-openrouter-qrst\n',
    });
    expect(setOpenRouter.exitCode).toBe(0);

    const list = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
    expect(list.exitCode).toBe(0);
    // Only last-four hints, never the credentials.
    expect(list.stdout).toContain('wxyz');
    expect(list.stdout).toContain('qrst');
    expect(list.stdout).not.toContain('sk-proj-stored-openai-key-wxyz');
    expect(list.stdout).not.toContain('sk-or-v1-stored-openrouter-qrst');

    const rm = await ctx.lazy(['auth', 'rm', 'openrouter'], { env: emptyCredentialEnv() });
    expect(rm.exitCode).toBe(0);
    expect(rm.stdout).toContain('Removed');
  });

  test('rm removes a stored credential and is honest when there was none', async () => {
    await ctx.lazy(['auth', 'set', 'anthropic'], {
      env: emptyCredentialEnv(),
      input: 'sk-ant-stored-secret-abcd\n',
    });
    const first = await ctx.lazy(['auth', 'rm', 'anthropic'], { env: emptyCredentialEnv() });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('Removed');

    const second = await ctx.lazy(['auth', 'rm', 'anthropic'], { env: emptyCredentialEnv() });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('No stored');
  });

  // MIGRATION INVARIANT: the environment always wins, so every setup that
  // exported a token before the store existed behaves exactly as it did. The
  // listing has to SAY so — a user whose stored credential is being shadowed
  // needs to see it, not discover it by debugging a 401.
  test('list says the environment is in effect and shadows the store', async () => {
    await ctx.lazy(['auth', 'set', 'anthropic'], {
      env: emptyCredentialEnv(),
      input: 'sk-ant-stored-secret-abcd\n',
    });
    const list = await ctx.lazy(['auth', 'list'], {
      env: emptyCredentialEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'from-the-shell' }),
    });
    expect(list.stdout).toContain('environment');
    expect(list.stdout).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(list.stdout).not.toContain('from-the-shell');
  });

  // INVARIANT: `lazy auth` must never be gated on having a credential — it is
  // the command that FIXES not having one. It is therefore excluded from daemon
  // auto-start; if that exclusion regresses, `auth set` starts failing with the
  // gate's own refusal and a credential-less machine has no way out.
  test('auth runs without a credential and without starting a daemon', async () => {
    const result = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('Daemon refuses to start');
  });

  describe('the daemon no longer depends on the shell that starts it', () => {
    // Baseline: with an empty environment and nothing stored, the daemon
    // refuses — this is the abort `lazy upgrade` used to die on.
    test('an empty environment with nothing stored is refused', async () => {
      const result = await ctx.lazy(['daemon', 'start', '--foreground'], {
        env: emptyCredentialEnv(),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Daemon refuses to start');
      // The refusal points at the store first, because that is the fix that
      // survives closing the terminal.
      expect(result.stderr).toContain('lazy auth set anthropic');
    });

    // THE ACCEPTANCE CASE: same empty environment, credential in the store —
    // the daemon starts. `lazy upgrade` restarts the daemon exactly this way.
    test('a stored credential lets the daemon start from a credential-less shell', async () => {
      const set = await ctx.lazy(['auth', 'set', 'anthropic'], {
        env: emptyCredentialEnv(),
        input: 'sk-ant-stored-secret-abcd\n',
      });
      expect(set.exitCode).toBe(0);

      const result = await ctx.lazy(['daemon', 'start'], { env: emptyCredentialEnv() });
      try {
        expect(result.stderr).not.toContain('Daemon refuses to start');
        expect(result.exitCode).toBe(0);
      } finally {
        await ctx.lazy(['daemon', 'stop'], { env: emptyCredentialEnv() });
      }
    });

    // INVARIANT: a store that says "stored" and delivers nothing must STOP the
    // daemon, not merely log.
    //
    // The gate cannot see this: it answers from the non-secret index — on
    // purpose, so a detached auto-start never blocks on a keychain unlock — and
    // that is the very record disagreeing with the backend. So the index says
    // "stored", the gate says "fine", and without the post-hydration check the
    // daemon comes up with an empty environment and 401s on every model
    // request, with one line in a log file nobody is watching as the only clue.
    test('a store that cannot deliver its secret stops the daemon, naming why', async () => {
      const set = await ctx.lazy(['auth', 'set', 'anthropic'], {
        env: emptyCredentialEnv(),
        input: 'sk-ant-stored-secret-abcd\n',
      });
      expect(set.exitCode).toBe(0);

      // What a restored home directory (or a hand-edited keychain) leaves
      // behind: the index entry survives, the secret does not.
      const secretsFile = await findFile(tmpHome, 'credentials.json');
      expect(secretsFile).not.toBeNull();
      await rm(secretsFile!, { force: true });

      const result = await ctx.lazy(['daemon', 'start', '--foreground'], {
        env: emptyCredentialEnv(),
      });
      try {
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('Refusing to start');
        // The WHY has to survive all the way out to the terminal — the whole
        // point is that this failure is not silent.
        expect(result.stderr).toContain('the backend did not return one');
        expect(result.stderr).toContain('lazy auth set anthropic');
      } finally {
        await ctx.lazy(['daemon', 'stop'], { env: emptyCredentialEnv() });
      }
    });
  });

  /**
   * `lazy auth import <name>` — the ChatGPT SUBSCRIPTION session, which is not a
   * string a user can paste but the file `codex login` already wrote.
   *
   * The fixtures here are the shape codex-cli 0.152.1 really reads and writes
   * (probed against the binary), so a future codex release changing that shape
   * shows up as a failure here rather than as an unexplained 401 on a live turn.
   */
  describe('import', () => {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = (p: unknown): string => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(p)}.sig`;
    const authJson = (tokens: Record<string, unknown>): string =>
      JSON.stringify({ auth_mode: 'chatgpt', tokens, last_refresh: new Date().toISOString() }, null, 2);

    const liveSession = (): string =>
      authJson({
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-e2e' } }),
        access_token: jwt({
          exp: Math.floor(Date.now() / 1000) + 3600,
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct-e2e' },
        }),
        refresh_token: 'rt-e2e-secret-value-wxyz',
        account_id: 'acct-e2e',
      });

    test('imports a codex session from a file and lists it as an oauth credential', async () => {
      const path = join(tmpHome, 'codex-auth.json');
      await writeFile(path, liveSession(), 'utf-8');

      const imported = await ctx.lazy(['auth', 'import', 'chatgpt', path], {
        env: emptyCredentialEnv(),
      });
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain('acct-e2e');
      // The session is a SECRET — the account id is fine to echo, the tokens are not.
      expect(imported.stdout).not.toContain('rt-e2e-secret-value-wxyz');

      const list = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
      expect(list.stdout).toContain('chatgpt');
      expect(list.stdout).toContain('oauth');
      expect(list.stdout).not.toContain('rt-e2e-secret-value-wxyz');
    });

    test('imports from piped stdin', async () => {
      const imported = await ctx.lazy(['auth', 'import', 'chatgpt'], {
        env: emptyCredentialEnv(),
        input: liveSession(),
      });
      expect(imported.exitCode).toBe(0);
      const list = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
      expect(list.stdout).toContain('chatgpt');
    });

    // A file in the WRONG mode must be refused where the user can still act on
    // it, naming the command that does work — not stored and left to fail as an
    // unexplained 401 on the first turn hours later.
    test('an API-key auth.json is refused, naming `lazy auth set openai`', async () => {
      const path = join(tmpHome, 'apikey-auth.json');
      await writeFile(path, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }), 'utf-8');

      const result = await ctx.lazy(['auth', 'import', 'chatgpt', path], {
        env: emptyCredentialEnv(),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('lazy auth set openai');
      expect(result.stderr).toContain('Nothing was stored');

      const list = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
      expect(list.stdout).not.toContain('sk-test');
    });

    test('a missing session file names both login forms', async () => {
      const result = await ctx.lazy(['auth', 'import', 'chatgpt', join(tmpHome, 'nope.json')], {
        env: emptyCredentialEnv(),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('codex login');
      expect(result.stderr).toContain('--device-auth');
    });

    // INVARIANT: `set` applies the same validation as `import`. Both reach the
    // same store entry, so a rule enforced on only one of them is not enforced:
    // any string could be stored, every surface would then report a configured
    // credential, and the failure would land hours later as an unexplained 401.
    test('`lazy auth set chatgpt` refuses a string that is not a session', async () => {
      const result = await ctx.lazy(['auth', 'set', 'chatgpt'], {
        env: emptyCredentialEnv(),
        input: 'sk-just-some-string\n',
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Nothing was stored');
      expect(result.stderr).toContain('lazy auth import chatgpt');

      const list = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
      expect(list.stdout).not.toContain('sk-just-some-string');
    });

    // Validated, not refused outright — piping a session from your own password
    // manager is a reasonable thing to do.
    test('`lazy auth set chatgpt` accepts a real session on stdin', async () => {
      const result = await ctx.lazy(['auth', 'set', 'chatgpt'], {
        env: emptyCredentialEnv(),
        input: `${liveSession().replace(/\s+/g, ' ')}\n`,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const list = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
      expect(list.stdout).toContain('chatgpt');
    });

    // `lazy auth refresh` exists so the renewal round trip can be exercised on
    // demand. Its failure path is the one a real user hits when the request shape
    // or the session is wrong, so it has to be legible AND non-destructive: the
    // stored credential must survive a failed check.
    test('refresh reports a failed renewal without touching the stored session', async () => {
      await ctx.lazy(['auth', 'import', 'chatgpt'], {
        env: emptyCredentialEnv(),
        input: liveSession(),
      });

      // No network in the test environment, so the renewal cannot succeed — which
      // is precisely the path being asserted.
      const refreshed = await ctx.lazy(['auth', 'refresh', 'chatgpt'], { env: emptyCredentialEnv() });
      expect(refreshed.exitCode).not.toBe(0);
      expect(refreshed.stderr).toContain('Could not renew');
      expect(refreshed.stderr).toContain('The stored credential was not changed');

      // Still present and still usable — running the check cost the user nothing.
      const list = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
      expect(list.stdout).toContain('chatgpt');
      expect(list.stdout).toContain('oauth');
    });

    // Only credentials lazy actually renews are refreshable; an API key is stored
    // and used as-is, so the verb would be meaningless there.
    test('refresh is refused for a credential lazy does not renew', async () => {
      const result = await ctx.lazy(['auth', 'refresh', 'openai'], { env: emptyCredentialEnv() });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('not a credential lazy renews');
      expect(result.stderr).toContain('lazy auth set openai');
    });

    test('refresh with nothing stored says how to set one up', async () => {
      const result = await ctx.lazy(['auth', 'refresh', 'chatgpt'], { env: emptyCredentialEnv() });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('lazy auth import chatgpt');
    });

    // INVARIANT: an agent PROFILE name resolves to the credential that profile
    // bills, and the hop is announced. `lazy auth import codex` used to store a
    // ChatGPT session under the name `codex` — a name NO profile bills — so it
    // reported success and nothing could ever read it.
    test('importing by agent profile name stores the credential that profile bills', async () => {
      const imported = await ctx.lazy(['auth', 'import', 'codex-subscription'], {
        env: emptyCredentialEnv(),
        input: liveSession(),
      });
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain('codex-subscription');
      expect(imported.stdout).toContain('chatgpt');

      // Read the index rather than the rendering: the point of the fix is WHICH
      // key holds the session, and every credential name appears in `auth list`.
      const indexFile = await findFile(tmpHome, 'credential-index.json');
      expect(indexFile).not.toBeNull();
      const index = JSON.parse(await readFile(indexFile!, 'utf-8')) as {
        credentials: Array<{ provider: string; kind: string }>;
      };
      expect(index.credentials.map(c => c.provider)).toEqual(['chatgpt']);
      expect(index.credentials[0]!.kind).toBe('oauth');
    });

    // INVARIANT: an import into a slot that bills an API key is REFUSED. Storing
    // a session there succeeds, reports a configured credential, and then 401s
    // upstream hours later with nothing naming the cause.
    test('importing into a profile that bills an API key is refused, naming the right one', async () => {
      const result = await ctx.lazy(['auth', 'import', 'codex'], {
        env: emptyCredentialEnv(),
        input: liveSession(),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Nothing was stored.');
      expect(result.stderr).toContain('lazy auth import codex-subscription');
      expect(result.stderr).toContain('lazy auth set openai');

      const list = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
      expect(list.stdout).not.toContain('rt-e2e-secret-value-wxyz');
    });

    // INVARIANT: an imported session is read from the store PER REQUEST, so it
    // needs no daemon restart — and saying otherwise costs the user every
    // running task. Only the Anthropic credential, which the daemon reads from
    // its environment, is worth a restart.
    test('import does not ask for a daemon restart; anthropic still does', async () => {
      const imported = await ctx.lazy(['auth', 'import', 'chatgpt'], {
        env: emptyCredentialEnv(),
        input: liveSession(),
      });
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain('no daemon restart is needed');
      expect(imported.stdout).not.toContain('lazy daemon restart');

      const anthropic = await ctx.lazy(['auth', 'set', 'anthropic'], {
        env: emptyCredentialEnv(),
        input: 'sk-ant-e2e-restart-advice',
      });
      expect(anthropic.exitCode).toBe(0);
      expect(anthropic.stdout).toContain('lazy daemon restart');
    });

    // INVARIANT: REPLACING a provider credential asks for no restart either.
    // The advice used to hedge — "replacing one a running daemon loaded at
    // startup? that copy wins until it restarts" — because the daemon's own
    // hydrated copy outranked the store. It no longer does, so the hedge is
    // wrong, and a wrong restart costs every running task on the machine.
    test('replacing a stored provider credential does not ask for a daemon restart', async () => {
      const first = await ctx.lazy(['auth', 'set', 'openai'], {
        env: emptyCredentialEnv(),
        input: 'sk-e2e-openai-first-value',
      });
      expect(first.exitCode).toBe(0);

      const second = await ctx.lazy(['auth', 'set', 'openai'], {
        env: emptyCredentialEnv(),
        input: 'sk-e2e-openai-second-value',
      });
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain('no daemon restart is needed');
      expect(second.stdout).not.toContain('lazy daemon restart');
    });

    test('an imported session can be removed like any credential', async () => {
      await ctx.lazy(['auth', 'import', 'chatgpt'], {
        env: emptyCredentialEnv(),
        input: liveSession(),
      });
      const removed = await ctx.lazy(['auth', 'rm', 'chatgpt'], { env: emptyCredentialEnv() });
      expect(removed.exitCode).toBe(0);
      const list = await ctx.lazy(['auth', 'list'], { env: emptyCredentialEnv() });
      expect(list.stdout).toContain('lazy auth import chatgpt');
    });

    /**
     * A credential ALREADY STORED under a profile-shaped name.
     *
     * This is the state an earlier lazy left real machines in: `lazy auth import
     * codex` stored a session under `codex`, a name nothing bills. Resolving
     * that name to the profile's credential now would strand the entry —
     * unreachable by `rm`, and `set` would overwrite the `openai` key instead.
     * So an existing store entry outranks the profile reading.
     */
    describe('a name already in the store', () => {
      /**
       * Reproduce what an earlier lazy left behind: an entry under `codex`,
       * alongside a real `openai` key. Seeded by hand because no command can
       * create it any more — which is the point.
       */
      const seedLegacyCodexEntry = async (): Promise<string> => {
        const real = await ctx.lazy(['auth', 'set', 'openai'], {
          env: emptyCredentialEnv(),
          input: 'sk-the-real-openai-key',
        });
        expect(real.exitCode).toBe(0);

        const indexFile = (await findFile(tmpHome, 'credential-index.json'))!;
        const secretsFile = (await findFile(tmpHome, 'credentials.json'))!;
        expect(indexFile).not.toBeNull();

        const index = JSON.parse(await readFile(indexFile, 'utf-8')) as {
          version: 1;
          credentials: Array<Record<string, unknown>>;
        };
        index.credentials.push({
          provider: 'codex',
          kind: 'oauth',
          backend: 'file',
          hint: 'ecov',
          updatedAt: new Date().toISOString(),
        });
        await writeFile(indexFile, JSON.stringify(index, null, 2) + '\n', 'utf-8');

        const secrets = JSON.parse(await readFile(secretsFile, 'utf-8')) as Record<string, string>;
        secrets.codex = liveSession();
        await writeFile(secretsFile, JSON.stringify(secrets, null, 2) + '\n', 'utf-8');

        return indexFile;
      };

      const storedNames = async (indexFile: string): Promise<string[]> => {
        const index = JSON.parse(await readFile(indexFile, 'utf-8')) as {
          credentials: Array<{ provider: string }>;
        };
        return index.credentials.map(c => c.provider);
      };

      // INVARIANT: an entry the user already has stays reachable by its own
      // name. Resolving `codex` to the `openai` credential the profile bills
      // would report "no stored OpenAI credential" while the entry sat there,
      // unreachable by any command.
      test('is removable by that name, not redirected to the profile credential', async () => {
        const indexFile = await seedLegacyCodexEntry();
        expect(await storedNames(indexFile)).toContain('codex');

        const removed = await ctx.lazy(['auth', 'rm', 'codex'], { env: emptyCredentialEnv() });
        expect(removed.exitCode).toBe(0);
        expect(removed.stdout).toContain('Removed');
        // No hop was announced — there was nothing to resolve.
        expect(removed.stdout).not.toContain('bills the');

        // The entry is gone and the real OpenAI key is untouched.
        expect(await storedNames(indexFile)).toEqual(['openai']);
      });

      // ...and the far worse direction: a rotation aimed at the legacy entry
      // must never land on the credential a same-named profile bills, which
      // here would replace a working OpenAI key with something else entirely.
      test('is rotated in place, never onto the credential the profile bills', async () => {
        const indexFile = await seedLegacyCodexEntry();

        const rotated = await ctx.lazy(['auth', 'set', 'codex'], {
          env: emptyCredentialEnv(),
          input: 'sk-rotated-legacy-entry',
        });
        expect(rotated.exitCode).toBe(0);
        expect(rotated.stdout).not.toContain('bills the');

        expect((await storedNames(indexFile)).sort()).toEqual(['codex', 'openai']);
        const secretsFile = (await findFile(tmpHome, 'credentials.json'))!;
        const secrets = JSON.parse(await readFile(secretsFile, 'utf-8')) as Record<string, string>;
        expect(secrets.codex).toBe('sk-rotated-legacy-entry');
        expect(secrets.openai).toBe('sk-the-real-openai-key');
      });
    });
  });
});

/** First file with this basename anywhere under `root`, or null. */
async function findFile(root: string, name: string): Promise<string | null> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) return join(entry.parentPath ?? root, entry.name);
  }
  return null;
}
