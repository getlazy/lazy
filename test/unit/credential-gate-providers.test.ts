/**
 * Unit tests: the PROVIDER-AWARE daemon credential gate, and the startup
 * hydration that lets a stored credential satisfy it.
 *
 * Two behaviours this file pins down, both of which used to be broken:
 *
 *  1. The gate asked "is an Anthropic env var set?" — a question that has
 *     nothing to do with what the project's roles will actually call. A project
 *     whose builder AND agent both point at an ollama backend was refused for an
 *     Anthropic token no role would ever use. The gate now derives the required
 *     PROVIDERS from the effective role targets and asks for exactly those.
 *
 *  2. The gate only ever looked at the environment, so the daemon's ability to
 *     start depended on which shell started it. `lazy upgrade` restarts the
 *     daemon from whatever shell ran the upgrade, and that shell routinely has
 *     no token exported — so the upgrade aborted. Startup hydration loads a
 *     STORED credential into the process env before the gate runs, so a machine
 *     with a stored credential starts from any shell.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { checkDaemonCredentials } from '../../src/daemon/credential-gate';
import { getCredentialIndexPath, getCredentialsPath } from '../../src/daemon/paths';
import { assertStoredCredentialsReachedEnv, hydrateCredentialEnv } from '../../src/credentials/hydrate';
import { resolveCredential, setCredential } from '../../src/credentials/store';
import { forgetHydratedEnvValues } from '../../src/credentials/hydrated-env';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

describe('provider-aware credential gate', () => {
  let projectRoot: string;
  let baseDir: string;
  let undoBaseDir: () => void;

  const SAVED = {
    oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    apiKey: process.env.ANTHROPIC_API_KEY,
    lazyTest: process.env.LAZY_TEST,
    lazyConfig: process.env.LAZY_CONFIG,
  };

  /** Write the project's lazy.toml and point loadConfig at it. */
  async function writeConfig(toml: string): Promise<void> {
    const configPath = join(projectRoot, 'lazy.toml');
    await writeFile(configPath, toml);
    process.env.LAZY_CONFIG = configPath;
  }

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-gate-providers-'));
    baseDir = await mkdtemp(join(tmpdir(), 'lazy-gate-daemon-'));
    undoBaseDir = pinDaemonBaseDir(baseDir);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LAZY_TEST;
    // The file backend, so the suite behaves identically on a Mac with a
    // keychain and in a container with no secret service at all.
    await writeConfig('[credentials]\nbackend = "file"\n');
  });

  afterEach(async () => {
    undoBaseDir();
    for (const [key, value] of [
      ['CLAUDE_CODE_OAUTH_TOKEN', SAVED.oauth],
      ['ANTHROPIC_API_KEY', SAVED.apiKey],
      ['LAZY_TEST', SAVED.lazyTest],
      ['LAZY_CONFIG', SAVED.lazyConfig],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(projectRoot, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  // THE HEADLINE FIX: per-role local targets were invisible to the old gate,
  // which read env presence and nothing else. An all-local project was refused
  // for a credential none of its roles would ever present.
  //
  // The SPELLING of "this role runs against a local server" changed with agent
  // profiles (a role names a profile; the profile carries the endpoint). The
  // behaviour pinned here did not, and must not.
  test('an all-ollama per-role project needs no credential at all', async () => {
    await writeConfig(
      '[credentials]\nbackend = "file"\n\n' +
      '[agents.local]\nharness = "claude-code"\nmodel = "qwen"\n' +
      'endpoint = "http://localhost:11434"\n\n' +
      '[models.roles.builder]\nagent = "local"\n\n' +
      '[models.roles.agent]\nagent = "local"\n',
    );
    expect(await checkDaemonCredentials(projectRoot)).toBeNull();
  });

  // ...and the opposite miss must not appear. Widening the gate to "skip
  // whenever any role is local" would let a MIXED project start with no way to
  // authenticate the role that really does call Anthropic.
  test('a mixed project is still refused for the anthropic role', async () => {
    await writeConfig(
      '[credentials]\nbackend = "file"\n\n' +
      '[agents.local]\nharness = "claude-code"\nmodel = "qwen"\n' +
      'endpoint = "http://localhost:11434"\n\n' +
      '[models.roles.builder]\nagent = "local"\n\n' +
      '[models.roles.agent]\nagent = "claude-code"\n',
    );
    const message = await checkDaemonCredentials(projectRoot);
    expect(message).toContain('Daemon refuses to start');
    expect(message).toContain('Anthropic');
    // The refusal must be ACTIONABLE: it names the command that fixes it and
    // the env vars that would also satisfy it.
    expect(message).toContain('lazy auth set anthropic');
    expect(message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  // WAS: "the legacy [ollama] enabled flag still skips the gate" — the global
  // flag was a role-wide alias for an Ollama backend, and this file pinned that
  // it kept satisfying the gate.
  //
  // Agent profiles REMOVE that flag (an upstream is a property of a named
  // profile now), so the old assertion cannot be kept: it asserts a config key
  // that no longer exists. It is replaced, not dropped, because the risk it
  // guarded is still real and is now the opposite one — a project that still
  // carries the flag must not be silently reinterpreted into some default. The
  // gate's job here is to surface the config refusal, actionably.
  test('a config still carrying the removed [ollama] flag is refused, loudly', async () => {
    await writeConfig('[ollama]\nenabled = true\nmodel = "qwen"\n');
    await expect(checkDaemonCredentials(projectRoot)).rejects.toThrow(
      /\[ollama\] section — it has been removed[\s\S]*\[agents\.local-ollama\][\s\S]*lazy doctor --fix agents/,
    );
  });

  // MIGRATION INVARIANT: the environment alone still satisfies the gate, so
  // every pre-store setup starts exactly as it did before.
  test('an environment credential alone still satisfies the gate', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    expect(await checkDaemonCredentials(projectRoot)).toBeNull();
  });

  // THE ACCEPTANCE CASE (unit half): a stored credential satisfies the gate with
  // a completely empty environment. This is what makes `lazy upgrade` — which
  // restarts the daemon from whatever shell ran it — stop aborting.
  test('a STORED credential satisfies the gate with an empty environment', async () => {
    expect(await checkDaemonCredentials(projectRoot)).toContain('Daemon refuses to start');
    await setCredential(projectRoot, {
      provider: 'anthropic',
      kind: 'oauth',
      secret: 'stored-oauth-token-value',
    });
    expect(await checkDaemonCredentials(projectRoot)).toBeNull();
  });

  // INVARIANT: a blank env var is ABSENT, not present — the shape a failed
  // `export FOO=$(claude setup-token)` leaves behind. A presence-only check
  // waved it through and produced a running-but-useless daemon.
  test('a blank environment variable does not satisfy the gate', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = '   ';
    expect(await checkDaemonCredentials(projectRoot)).toContain('Daemon refuses to start');
  });
});

/** Both roles on a profile that bills OpenAI, so hydration reads that credential. */
const OPENAI_ROLES =
  '[credentials]\nbackend = "file"\n\n' +
  '[agents.gpt]\nharness = "codex"\nmodel = "gpt-5-codex"\n\n' +
  '[models.roles.builder]\nagent = "gpt"\n\n' +
  '[models.roles.agent]\nagent = "gpt"\n';

describe('startup credential hydration', () => {
  let projectRoot: string;
  let baseDir: string;
  let undoBaseDir: () => void;
  const SAVED_CONFIG = process.env.LAZY_CONFIG;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-hydrate-'));
    baseDir = await mkdtemp(join(tmpdir(), 'lazy-hydrate-daemon-'));
    undoBaseDir = pinDaemonBaseDir(baseDir);
    const configPath = join(projectRoot, 'lazy.toml');
    await writeFile(configPath, '[credentials]\nbackend = "file"\n');
    process.env.LAZY_CONFIG = configPath;
  });

  afterEach(async () => {
    undoBaseDir();
    forgetHydratedEnvValues();
    if (SAVED_CONFIG === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = SAVED_CONFIG;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  test('loads a stored credential into the env var its kind maps to', async () => {
    await setCredential(projectRoot, {
      provider: 'anthropic',
      kind: 'oauth',
      secret: 'stored-oauth-token-value',
    });
    const env: NodeJS.ProcessEnv = {};
    const hydrated = await hydrateCredentialEnv(projectRoot, env);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('stored-oauth-token-value');
    expect(hydrated).toEqual([
      { provider: 'anthropic', envVar: 'CLAUDE_CODE_OAUTH_TOKEN', backend: 'file' },
    ]);
  });

  test('an api-key credential lands in ANTHROPIC_API_KEY instead', async () => {
    await setCredential(projectRoot, {
      provider: 'anthropic',
      kind: 'api-key',
      secret: 'sk-ant-stored-key-value',
    });
    const env: NodeJS.ProcessEnv = {};
    await hydrateCredentialEnv(projectRoot, env);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-stored-key-value');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  // MIGRATION INVARIANT: env WINS. A user who exports a token deliberately —
  // to test a different account, say — must not have it silently replaced by
  // whatever is in the store.
  test('never overwrites a credential the environment already carries', async () => {
    await setCredential(projectRoot, {
      provider: 'anthropic',
      kind: 'oauth',
      secret: 'stored-oauth-token-value',
    });
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'from-the-shell' };
    const hydrated = await hydrateCredentialEnv(projectRoot, env);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('from-the-shell');
    expect(hydrated).toEqual([]);
  });

  // INVARIANT: hydration's copies are marked, so they do not become a shadow of
  // the store they came from. A daemon that started with a credential stored
  // used to serve that startup copy for its whole life — `lazy auth set` wrote
  // the new key and every turn went on failing against the old one, with
  // nothing saying why. This is the whole loop: hydrate, rotate, resolve.
  //
  // On OPENAI, not Anthropic: the Anthropic credential is deliberately exempt,
  // because a running daemon serves it from its own environment (getAuthEnvVars)
  // and a restart really is the way in — see the store's envCredentialFor.
  test('a credential stored after hydration is the one that resolves', async () => {
    await writeFile(join(projectRoot, 'lazy.toml'), OPENAI_ROLES);
    await setCredential(projectRoot, {
      provider: 'openai',
      kind: 'api-key',
      secret: 'sk-stored-openai-value',
    });
    const env: NodeJS.ProcessEnv = {};
    await hydrateCredentialEnv(projectRoot, env);
    expect(env.OPENAI_API_KEY).toBe('sk-stored-openai-value');

    await setCredential(projectRoot, {
      provider: 'openai',
      kind: 'api-key',
      secret: 'sk-rotated-openai-value',
    });

    const resolved = await resolveCredential(projectRoot, 'openai', env);
    expect(resolved?.source).toBe('store');
    expect(resolved?.value).toBe('sk-rotated-openai-value');
  });

  // ...and the exemption itself: hydration marks the Anthropic copy like any
  // other, but resolution keeps calling it the environment, because that is
  // where every request is genuinely served from until the daemon restarts.
  // A report saying "store" here would name the NEW entry's kind and backend
  // while the daemon billed the old credential.
  test('the Anthropic copy still resolves as the environment after a rotation', async () => {
    await setCredential(projectRoot, {
      provider: 'anthropic',
      kind: 'oauth',
      secret: 'stored-oauth-token-value',
    });
    const env: NodeJS.ProcessEnv = {};
    await hydrateCredentialEnv(projectRoot, env);

    await setCredential(projectRoot, {
      provider: 'anthropic',
      kind: 'oauth',
      secret: 'rotated-oauth-token-value',
    });

    const resolved = await resolveCredential(projectRoot, 'anthropic', env);
    expect(resolved?.source).toBe('env');
    expect(resolved?.value).toBe('stored-oauth-token-value');
  });

  // ...but a BLANK export is not a credential, so it must not block hydration.
  test('a blank environment variable is replaced by the stored credential', async () => {
    await setCredential(projectRoot, {
      provider: 'anthropic',
      kind: 'oauth',
      secret: 'stored-oauth-token-value',
    });
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: '  ' };
    await hydrateCredentialEnv(projectRoot, env);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('stored-oauth-token-value');
  });

  test('is a no-op when nothing is stored', async () => {
    const env: NodeJS.ProcessEnv = {};
    expect(await hydrateCredentialEnv(projectRoot, env)).toEqual([]);
    expect(Object.keys(env)).toEqual([]);
  });

  // An all-local project requires no provider, so hydration has nothing to read
  // — and in particular never opens a keychain item it does not need.
  test('reads nothing for an all-ollama project', async () => {
    const configPath = join(projectRoot, 'lazy.toml');
    await writeFile(
      configPath,
      '[credentials]\nbackend = "file"\n\n' +
      '[agents.local]\nharness = "claude-code"\nmodel = "qwen"\n' +
      'endpoint = "http://localhost:11434"\n\n' +
      '[models.roles.builder]\nagent = "local"\n\n' +
      '[models.roles.agent]\nagent = "local"\n',
    );
    await setCredential(projectRoot, {
      provider: 'anthropic',
      kind: 'oauth',
      secret: 'stored-oauth-token-value',
    });
    const env: NodeJS.ProcessEnv = {};
    expect(await hydrateCredentialEnv(projectRoot, env)).toEqual([]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  // INVARIANT: a store that promised a credential and did not deliver one is
  // FATAL to startup, not a logged warning.
  //
  // The gate cannot catch this by itself and never will: it answers from the
  // non-secret index precisely so it never opens a backend (a detached
  // auto-start must not block on a keychain unlock). So when the index and the
  // backend disagree, hydration throws and the gate — reading that same index —
  // says "stored, fine". Without the check below the daemon comes up with an
  // empty environment and 401s on every model request, which is the exact
  // failure the store's own header says the design exists to prevent.
  describe('the store\'s promise must be kept', () => {
    /** Store a credential, then make the backend forget it behind the index's back. */
    async function breakTheBackend(): Promise<void> {
      await setCredential(projectRoot, {
        provider: 'anthropic',
        kind: 'oauth',
        secret: 'stored-oauth-token-value',
      });
      // What a restored home directory, or a keychain someone edited by hand,
      // leaves behind: the index entry survives, the secret does not.
      await rm(getCredentialsPath(projectRoot), { force: true });
    }

    test('hydration throws when the index and the backend disagree', async () => {
      await breakTheBackend();
      const env: NodeJS.ProcessEnv = {};
      await expect(hydrateCredentialEnv(projectRoot, env)).rejects.toThrow(
        /credential index says .* but the backend did not return one/is,
      );
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    // The gate, on its own, is fooled — this is not a bug in the gate, it is
    // why the check below has to exist. Pinned so nobody "fixes" the gate by
    // making it open a backend.
    test('the gate alone still passes, because it only reads the index', async () => {
      await breakTheBackend();
      expect(await checkDaemonCredentials(projectRoot)).toBeNull();
    });

    test('the check refuses, and carries the hydration error as the reason', async () => {
      await breakTheBackend();
      const env: NodeJS.ProcessEnv = {};
      let hydrationError: unknown;
      try {
        await hydrateCredentialEnv(projectRoot, env);
      } catch (err) {
        hydrationError = err;
      }

      const failure = await assertStoredCredentialsReachedEnv(projectRoot, hydrationError, env)
        .then(() => null, (err: Error) => err);

      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).toContain('Refusing to start');
      // The WHY, not just the what — this is the only place the underlying
      // backend disagreement is stated.
      expect(failure!.message).toContain('the backend did not return one');
      expect(failure!.message).toContain('lazy auth set anthropic');
    });

    // A stored credential that DID reach the environment is the normal path and
    // must not be refused.
    test('a healthy store passes the check', async () => {
      await setCredential(projectRoot, {
        provider: 'anthropic',
        kind: 'oauth',
        secret: 'stored-oauth-token-value',
      });
      const env: NodeJS.ProcessEnv = {};
      await hydrateCredentialEnv(projectRoot, env);
      expect(await assertStoredCredentialsReachedEnv(projectRoot, undefined, env)).toBeUndefined();
    });

    // Nothing stored at all is the GATE's business, not this check's: it is a
    // different failure with a different message, and duplicating it here would
    // refuse before the gate could explain how to fix it.
    test('an empty store is not this check\'s failure', async () => {
      expect(await assertStoredCredentialsReachedEnv(projectRoot, undefined, {})).toBeUndefined();
    });

    // The non-throwing miss: hydration skips a kind it has no env var for (and
    // warns), but the index still counts it as present, so the gate would pass.
    test('refuses a stored kind that no environment variable can carry', async () => {
      await setCredential(projectRoot, {
        provider: 'anthropic',
        kind: 'oauth',
        secret: 'stored-oauth-token-value',
      });
      const indexPath = getCredentialIndexPath(projectRoot);
      const index = JSON.parse(await readFile(indexPath, 'utf-8'));
      index.credentials[0].kind = 'oauth-from-a-future-version';
      await writeFile(indexPath, JSON.stringify(index));

      const env: NodeJS.ProcessEnv = {};
      await hydrateCredentialEnv(projectRoot, env); // warns, does not throw
      await expect(assertStoredCredentialsReachedEnv(projectRoot, undefined, env)).rejects.toThrow(
        /Refusing to start/,
      );
    });

    // An all-local project requires no provider, so a broken anthropic entry is
    // not this project's problem and must not stop its daemon.
    test('ignores a broken credential for a provider this project does not need', async () => {
      await breakTheBackend();
      await writeFile(
        join(projectRoot, 'lazy.toml'),
        '[credentials]\nbackend = "file"\n\n' +
        '[agents.local]\nharness = "claude-code"\nmodel = "qwen"\n' +
        'endpoint = "http://localhost:11434"\n\n' +
        '[models.roles.builder]\nagent = "local"\n\n' +
        '[models.roles.agent]\nagent = "local"\n',
      );
      expect(await assertStoredCredentialsReachedEnv(projectRoot, undefined, {})).toBeUndefined();
    });
  });
});
