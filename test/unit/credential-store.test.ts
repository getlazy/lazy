/**
 * Unit tests: the per-project, per-provider credential store.
 *
 * Three layers, tested at their own seams:
 *  - providers: which providers a project's ROLE TARGETS actually require
 *  - backends: the argv each OS backend builds and how it reads output back
 *    (through the injectable CommandRunner — neither `security` nor
 *    `secret-tool` exists on every machine lazy is developed on, and a suite
 *    that can only run where they do is a suite nobody runs)
 *  - store: index/secret split, write-then-verify, env-beats-store precedence
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  PROVIDERS,
  isProvider,
  credentialKinds,
  envVarFor,
  envVarsFor,
  providerForTarget,
  requiredProviders,
  resolveCredentialTarget,
  credentialTakesChatGptSession,
  credentialHoldsChatGptSession,
  credentialNeedsDaemonRestart,
  credentialSetupCommand,
  namedCredentialEnvVar,
  type CredentialKind,
} from '../../src/credentials/providers';
import { isValidName, NO_CREDENTIAL } from '../../src/config/agent-profiles';
import { CREDENTIAL_NAME_RE } from '../../src/cli/commands/auth';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/config/default-target';
import {
  KeychainBackend,
  LibsecretBackend,
  FileBackend,
  resolveBackend,
  isBackendSelection,
  quoteForSecurity,
  splitForSecurityLine,
  keychainService,
  libsecretAttributes,
  type CommandRunner,
  type CredentialBackend,
  type BackendId,
} from '../../src/credentials/backends';
import {
  setCredential,
  getStoredCredential,
  deleteCredential,
  credentialPresence,
  credentialAvailable,
  resolveCredential,
  readCredentialIndex,
  credentialHint,
  purgeOrphanCredential,
  locateCredential,
} from '../../src/credentials/store';
import { forgetHydratedEnvValues, markHydratedEnvValue } from '../../src/credentials/hydrated-env';
import { getCredentialIndexPath } from '../../src/daemon/paths';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import type { ResolvedConfig } from '../../src/config/types';
import type { UserCredentialKind } from '../../src/daemon/user-credentials';

/**
 * A ResolvedConfig stub with only the fields requiredProviders reads: the
 * CREDENTIAL each role's default profile bills. Under profiles that credential
 * is what the gate keys on — the old `backend` name is gone, and "which key does
 * this role need" was always the question it was standing in for.
 */
function configWithRoles(builder: string, agent: string): ResolvedConfig {
  const target = (credential: string) => ({ ...ANTHROPIC_DEFAULT_TARGET, credential });
  return {
    models: { roles: { builder: target(builder), agent: target(agent) } },
  } as unknown as ResolvedConfig;
}

describe('providers', () => {
  test('every provider has at least one kind, and every kind an env var', () => {
    for (const provider of PROVIDERS) {
      const kinds = credentialKinds(provider);
      expect(kinds.length).toBeGreaterThan(0);
      for (const kind of kinds) {
        expect(envVarFor(provider, kind)).toBeTruthy();
      }
      expect(envVarsFor(provider).length).toBe(kinds.length);
    }
  });

  test('isProvider rejects anything not in the table', () => {
    expect(isProvider('anthropic')).toBe(true);
    expect(isProvider('openai')).toBe(true);
    expect(isProvider('openrouter')).toBe(true);
    expect(isProvider('mistral')).toBe(false);
    expect(isProvider('')).toBe(false);
  });

  // INVARIANT: `CredentialKind` here and `UserCredentialKind` in
  // src/daemon/user-credentials.ts describe the same two credential shapes
  // (bearer vs x-api-key). They are separate types because the two stores are
  // separate planes — but if one grows a kind the other has not, the proxy's
  // header mapping silently disagrees with what a user stored. This assertion
  // is what makes that a compile-time failure rather than a 401 in the field.
  test('CredentialKind mirrors UserCredentialKind', () => {
    const mirrored: CredentialKind = 'oauth' as UserCredentialKind;
    const back: UserCredentialKind = 'api-key' as CredentialKind;
    expect(mirrored).toBe('oauth');
    expect(back).toBe('api-key');
  });

  describe('providerForTarget', () => {
    // A local model authenticates with a dummy token — demanding an Anthropic
    // credential for it is precisely the refusal this task exists to remove.
    test('the `none` credential needs no provider', () => {
      expect(providerForTarget({ credential: NO_CREDENTIAL })).toBeNull();
    });

    test('a provider-named credential is the provider that must be present', () => {
      expect(providerForTarget({ credential: 'anthropic' })).toBe('anthropic');
      expect(providerForTarget({ credential: 'openrouter' })).toBe('openrouter');
    });

    // INVARIANT: a user-chosen credential name is NOT a provider, so the
    // daemon's provider-shaped startup gate has nothing to say about it. It is
    // resolved (and fails loudly, naming the profile) at launch instead —
    // gating daemon startup on a key only one profile needs would refuse a
    // daemon to every task that does not use that profile.
    test('a named credential is not a provider requirement', () => {
      expect(providerForTarget({ credential: 'work-openai' })).toBeNull();
    });
  });

  describe('requiredProviders', () => {
    // THE BUG THIS FIXES: per-role local targets were invisible to the gate,
    // which demanded an Anthropic token no role would ever use.
    test('all-local roles require nothing', () => {
      expect(requiredProviders(configWithRoles(NO_CREDENTIAL, NO_CREDENTIAL))).toEqual([]);
    });

    // ...and the opposite miss must not appear: a MIXED setup still needs the
    // Anthropic credential its Anthropic-billed role will use.
    test('a mixed setup still requires anthropic', () => {
      expect(requiredProviders(configWithRoles(NO_CREDENTIAL, 'anthropic'))).toEqual(['anthropic']);
    });

    test('the default setup requires anthropic exactly once', () => {
      expect(requiredProviders(configWithRoles('anthropic', 'anthropic'))).toEqual(['anthropic']);
    });

    test('two roles on two providers require both', () => {
      expect(requiredProviders(configWithRoles('anthropic', 'openai')).sort())
        .toEqual(['anthropic', 'openai']);
    });
  });

  /**
   * The name a user types at `lazy auth <verb> <name>`.
   *
   * lazy has two vocabularies — agent profiles and credentials — and a user has
   * every reason to expect them to be one. These tests pin which name wins where.
   */
  describe('resolveCredentialTarget', () => {
    const config = (agents?: Record<string, unknown>): ResolvedConfig =>
      ({ ...configWithRoles('anthropic', 'anthropic'), agents }) as unknown as ResolvedConfig;

    test('a provider names itself', () => {
      expect(resolveCredentialTarget(config(), 'openai')).toEqual({ credential: 'openai' });
      expect(resolveCredentialTarget(config(), 'chatgpt')).toEqual({ credential: 'chatgpt' });
    });

    // THE BUG THIS FIXES: `lazy auth import codex` stored a ChatGPT session
    // under the name `codex`, which no profile bills — accepted, reported as
    // stored, and unreadable by anything for as long as the user kept it.
    test('an agent profile resolves to the credential it bills', () => {
      expect(resolveCredentialTarget(config(), 'codex-subscription'))
        .toEqual({ credential: 'chatgpt', viaProfile: 'codex-subscription' });
      expect(resolveCredentialTarget(config(), 'codex-api'))
        .toEqual({ credential: 'openai', viaProfile: 'codex-api' });
      expect(resolveCredentialTarget(config(), 'codex'))
        .toEqual({ credential: 'openai', viaProfile: 'codex' });
      expect(resolveCredentialTarget(config(), 'claude-code'))
        .toEqual({ credential: 'anthropic', viaProfile: 'claude-code' });
    });

    // A NAMED credential in use keeps its meaning even when a profile shares its
    // spelling: the store key a user already wrote must not move under them.
    test('a name a profile bills stays itself', () => {
      const cfg = config({ codex: { harness: 'codex', credential: 'codex' } });
      expect(resolveCredentialTarget(cfg, 'codex')).toEqual({ credential: 'codex' });
    });

    /**
     * A name ALREADY IN THE STORE outranks the agent-profile reading.
     *
     * This is not hypothetical: `lazy auth import codex` stored a ChatGPT
     * session under `codex` — silently, which is the bug above — so real
     * machines hold an entry under a name that now also reads as a profile.
     * Resolving it to `openai` would strand that entry and, worse, aim a write
     * at a different credential that is probably in use.
     */
    describe('an existing store entry wins', () => {
      const stored = new Set(['codex']);

      test('rm and set reach the entry, not the credential the profile bills', () => {
        expect(resolveCredentialTarget(config(), 'codex', stored)).toEqual({ credential: 'codex' });
      });

      // Only for the name that is actually stored — every other profile name
      // still resolves, so the fix for one machine's history is not a general
      // opt-out of the feature.
      test('a different profile name still resolves', () => {
        expect(resolveCredentialTarget(config(), 'codex-subscription', stored))
          .toEqual({ credential: 'chatgpt', viaProfile: 'codex-subscription' });
      });

      // A PROVIDER name is unaffected either way: it already named itself.
      test('a provider is unchanged whether or not it is stored', () => {
        expect(resolveCredentialTarget(config(), 'openai', new Set(['openai'])))
          .toEqual({ credential: 'openai' });
      });
    });

    test('a name lazy knows nothing about is stored under that name', () => {
      expect(resolveCredentialTarget(config(), 'work-openai')).toEqual({ credential: 'work-openai' });
      expect(resolveCredentialTarget(null, 'codex-subscription')).toEqual({ credential: 'codex-subscription' });
    });

    // A profile on a local model server bills nothing, so there is no slot to
    // write — saying so beats storing a key nothing will ever present.
    test('a profile that bills no credential is refused', () => {
      const cfg = config({ local: { harness: 'codex', endpoint: 'http://localhost:11434/v1', model: 'qwen3:latest' } });
      expect(() => resolveCredentialTarget(cfg, 'local')).toThrow(/bills no credential/);
    });

    // INVARIANT: advice that names an AGENT must round-trip. A refused launch
    // prints "lazy auth import codex-subscription"; if `lazy auth` resolved that
    // name to a different slot, the user would follow the instruction exactly
    // and still be refused, with nothing to tell them why.
    test('a setup command named after an agent resolves back to the credential it bills', () => {
      const cfg = config();
      for (const name of ['codex-subscription', 'codex-api', 'claude-code']) {
        const { credential } = resolveCredentialTarget(cfg, name);
        const command = credentialSetupCommand(credential, name);
        expect(command).toBe(`auth ${credential === 'chatgpt' ? 'import' : 'set'} ${name}`);
        expect(resolveCredentialTarget(cfg, command.split(' ')[2]!).credential).toBe(credential);
      }
      // With no profile to name, the credential names itself, as it always did.
      expect(credentialSetupCommand('chatgpt')).toBe('auth import chatgpt');
      expect(credentialSetupCommand('openai')).toBe('auth set openai');
    });

    test('only a slot that holds a session accepts an imported one', () => {
      const cfg = config({
        'work-sub': { harness: 'codex', endpoint: 'https://chatgpt.com/backend-api/codex', model: 'gpt-5-codex', credential: 'work-chatgpt' },
        'work-api': { harness: 'codex', credential: 'work-openai' },
      });
      expect(credentialTakesChatGptSession(cfg, 'chatgpt')).toBe(true);
      expect(credentialTakesChatGptSession(cfg, 'work-chatgpt')).toBe(true);
      expect(credentialTakesChatGptSession(cfg, 'openai')).toBe(false);
      expect(credentialTakesChatGptSession(cfg, 'anthropic')).toBe(false);
      expect(credentialTakesChatGptSession(cfg, 'work-openai')).toBe(false);
      // Nothing bills it yet — the user's own name, stored before the profile
      // that will reference it exists.
      expect(credentialTakesChatGptSession(cfg, 'later')).toBe(true);
      // ...but `refresh` needs the stronger answer before it spends a rotation.
      expect(credentialHoldsChatGptSession(cfg, 'later')).toBe(false);
      expect(credentialHoldsChatGptSession(cfg, 'work-chatgpt')).toBe(true);
    });
  });

  // INVARIANT: only the credential the daemon reads from its own ENVIRONMENT is
  // worth a daemon restart. Saying it for the others interrupts every running
  // task to achieve nothing — everything else is resolved from the store per
  // request (the proxy) or per launch (agent credentials).
  test('anthropic is the only credential a running daemon must restart for', () => {
    expect(credentialNeedsDaemonRestart('anthropic')).toBe(true);
    for (const provider of PROVIDERS.filter(p => p !== 'anthropic')) {
      expect({ provider, restart: credentialNeedsDaemonRestart(provider) })
        .toEqual({ provider, restart: false });
    }
    expect(credentialNeedsDaemonRestart('work-openai')).toBe(false);
  });

  // INVARIANT: `lazy auth` keeps its own copy of the credential-name rule so it
  // stays usable in a project whose lazy.toml will not load — often the very
  // thing being fixed. A copy that drifted would accept a name `[agents.<name>]
  // credential` rejects (or the reverse), leaving a key stored under a name no
  // profile can reference. Duplication is the decision; divergence is the bug.
  describe('credential name rule', () => {
    const NAMES = [
      'anthropic', 'work-openai', 'a', 'a1', 'x.y_z-0', '0start',
      'a'.repeat(64), 'a'.repeat(65),
      '', '-leading', '.leading', '_leading', 'Upper', 'has space',
      'has/slash', 'has:colon', 'has$dollar', 'trailing\n', 'né',
    ];

    test('lazy auth and [agents.<name>] agree on every name', () => {
      for (const name of NAMES) {
        expect({ name, ok: CREDENTIAL_NAME_RE.test(name) })
          .toEqual({ name, ok: isValidName(name) });
      }
    });

    test('...and the rule is the one both document', () => {
      expect(isValidName('work-openai')).toBe(true);
      expect(isValidName('a'.repeat(64))).toBe(true);
      expect(isValidName('a'.repeat(65))).toBe(false);
      expect(isValidName('-leading')).toBe(false);
      expect(isValidName('Upper')).toBe(false);
    });
  });
});

describe('backends', () => {
  /** Records every command it is asked to run and replays scripted results. */
  function fakeRunner(results: Array<{ exitCode: number; stdout?: string; stderr?: string }>) {
    const calls: Array<{ cmd: string[]; stdin?: string }> = [];
    let i = 0;
    const run: CommandRunner = async (cmd, stdin) => {
      calls.push({ cmd, stdin });
      const r = results[Math.min(i, results.length - 1)] ?? { exitCode: 0 };
      i += 1;
      return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    return { run, calls };
  }

  /**
   * A stand-in for `/usr/bin/security` faithful in the ONE respect that broke:
   * how `security -i` reads and tokenizes its command lines.
   *
   * Ported from Apple's SecurityTool (`security.c`): `readline()` fills a
   * caller-supplied buffer and BREAKS at `buffer_size - 1` — 4095 bytes —
   * without consuming the rest of the line, so a longer line silently becomes
   * two commands; `split_line()` is the quote/backslash tokenizer, reproduced
   * here so a test cannot pass by quoting the way we WISH it parsed.
   *
   * Without this, the keychain path is testable only on a Mac, which is to say
   * in a suite nobody runs.
   */
  function fakeSecurity(limit = 4096) {
    const items = new Map<string, string>();
    const argvSeen: string[] = [];
    const key = (service: string, account: string): string => `${service} :: ${account}`;

    const splitLine = (line: string): string[] => {
      const args: string[] = [];
      let current = '';
      let started = false;
      let state: 'ws' | 'arg' | 'arg-esc' | 'quoted' | 'quoted-esc' = 'ws';
      let quote = '';
      for (const ch of line) {
        if (state === 'ws') {
          if (/\s/.test(ch)) continue;
          started = true;
          if (ch === '"' || ch === "'") {
            quote = ch;
            state = 'quoted';
            continue;
          }
          state = 'arg';
        }
        if (state === 'arg') {
          if (ch === '\\') { state = 'arg-esc'; continue; }
          if (/\s/.test(ch)) { args.push(current); current = ''; started = false; state = 'ws'; continue; }
          current += ch;
          continue;
        }
        if (state === 'quoted') {
          if (ch === '\\') { state = 'quoted-esc'; continue; }
          if (ch === quote) { args.push(current); current = ''; started = false; state = 'ws'; continue; }
          current += ch;
          continue;
        }
        if (state === 'arg-esc') { current += ch; state = 'arg'; continue; }
        if (state === 'quoted-esc') { current += ch; state = 'quoted'; continue; }
      }
      if (state !== 'ws' || started) args.push(current);
      return args;
    };

    /** readline()'s buffer break, byte-exact. */
    const readLines = (stdin: string): string[] => {
      const lines: string[] = [];
      let bytes: number[] = [];
      for (const byte of Buffer.from(stdin, 'utf-8')) {
        if (bytes.length === limit - 1) {
          lines.push(Buffer.from(bytes).toString('utf-8'));
          bytes = [];
        }
        if (byte === 0x0a) {
          lines.push(Buffer.from(bytes).toString('utf-8'));
          bytes = [];
          continue;
        }
        bytes.push(byte);
      }
      if (bytes.length > 0) lines.push(Buffer.from(bytes).toString('utf-8'));
      return lines;
    };

    const flag = (args: string[], name: string): string | undefined => {
      const i = args.indexOf(name);
      return i === -1 ? undefined : args[i + 1];
    };

    const run: CommandRunner = async (cmd, stdin) => {
      argvSeen.push(cmd.join(' '));
      if (cmd[1] === 'help') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd[1] === '-i') {
        let exitCode = 0;
        let stderr = '';
        for (const line of readLines(stdin ?? '')) {
          const args = splitLine(line);
          if (args.length === 0) continue;
          if (args[0] !== 'add-generic-password') {
            stderr += `security: unknown command "${args[0]}"\n`;
            exitCode = 1;
            continue;
          }
          items.set(key(flag(args, '-s') ?? '', flag(args, '-a') ?? ''), flag(args, '-w') ?? '');
          exitCode = 0;
        }
        return { exitCode, stdout: '', stderr };
      }
      const k = key(flag(cmd, '-s') ?? '', flag(cmd, '-a') ?? '');
      if (cmd[1] === 'find-generic-password') {
        const value = items.get(k);
        return value === undefined
          ? { exitCode: 44, stdout: '', stderr: 'could not be found' }
          : { exitCode: 0, stdout: `${value}\n`, stderr: '' };
      }
      if (cmd[1] === 'delete-generic-password') {
        return items.delete(k)
          ? { exitCode: 0, stdout: '', stderr: '' }
          : { exitCode: 44, stdout: '', stderr: 'could not be found' };
      }
      throw new Error(`fakeSecurity: unexpected command ${cmd.join(' ')}`);
    };

    return { run, items, argvSeen };
  }

  /** A ChatGPT-session-sized secret: compact JSON, single line, two JWT-ish blobs. */
  function bigSecret(bytes: number): string {
    const filler = (n: number): string => 'eyJhbGciOiJSUzI1NiJ9.'.repeat(Math.ceil(n / 21)).slice(0, n);
    return JSON.stringify({
      auth_mode: 'chatgpt',
      access_token: filler(Math.floor(bytes / 2)),
      refresh_token: filler(Math.floor(bytes / 2)),
      account_id: 'acct-unit',
    });
  }

  describe('keychain line limit', () => {
    // INVARIANT: a secret longer than one `security -i` command line is stored
    // in PARTS and reads back byte-identical. security's readline() breaks a
    // longer line at 4095 bytes and runs the remainder as a second command, so
    // before this a ChatGPT session either stored TRUNCATED or failed with
    // `security: unknown command "}"` — decided by how long the credential's
    // name happened to be.
    test('a secret too long for one command line round-trips through the keychain', async () => {
      const sec = fakeSecurity();
      const backend = new KeychainBackend(sec.run, 'darwin');
      const secret = bigSecret(6000);

      await backend.set('/proj', 'chatgpt', secret);
      expect(await backend.get('/proj', 'chatgpt')).toBe(secret);
      expect(sec.items.size).toBeGreaterThan(1);
    });

    // The same secret under two names must both work: the bug's signature was
    // that `codex` (5 characters) stored and `chatgpt` (7) did not.
    test('the credential name cannot decide whether the secret survives', async () => {
      const secret = bigSecret(4000);
      for (const name of ['codex', 'chatgpt', 'a-rather-long-credential-name']) {
        const sec = fakeSecurity();
        const backend = new KeychainBackend(sec.run, 'darwin');
        await backend.set('/proj', name, secret);
        expect({ name, value: await backend.get('/proj', name) }).toEqual({ name, value: secret });
      }
    });

    // SECURITY: still true when the secret spans several items — the whole
    // reason the write goes through `security -i` in the first place.
    test('no part of a multi-part secret reaches argv', async () => {
      const sec = fakeSecurity();
      const secret = bigSecret(6000);
      await new KeychainBackend(sec.run, 'darwin').set('/proj', 'chatgpt', secret);
      for (const argv of sec.argvSeen) {
        expect(argv).not.toContain('eyJhbGciOiJSUzI1NiJ9');
      }
    });

    // A shorter replacement must not read back with the previous secret's tail
    // glued on — the failure mode a naive "write part 1, leave the rest" has.
    test('replacing a long secret with a short one clears the leftover parts', async () => {
      const sec = fakeSecurity();
      const backend = new KeychainBackend(sec.run, 'darwin');
      await backend.set('/proj', 'chatgpt', bigSecret(6000));
      await backend.set('/proj', 'chatgpt', 'sk-short');
      expect(await backend.get('/proj', 'chatgpt')).toBe('sk-short');
      expect(sec.items.size).toBe(1);
    });

    // A one-item secret — every API key — must still cost exactly one lookup.
    test('an ordinary key is read with a single lookup', async () => {
      const sec = fakeSecurity();
      const backend = new KeychainBackend(sec.run, 'darwin');
      await backend.set('/proj', 'anthropic', 'sk-ant-ordinary-key');
      const before = sec.argvSeen.length;
      expect(await backend.get('/proj', 'anthropic')).toBe('sk-ant-ordinary-key');
      expect(sec.argvSeen.length - before).toBe(1);
    });

    // Removing a credential removes ALL of it. A leftover part would be a live
    // secret in the keychain that nothing mentions.
    test('remove clears every part', async () => {
      const sec = fakeSecurity();
      const backend = new KeychainBackend(sec.run, 'darwin');
      await backend.set('/proj', 'chatgpt', bigSecret(6000));
      expect(await backend.remove('/proj', 'chatgpt')).toBe(true);
      expect(sec.items.size).toBe(0);
      expect(await backend.get('/proj', 'chatgpt')).toBeNull();
    });

    /**
     * SELF-HEALING over what the pre-fix binary left behind.
     *
     * The old write stored the first 4095 bytes and then failed, so a real
     * keychain held a TRUNCATED session under `chatgpt` — which later 401'd
     * every turn with "Unterminated string". Re-importing on the fixed build has
     * to replace that completely, with no `security delete-generic-password` by
     * hand first.
     */
    test('a re-import replaces a truncated item left by the old write path', async () => {
      const sec = fakeSecurity();
      const backend = new KeychainBackend(sec.run, 'darwin');
      const good = bigSecret(6000);

      // Seed the damaged state exactly: one item, holding a cut-off prefix.
      const truncated = good.slice(0, 4000);
      sec.items.set(`${keychainService('/proj')} :: chatgpt`, truncated);

      await backend.set('/proj', 'chatgpt', good);

      expect(await backend.get('/proj', 'chatgpt')).toBe(good);
      // No fragment of the old value survives in any part.
      for (const value of sec.items.values()) {
        expect(good).toContain(value);
      }
    });

    test('splitForSecurityLine accounts for the bytes quoting adds', () => {
      // Every character escapes, so only half as many fit as the budget suggests.
      expect(splitForSecurityLine('"'.repeat(20), 16)).toEqual(['"'.repeat(8), '"'.repeat(8), '"'.repeat(4)]);
      expect(splitForSecurityLine('abcdefghijklmnopqrstuvwxyz', 16))
        .toEqual(['abcdefghijklmnop', 'qrstuvwxyz']);
      expect(splitForSecurityLine('short', 4096)).toEqual(['short']);
      // A budget too small to make progress must say so, not loop.
      expect(() => splitForSecurityLine('anything', 4)).toThrow(/too long/);
    });
  });

  test('isBackendSelection accepts auto and each backend id only', () => {
    expect(isBackendSelection('auto')).toBe(true);
    expect(isBackendSelection('keychain')).toBe(true);
    expect(isBackendSelection('libsecret')).toBe(true);
    expect(isBackendSelection('file')).toBe(true);
    expect(isBackendSelection('vault')).toBe(false);
  });

  test('the keychain service name is scoped per project', () => {
    expect(keychainService('/a/project')).not.toBe(keychainService('/b/project'));
    expect(keychainService('/a/project')).toStartWith('lazy:');
  });

  test('libsecret attributes are project- and provider-scoped', () => {
    const attrs = libsecretAttributes('/a/project', 'anthropic');
    expect(attrs).toContain('provider');
    expect(attrs).toContain('anthropic');
    expect(attrs).toContain('application');
    expect(attrs).toContain('lazy');
  });

  // SECURITY: `security -i` takes a command LINE, so a secret containing a quote
  // or a backslash would otherwise break out of the -w argument.
  test('quoteForSecurity escapes backslashes and quotes', () => {
    expect(quoteForSecurity('a"b')).toBe('"a\\"b"');
    expect(quoteForSecurity('a\\b')).toBe('"a\\\\b"');
  });

  // SECURITY: quoting cannot save a NEWLINE. `security -i` reads one command per
  // line, so a line break inside the value ends lazy's command and starts one of
  // the value's choosing — there is no escape for it, only a refusal. Both input
  // paths are single-line today, so this is a door closed before anyone tries it.
  test('quoteForSecurity refuses a value containing a line break', () => {
    expect(() => quoteForSecurity('a\nb')).toThrow(/line break/);
    expect(() => quoteForSecurity('a\rb')).toThrow(/line break/);
  });

  describe('KeychainBackend', () => {
    test('get returns the secret with the trailing newline stripped', async () => {
      const { run, calls } = fakeRunner([{ exitCode: 0, stdout: 'sk-secret\n' }]);
      const backend = new KeychainBackend(run, 'darwin');
      expect(await backend.get('/proj', 'anthropic')).toBe('sk-secret');
      expect(calls[0]!.cmd[0]).toBe('security');
      expect(calls[0]!.cmd).toContain('find-generic-password');
    });

    test('get returns null when the item is absent', async () => {
      const { run } = fakeRunner([{ exitCode: 44, stderr: 'could not be found' }]);
      expect(await new KeychainBackend(run, 'darwin').get('/proj', 'anthropic')).toBeNull();
    });

    // SECURITY: the secret must never appear in this process's argv, where any
    // user on the machine can read it out of `ps`. `security -i` reads its
    // command line from stdin, which is why the write goes through it.
    test('set passes the secret on stdin, never in argv', async () => {
      const { run, calls } = fakeRunner([{ exitCode: 0 }]);
      await new KeychainBackend(run, 'darwin').set('/proj', 'anthropic', 'sk-supersecret');
      expect(calls[0]!.cmd).toEqual(['security', '-i']);
      expect(calls[0]!.cmd.join(' ')).not.toContain('sk-supersecret');
      expect(calls[0]!.stdin).toContain('sk-supersecret');
      expect(calls[0]!.stdin).toContain('add-generic-password');
    });

    test('is unavailable off macOS without running anything', async () => {
      const { run, calls } = fakeRunner([{ exitCode: 0 }]);
      expect(await new KeychainBackend(run, 'linux').available()).toBe(false);
      expect(calls.length).toBe(0);
    });
  });

  describe('LibsecretBackend', () => {
    test('set passes the secret on stdin, never in argv', async () => {
      const { run, calls } = fakeRunner([{ exitCode: 0 }]);
      await new LibsecretBackend(run, 'linux').set('/proj', 'anthropic', 'sk-supersecret');
      expect(calls[0]!.cmd[0]).toBe('secret-tool');
      expect(calls[0]!.cmd).toContain('store');
      expect(calls[0]!.cmd.join(' ')).not.toContain('sk-supersecret');
      expect(calls[0]!.stdin).toBe('sk-supersecret');
    });

    test('get returns null for a missing item', async () => {
      const { run } = fakeRunner([{ exitCode: 1, stderr: '' }]);
      expect(await new LibsecretBackend(run, 'linux').get('/proj', 'anthropic')).toBeNull();
    });

    test('is unavailable on macOS without running anything', async () => {
      const { run, calls } = fakeRunner([{ exitCode: 0 }]);
      expect(await new LibsecretBackend(run, 'darwin').available()).toBe(false);
      expect(calls.length).toBe(0);
    });
  });

  describe('resolveBackend', () => {
    function stub(id: BackendId, available: boolean): CredentialBackend {
      return {
        id,
        available: async () => available,
        get: async () => null,
        set: async () => {},
        remove: async () => false,
      };
    }

    test('auto prefers the OS keychain over the plaintext file', async () => {
      const backends = {
        keychain: stub('keychain', true),
        libsecret: stub('libsecret', true),
        file: stub('file', true),
      };
      expect((await resolveBackend('auto', backends)).id).toBe('keychain');
    });

    test('auto falls back through libsecret to the file', async () => {
      const backends = {
        keychain: stub('keychain', false),
        libsecret: stub('libsecret', false),
        file: stub('file', true),
      };
      expect((await resolveBackend('auto', backends)).id).toBe('file');
    });

    // INVARIANT: an EXPLICIT backend choice is never silently downgraded. A user
    // who asked for the OS keychain and got a plaintext file instead would have
    // no way to notice, and would believe their token was encrypted at rest.
    test('an explicit but unavailable backend throws rather than downgrading', async () => {
      const backends = {
        keychain: stub('keychain', false),
        libsecret: stub('libsecret', false),
        file: stub('file', true),
      };
      await expect(resolveBackend('keychain', backends)).rejects.toThrow(/keychain/);
    });
  });
});

describe('store', () => {
  let projectRoot: string;
  let undoBaseDir: () => void;
  let baseDir: string;

  const SAVED = {
    oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    apiKey: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    named: process.env.LAZY_CREDENTIAL_WORK_OPENAI,
    namedOauth: process.env.LAZY_CREDENTIAL_WORK_OPENAI_OAUTH,
    config: process.env.LAZY_CONFIG,
  };

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-cred-store-'));
    baseDir = await mkdtemp(join(tmpdir(), 'lazy-cred-daemon-'));
    undoBaseDir = pinDaemonBaseDir(baseDir);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LAZY_CREDENTIAL_WORK_OPENAI;
    delete process.env.LAZY_CREDENTIAL_WORK_OPENAI_OAUTH;
    // Hermetic config: the file backend, so the suite runs identically on a Mac
    // with a keychain and in a container with neither secret service.
    const configPath = join(projectRoot, 'lazy.toml');
    await writeFile(configPath, '[credentials]\nbackend = "file"\n');
    process.env.LAZY_CONFIG = configPath;
  });

  afterEach(async () => {
    undoBaseDir();
    // Hydration marks are process-global by design (the daemon hydrates once);
    // this suite makes many, against throwaway environments.
    forgetHydratedEnvValues();
    for (const [key, value] of [
      ['CLAUDE_CODE_OAUTH_TOKEN', SAVED.oauth],
      ['ANTHROPIC_API_KEY', SAVED.apiKey],
      ['OPENAI_API_KEY', SAVED.openai],
      ['LAZY_CREDENTIAL_WORK_OPENAI', SAVED.named],
      ['LAZY_CREDENTIAL_WORK_OPENAI_OAUTH', SAVED.namedOauth],
      ['LAZY_CONFIG', SAVED.config],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(projectRoot, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  /**
   * Do exactly what daemon startup does: put the stored secret in this
   * process's environment and mark it with the index entry it came from.
   * Hand-marking without the entry would test a state hydration never produces.
   */
  async function hydrateLikeDaemon(provider: string, envVar: string): Promise<void> {
    const entry = await credentialPresence(projectRoot, provider);
    const stored = await getStoredCredential(projectRoot, provider);
    if (!entry || !stored) throw new Error(`nothing stored for ${provider} to hydrate`);
    process.env[envVar] = stored.value;
    markHydratedEnvValue(provider, envVar, stored.value, {
      updatedAt: entry.updatedAt,
      hint: entry.hint,
      kind: entry.kind,
      backend: entry.backend,
    });
  }

  // INVARIANT: every write MOVES the index entry, even when the clock has not.
  // A daemon detects a rotation only by comparing (updatedAt, hint, kind,
  // backend) against the entry it hydrated from; two same-millisecond writes of
  // secrets sharing their last four characters used to leave an identical entry,
  // and resolution kept serving the replaced secret. Simulated deterministically
  // here with an entry stamped AHEAD of the clock.
  test('a rewrite in the same millisecond still moves the entry, so the rotation resolves', async () => {
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-stored-openai-value' });
    const path = getCredentialIndexPath(projectRoot);
    const index = JSON.parse(await readFile(path, 'utf-8'));
    const ahead = new Date(Date.now() + 60_000).toISOString();
    index.credentials[0].updatedAt = ahead;
    await writeFile(path, JSON.stringify(index));
    await hydrateLikeDaemon('openai', 'OPENAI_API_KEY');

    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-rotated-openai-value' });
    const entry = await credentialPresence(projectRoot, 'openai');
    expect(entry!.hint).toBe(credentialHint('sk-stored-openai-value'));
    expect(Date.parse(entry!.updatedAt)).toBeGreaterThan(Date.parse(ahead));

    const resolved = await resolveCredential(projectRoot, 'openai');
    expect(resolved?.source).toBe('store');
    expect(resolved?.value).toBe('sk-rotated-openai-value');
  });

  test('a fresh project has no index and no credential', async () => {
    expect(await readCredentialIndex(projectRoot)).toEqual([]);
    expect(await credentialPresence(projectRoot, 'anthropic')).toBeNull();
    expect(await credentialAvailable(projectRoot, 'anthropic')).toBeNull();
  });

  test('set then get round-trips the secret', async () => {
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'sk-ant-oauth-value' });
    const stored = await getStoredCredential(projectRoot, 'anthropic');
    expect(stored?.value).toBe('sk-ant-oauth-value');
    expect(stored?.kind).toBe('oauth');
    expect(stored?.backend).toBe('file');
  });

  // INVARIANT: presence is answered from the non-secret index, so the gate never
  // has to open a keychain item — which on macOS can block a detached daemon on
  // an unlock prompt nobody is there to answer.
  test('the index records presence and a hint, never the secret', async () => {
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'api-key', secret: 'sk-ant-0123456789abcd' });
    const raw = await readFile(getCredentialIndexPath(projectRoot), 'utf-8');
    expect(raw).not.toContain('sk-ant-0123456789abcd');
    expect(raw).toContain('anthropic');
    const entry = await credentialPresence(projectRoot, 'anthropic');
    expect(entry?.hint).toBe('abcd');
    expect(entry?.kind).toBe('api-key');
  });

  test('a short secret gets no hint at all', () => {
    expect(credentialHint('short')).toBe('');
    expect(credentialHint('0123456789abcdef')).toBe('cdef');
  });

  test('the index and the secret file are both mode 0600', async () => {
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'sk-ant-oauth-value' });
    const indexMode = (await stat(getCredentialIndexPath(projectRoot))).mode & 0o777;
    expect(indexMode).toBe(0o600);
  });

  test('an empty secret is refused', async () => {
    await expect(
      setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: '   ' }),
    ).rejects.toThrow(/empty/i);
  });

  // SECURITY: rejected at the single write funnel, so no backend has to be
  // trusted to escape it. `security -i` reads one command per line — a line
  // break in the secret would end lazy's command and begin another one.
  test('a secret containing a line break is refused before it reaches a backend', async () => {
    for (const secret of ['sk-ant-good\nsecurity delete-keychain', 'sk-ant\r-good-value']) {
      await expect(
        setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret }),
      ).rejects.toThrow(/line break/i);
    }
    // And nothing was written on the way to refusing.
    expect(await credentialPresence(projectRoot, 'anthropic')).toBeNull();
  });

  test('setting a provider twice replaces rather than duplicates', async () => {
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'first-value-1234' });
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'api-key', secret: 'second-value-5678' });
    const entries = await readCredentialIndex(projectRoot);
    expect(entries.length).toBe(1);
    expect(entries[0]!.kind).toBe('api-key');
    expect((await getStoredCredential(projectRoot, 'anthropic'))?.value).toBe('second-value-5678');
  });

  test('delete removes the secret and the index entry, and is idempotent', async () => {
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'sk-ant-oauth-value' });
    expect(await deleteCredential(projectRoot, 'anthropic')).toBe(true);
    expect(await credentialPresence(projectRoot, 'anthropic')).toBeNull();
    expect(await getStoredCredential(projectRoot, 'anthropic')).toBeNull();
    expect(await deleteCredential(projectRoot, 'anthropic')).toBe(false);
  });

  /**
   * An item the backend holds and the index does not know about.
   *
   * That is what a failed write leaves, and it used to be unrecoverable through
   * lazy: `lazy auth rm` resolves through the index and finds nothing, so the
   * stale secret sat there until someone ran `security delete-generic-password`
   * by hand.
   */
  describe('purgeOrphanCredential', () => {
    test('removes a backend item the index never recorded', async () => {
      await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'sk-real-value' });
      // An orphan: in the secrets file, absent from the index.
      const secretsPath = join(baseDirForProject(baseDir, projectRoot), 'credentials.json');
      const secrets = JSON.parse(await readFile(secretsPath, 'utf-8')) as Record<string, string>;
      secrets['codex-subscription'] = '{"auth_mode":"chatgpt","access_token":"trunc';
      await writeFile(secretsPath, JSON.stringify(secrets, null, 2));

      expect(await purgeOrphanCredential(projectRoot, 'codex-subscription')).toBe(true);
      const after = JSON.parse(await readFile(secretsPath, 'utf-8')) as Record<string, string>;
      expect(after['codex-subscription']).toBeUndefined();
      // ...and the real credential beside it is untouched.
      expect(after.anthropic).toBe('sk-real-value');
    });

    // INVARIANT: never a real credential. An index entry means the user stored
    // it deliberately, and this runs on a write path — deleting one here would
    // destroy a working credential as a side effect of storing another.
    test('refuses to touch a credential the index knows', async () => {
      await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'sk-real-value' });
      expect(await purgeOrphanCredential(projectRoot, 'anthropic')).toBe(false);
      expect((await getStoredCredential(projectRoot, 'anthropic'))?.value).toBe('sk-real-value');
    });

    test('is quiet when there is nothing there at all', async () => {
      expect(await purgeOrphanCredential(projectRoot, 'never-stored')).toBe(false);
    });
  });

  // INVARIANT: an index that claims a credential the backend does not have is a
  // LOUD error, never a silent miss. Falling through to "no credential" would
  // send a user re-entering a token that is really still there, while a daemon
  // refuses to start for a reason nothing explains.
  test('an index entry with no backing secret is a loud error', async () => {
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'sk-ant-oauth-value' });
    // Simulate an out-of-band removal: empty the file backend, leave the index.
    await writeFile(join(baseDirForProject(baseDir, projectRoot), 'credentials.json'), '{}');
    await expect(getStoredCredential(projectRoot, 'anthropic')).rejects.toThrow(/lazy auth (set|rm)/);
  });

  // The message must name BOTH causes. A locked login keychain or keyring —
  // routine over SSH, on a headless host, or for a daemon started outside a
  // desktop session — looks identical to a deleted item from here, and it is
  // the likelier of the two. Naming only "it is gone" sends a user to rotate a
  // token that is sitting safely in a store they merely needed to unlock.
  test('the disagreement error names locked AND gone, with the unlock remedy', async () => {
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'sk-ant-oauth-value' });
    await writeFile(join(baseDirForProject(baseDir, projectRoot), 'credentials.json'), '{}');
    const err = await getStoredCredential(projectRoot, 'anthropic').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/LOCKED/);
    expect(err!.message).toMatch(/GONE/);
    expect(err!.message).toContain('unlock-keychain');
  });

  // INVARIANT (migration): the environment always wins, so every setup that
  // exported a token before this feature existed behaves exactly as it did.
  test('the environment beats the store', async () => {
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'stored-value-1234' });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-value';
    const resolved = await resolveCredential(projectRoot, 'anthropic');
    expect(resolved?.source).toBe('env');
    expect(resolved?.value).toBe('env-value');
    expect(await credentialAvailable(projectRoot, 'anthropic')).toBe('env');
  });

  // INVARIANT: a value the DAEMON hydrated out of the store is not a user
  // export, so it never outranks the store it came from. Without this rule a
  // daemon that started with a credential stored kept serving that startup copy
  // for its whole life, and `lazy auth set` silently changed nothing until a
  // restart — turns went on failing against the retired key with nothing saying
  // why. Matched by VALUE, so the mark cannot outlive the value it describes.
  test('a hydrated copy never shadows a credential stored later', async () => {
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-stored-value-1234' });
    await hydrateLikeDaemon('openai', 'OPENAI_API_KEY');
    // ...and what `lazy auth set openai` does while the daemon runs.
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-rotated-value-5678' });

    const resolved = await resolveCredential(projectRoot, 'openai');
    expect(resolved?.source).toBe('store');
    expect(resolved?.value).toBe('sk-rotated-value-5678');
    // And the reports agree with what a request will actually be billed to.
    expect(await credentialAvailable(projectRoot, 'openai')).toBe('store');
  });

  // INVARIANT: the one credential the DAEMON serves out of its own environment
  // (`credentialNeedsDaemonRestart` — Anthropic) is exempt, and for it the old
  // answer is the accurate one. `getAuthEnvVars` hands the proxy and every
  // launch the startup copy until a restart, so preferring the store here would
  // change no request and only make `lazy doctor` and the credential-state RPC
  // describe the NEW entry — including its `kind`, which is how a user tells a
  // subscription from metered credit — while the daemon billed the old one.
  test('the daemon-env credential keeps reporting as the environment', async () => {
    expect(credentialNeedsDaemonRestart('anthropic')).toBe(true);
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'stored-value-1234' });
    await hydrateLikeDaemon('anthropic', 'CLAUDE_CODE_OAUTH_TOKEN');
    // A rotation the running daemon cannot pick up without a restart.
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'api-key', secret: 'sk-ant-rotated-5678' });

    const resolved = await resolveCredential(projectRoot, 'anthropic');
    expect(resolved?.source).toBe('env');
    expect(resolved?.value).toBe('stored-value-1234');
    expect(resolved?.kind).toBe('oauth');
    // The report says the same thing, rather than naming the store and the new
    // entry's api-key kind while every request spends the oauth subscription.
    expect(await locateCredential(projectRoot, 'anthropic'))
      .toEqual({ source: 'env', via: 'CLAUDE_CODE_OAUTH_TOKEN' });
  });

  // INVARIANT: an UNCHANGED index entry is answered from the hydrated copy
  // without opening the backend. The proxy resolves per REQUEST, so reaching
  // for an OS keychain here would mean a subprocess per model request — and a
  // keychain read can block on an unlock prompt in a daemon with no session to
  // answer one, which is why the secret is kept off this path at all. Proven by
  // emptying the backend: a read would throw, and this must not.
  test('an unchanged index entry is served without touching the backend', async () => {
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-stored-value-1234' });
    await hydrateLikeDaemon('openai', 'OPENAI_API_KEY');
    // Any backend read from here on would throw "index says stored, backend
    // returned nothing". Nothing below may throw.
    await writeFile(join(baseDirForProject(baseDir, projectRoot), 'credentials.json'), '{}');

    const resolved = await resolveCredential(projectRoot, 'openai');
    expect(resolved?.value).toBe('sk-stored-value-1234');
    expect(resolved?.source).toBe('store');
    // NOT degraded: nothing failed, because nothing was read.
    expect(resolved?.stale).toBeUndefined();
    expect((await locateCredential(projectRoot, 'openai'))?.stale).toBeUndefined();
  });

  // The other half of the same rule: a real export still wins, which is the
  // migration promise hydration exists to keep.
  test('a genuine export still beats the store on a variable once hydrated', async () => {
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-stored-value-1234' });
    await hydrateLikeDaemon('openai', 'OPENAI_API_KEY');
    process.env.OPENAI_API_KEY = 'sk-exported-by-hand';

    const resolved = await resolveCredential(projectRoot, 'openai');
    expect(resolved?.source).toBe('env');
    expect(resolved?.value).toBe('sk-exported-by-hand');
    expect(await credentialAvailable(projectRoot, 'openai')).toBe('env');
  });

  // INVARIANT: a hydrated copy is a reflection of the store, never a source of
  // its own. After `lazy auth rm` the daemon still holds the copy in its env —
  // serving it would hand back the very record the user just removed.
  test('a hydrated copy is not a credential once the store has none', async () => {
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-stored-value-1234' });
    await hydrateLikeDaemon('openai', 'OPENAI_API_KEY');
    await deleteCredential(projectRoot, 'openai');

    expect(await resolveCredential(projectRoot, 'openai')).toBeNull();
    expect(await credentialAvailable(projectRoot, 'openai')).toBeNull();
  });

  // INVARIANT: a backend that has stopped ANSWERING is not a credential that is
  // GONE. A login keychain or keyring locking hours into a daemon's life, or an
  // SSH session ending, makes the read throw — and that throw reaches proxy
  // resolvers with no catch around them, so every model request would fail.
  // Hydration exists for exactly those environments, and the copy it took is
  // still good, so the daemon keeps running on it instead of dying.
  test('a rotation the backend cannot serve keeps the hydrated copy alive', async () => {
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-stored-value-1234' });
    await hydrateLikeDaemon('openai', 'OPENAI_API_KEY');
    // The index MOVES (so the backend is consulted) and the backend is empty.
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-rotated-value-5678' });
    await writeFile(join(baseDirForProject(baseDir, projectRoot), 'credentials.json'), '{}');

    const resolved = await resolveCredential(projectRoot, 'openai');
    expect(resolved?.value).toBe('sk-stored-value-1234');
    expect(resolved?.source).toBe('store');
    expect(resolved?.stale).toBe(true);
  });

  // INVARIANT: the degraded path is BOUNDED. The index stays moved for as long
  // as the store is unreadable, so without a record of which entry the read
  // failed on, every request would take the "entry changed" branch and fail
  // again — a keychain subprocess per proxy request, and an unlock prompt at an
  // unattended daemon, which is the hazard the index comparison exists to
  // prevent. Proven by making the backend READABLE again after the first
  // failure: a second read would pick the rotated secret up, so still serving
  // the startup copy is the evidence that no second read happened.
  test('a failed read is not retried while the index entry stands', async () => {
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-stored-value-1234' });
    await hydrateLikeDaemon('openai', 'OPENAI_API_KEY');
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-rotated-value-5678' });
    const backendPath = join(baseDirForProject(baseDir, projectRoot), 'credentials.json');
    const readable = await readFile(backendPath, 'utf-8');
    await writeFile(backendPath, '{}');

    // First resolve: the entry moved, the backend cannot answer, the startup
    // copy stands in and the failure is recorded against that entry.
    expect((await resolveCredential(projectRoot, 'openai'))?.stale).toBe(true);

    // The store is fine again — but nothing has asked it to be looked at.
    await writeFile(backendPath, readable);
    const again = await resolveCredential(projectRoot, 'openai');
    expect(again?.value).toBe('sk-stored-value-1234');
    expect(again?.stale).toBe(true);
  });

  // ...and the bound lifts itself: any later write moves the entry, which is a
  // different entry and so is tried at once. A daemon is never stuck on the
  // startup copy with no way back short of a restart.
  test('a later rotation is tried even after a failed read', async () => {
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-stored-value-1234' });
    await hydrateLikeDaemon('openai', 'OPENAI_API_KEY');
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-rotated-value-5678' });
    const backendPath = join(baseDirForProject(baseDir, projectRoot), 'credentials.json');
    await writeFile(backendPath, '{}');
    expect((await resolveCredential(projectRoot, 'openai'))?.stale).toBe(true);

    // The user unlocks the keychain and stores again — a NEW entry.
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-third-value-9012' });

    const resolved = await resolveCredential(projectRoot, 'openai');
    expect(resolved?.value).toBe('sk-third-value-9012');
    expect(resolved?.stale).toBeUndefined();
  });

  // INVARIANT: a report never describes a source requests are not being served
  // from. On the degraded path the value in use is the startup copy while the
  // index still names the backend, so `lazy doctor` and the credential-state
  // RPC must carry the same `stale` flag the resolver does — the divergence
  // `locateProfileCredential`'s "keep the two in step" contract forbids.
  test('the degraded state reaches the reports, not just the requests', async () => {
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-stored-value-1234' });
    await hydrateLikeDaemon('openai', 'OPENAI_API_KEY');
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-rotated-value-5678' });
    await writeFile(join(baseDirForProject(baseDir, projectRoot), 'credentials.json'), '{}');

    // The report is unaware until a resolve has actually failed — it never
    // opens a backend itself, so it cannot know before then.
    await resolveCredential(projectRoot, 'openai');

    const located = await locateCredential(projectRoot, 'openai');
    expect(located).toEqual({ source: 'store', via: 'file', stale: true, kind: 'api-key' });
  });

  // INVARIANT: the first rotated read SETTLES the steady state — the rotated
  // secret goes into the daemon's env var and the mark is rewritten with the
  // new entry. Without that the mark would carry the pre-rotation entry for
  // ever, every later comparison would fail, and every later resolve would open
  // the backend: one keychain subprocess per proxy request for the life of the
  // daemon, which is the hazard the index comparison exists to remove. One
  // rotation would have undone it permanently.
  test('a second resolve after a rotation does not touch the backend', async () => {
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-stored-value-1234' });
    await hydrateLikeDaemon('openai', 'OPENAI_API_KEY');
    await setCredential(projectRoot, { provider: 'openai', kind: 'api-key', secret: 'sk-rotated-value-5678' });

    // First resolve: the entry moved, so this one legitimately reads the backend.
    expect((await resolveCredential(projectRoot, 'openai'))?.value).toBe('sk-rotated-value-5678');

    // From here a backend read would throw. The second resolve must not need one.
    await writeFile(join(baseDirForProject(baseDir, projectRoot), 'credentials.json'), '{}');
    const again = await resolveCredential(projectRoot, 'openai');
    expect(again?.value).toBe('sk-rotated-value-5678');
    expect(again?.source).toBe('store');
    expect(again?.stale).toBeUndefined();
  });

  // ...and when the rotation changes KIND, the old variable must not be left
  // behind holding a retired secret: unmarked, it would read as the user's own
  // export and outrank the store on the very next resolve.
  test('adopting a rotation of another kind clears the old variable', async () => {
    const apiKeyVar = namedCredentialEnvVar('work-openai', 'api-key');
    const oauthVar = namedCredentialEnvVar('work-openai', 'oauth');
    await setCredential(projectRoot, { provider: 'work-openai', kind: 'api-key', secret: 'sk-named-value-1234' });
    await hydrateLikeDaemon('work-openai', apiKeyVar);
    await setCredential(projectRoot, { provider: 'work-openai', kind: 'oauth', secret: 'oauth-named-value-5678' });

    const resolved = await resolveCredential(projectRoot, 'work-openai');
    expect(resolved?.value).toBe('oauth-named-value-5678');
    expect(process.env[oauthVar]).toBe('oauth-named-value-5678');
    expect(process.env[apiKeyVar]).toBeUndefined();

    // And the steady state settled on the new variable, not just the value.
    await writeFile(join(baseDirForProject(baseDir, projectRoot), 'credentials.json'), '{}');
    expect((await resolveCredential(projectRoot, 'work-openai'))?.value).toBe('oauth-named-value-5678');
  });

  // INVARIANT: on the stale path the credential describes the record the SERVED
  // value came from, not the newer entry the backend will not hand over. The
  // proxy picks its auth header from `kind`, so reporting the new entry's kind
  // beside an old secret sends an api-key out as `Authorization: Bearer` — a
  // 401 invisible from either end.
  test('a stale credential reports the kind it is actually serving', async () => {
    const apiKeyVar = namedCredentialEnvVar('work-openai', 'api-key');
    await setCredential(projectRoot, { provider: 'work-openai', kind: 'api-key', secret: 'sk-named-value-1234' });
    await hydrateLikeDaemon('work-openai', apiKeyVar);
    // The index now says oauth; the backend cannot produce it.
    await setCredential(projectRoot, { provider: 'work-openai', kind: 'oauth', secret: 'oauth-named-value-5678' });
    await writeFile(join(baseDirForProject(baseDir, projectRoot), 'credentials.json'), '{}');

    const resolved = await resolveCredential(projectRoot, 'work-openai');
    expect(resolved?.stale).toBe(true);
    expect(resolved?.value).toBe('sk-named-value-1234');
    expect(resolved?.kind).toBe('api-key');
    expect(resolved?.envVar).toBe(apiKeyVar);
    // The report says the same, rather than the oauth the index now claims.
    expect((await locateCredential(projectRoot, 'work-openai'))?.kind).toBe('api-key');
  });

  test('a blank env var does not mask a stored credential', async () => {
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'stored-value-1234' });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = '   ';
    const resolved = await resolveCredential(projectRoot, 'anthropic');
    expect(resolved?.source).toBe('store');
    expect(await credentialAvailable(projectRoot, 'anthropic')).toBe('store');
  });

  test('credentialAvailable never reads the secret', async () => {
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'stored-value-1234' });
    // Remove the secret but leave the index: presence must still answer 'store'
    // (reading the secret is what would have thrown here).
    await writeFile(join(baseDirForProject(baseDir, projectRoot), 'credentials.json'), '{}');
    expect(await credentialAvailable(projectRoot, 'anthropic')).toBe('store');
  });

  test('an unparseable index is an error, not an empty store', async () => {
    await setCredential(projectRoot, { provider: 'anthropic', kind: 'oauth', secret: 'stored-value-1234' });
    await writeFile(getCredentialIndexPath(projectRoot), '{not json');
    await expect(readCredentialIndex(projectRoot)).rejects.toThrow();
  });
});

/** The daemon state dir for a project under a pinned base dir. */
function baseDirForProject(_baseDir: string, projectRoot: string): string {
  // Import lazily to keep the helper honest about using lazy's own resolution.
  const { getDaemonDir } = require('../../src/daemon/paths');
  return getDaemonDir(projectRoot);
}

/** FileBackend writes where getCredentialsPath says, and nowhere else. */
describe('FileBackend', () => {
  test('round-trips and removes', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'lazy-cred-file-'));
    const undo = pinDaemonBaseDir(baseDir);
    const projectRoot = await mkdtemp(join(tmpdir(), 'lazy-cred-file-proj-'));
    try {
      const backend = new FileBackend();
      expect(await backend.available()).toBe(true);
      expect(await backend.get(projectRoot, 'anthropic')).toBeNull();
      await backend.set(projectRoot, 'anthropic', 'value-1');
      expect(await backend.get(projectRoot, 'anthropic')).toBe('value-1');
      expect(await backend.remove(projectRoot, 'anthropic')).toBe(true);
      expect(await backend.get(projectRoot, 'anthropic')).toBeNull();
      expect(await backend.remove(projectRoot, 'anthropic')).toBe(false);
    } finally {
      undo();
      await rm(baseDir, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
