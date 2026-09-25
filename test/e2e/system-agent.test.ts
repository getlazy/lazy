/**
 * `lazy system agent` — per-PROFILE readiness view, default switching, API keys
 * (cursor-first-class-agent Goal B / item 3, re-cut for agent profiles).
 *
 * The switching tests double as the no-restart property tests: the daemon
 * re-reads config on every launch and the CLI on every invocation, so a
 * `set`/`set-key` performed while a daemon is up affects the very next
 * operation. The daemon-backed suite at the bottom proves it end-to-end.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { getCredentialsPath } from '../../src/daemon/paths';

/** The secret file the `file` credential backend writes. */
async function readStore(root: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(getCredentialsPath(root), 'utf-8'));
}

describe('lazy system agent (daemonless)', () => {
  let ctx: TestContext;
  let daemonBase: string;
  let unpinDaemonBase: () => void;

  beforeEach(async () => {
    daemonBase = await makeDaemonBaseDir();
    unpinDaemonBase = pinDaemonBaseDir(daemonBase);
    ctx = await setupTestLazy();
    // The `file` backend, explicitly: `set-key` now writes the same credential
    // store `lazy auth set` does, and this suite must behave identically on a
    // Mac with a Keychain and in a container with no secret service at all —
    // and must never touch the developer's own keychain.
    const configPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(configPath, 'utf-8');
    await writeFile(configPath, `${toml}\n[credentials]\nbackend = "file"\n`);
  });

  afterEach(async () => {
    await ctx.cleanup();
    // Unpin only AFTER cleanup — cleanup resolves paths from this variable.
    unpinDaemonBase();
    await removeDaemonBaseDir(daemonBase);
  });

  test('status lists every built-in profile and marks the default', async () => {
    const result = await ctx.lazy(['system', 'agent']);
    expectSuccess(result);
    expectOutput(result, 'claude-code');
    expectOutput(result, 'cursor');
    expectOutput(result, 'pi');
    expectOutput(result, 'codex');
    expectOutput(result, 'default');
    expectOutput(result, 'Default agent: claude-code');
    // Readiness is answered per profile: harness, model, upstream, credential.
    expectOutput(result, 'Harness:');
    expectOutput(result, 'Model:');
    expectOutput(result, 'Upstream:');
    expectOutput(result, 'Credential:');
  });

  // A profile is what `--agent` selects, so a user-defined block must appear in
  // the readiness view exactly like a built-in — with ITS harness, ITS model and
  // ITS upstream, not the harness defaults.
  test('status lists a user-defined profile with its own upstream and credential', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(configPath, 'utf-8');
    await writeFile(configPath, `${toml}
[agents.local-ollama-pi]
harness = "pi"
model = "qwen3:8b"
endpoint = "http://127.0.0.1:59431"
`);
    const result = await ctx.lazy(['system', 'agent']);
    expectSuccess(result);
    expectOutput(result, 'local-ollama-pi');
    expectOutput(result, 'qwen3:8b');
    expectOutput(result, 'http://127.0.0.1:59431');
    // Nothing is listening on that port, and the probe says so rather than
    // reporting a profile that cannot serve a turn as ready.
    expectOutput(result, 'UNREACHABLE');
    // A local endpoint defaults to `none` — no key is required or sent.
    expectOutput(result, 'authenticates nobody');
  });

  // INVARIANT: pi deliberately has NO managed key — its turns ride lazy's
  // Anthropic/Ollama credentials through the proxy (decide-cross-agent-key-
  // acquisition: keys belong to providers, not agents). set-key must refuse
  // rather than store a credential nothing would ever read.
  test('set-key refuses pi (rides lazy credentials, no key of its own)', async () => {
    const result = await ctx.lazy(['system', 'agent', 'set-key', 'pi']);
    expectFailure(result);
    // The built-in pi profile runs a LOCAL Ollama, which authenticates nobody,
    // so the refusal says that rather than "no key of its own" — and it stays
    // actionable by naming where a credential WOULD go if that upstream needed
    // one. A refusal with no remedy would just move the dead end.
    expectError(result, 'authenticates nobody');
    expectError(result, '[agents.pi]');
  });

  // The same refusal for a pi profile that DOES bill a provider: the key still
  // belongs to the provider, not to the agent binary.
  test('set-key refuses a pi profile that bills Anthropic, naming the credential', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    await writeFile(
      configPath,
      `${before}\n[agents.anthropic-pi]\nharness = "pi"\nmodel = "claude-opus-5"\n` +
      `endpoint = "https://api.anthropic.com"\n`,
    );
    const result = await ctx.lazy(['system', 'agent', 'set-key', 'anthropic-pi']);
    expectFailure(result);
    expectError(result, 'lazy auth set anthropic');
  });

  test('set switches the default, preserving lazy.toml comments', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    expect(before).toContain('agent_id = "claude-code"');

    const result = await ctx.lazy(['system', 'agent', 'set', 'cursor']);
    expectSuccess(result);
    expectOutput(result, 'Default agent is now "cursor"');
    expectOutput(result, 'no restart');
    // No key configured → the command must point at the remedy up front.
    expectOutput(result, 'lazy system agent set-key cursor');

    const after = await readFile(configPath, 'utf-8');
    expect(after).toContain('agent_id = "cursor"');
    // The init template's comment above the key survives the text edit.
    expect(after).toContain('# Default agent for task execution');

    const status = await ctx.lazy(['system', 'agent', 'status']);
    expectOutput(status, 'Default agent: cursor');
  });

  test('set refuses an unknown agent, naming the valid ones', async () => {
    const result = await ctx.lazy(['system', 'agent', 'set', 'not-an-agent']);
    expectFailure(result);
    expectError(result, 'Unknown agent');
    expectError(result, 'claude-code');
  });

  test('set-key stores a 0600 key outside the repo that clear-key removes', async () => {
    const result = await ctx.lazy(['system', 'agent', 'set-key', 'cursor'], { input: 'key_test_123\n' });
    expectSuccess(result);
    expectOutput(result, 'Stored cursor API key');
    expectOutput(result, 'no daemon restart');

    // SECURITY INVARIANT (fix-cursor-security-musts §1): the key lives in the
    // per-project daemon dir, NOT under the project root. Every task container
    // mounts the repo read-only, so an in-repo key is readable by every agent
    // of every task — 0600 stops other host users, not the container. The file
    // moved from agent-credentials.json to the credential store, and the
    // property has to hold for the store too.
    const credPath = getCredentialsPath(ctx.root);
    expect(credPath.startsWith(ctx.root)).toBe(false);
    expectOutput(result, credPath);
    expect((await readStore(ctx.root)).cursor).toBe('key_test_123');
    expect((await stat(credPath)).mode & 0o777).toBe(0o600);

    // Nothing is left behind in the mounted tree.
    await expect(stat(join(ctx.root, '.lazy', 'agent-credentials.json'))).rejects.toThrow();

    // Status reflects the stored key, naming the slot, the KIND and the backend.
    // The kind is what answers "am I about to spend a subscription or metered
    // credit" on a provider that issues both — see public-docs/credentials.md.
    const status = await ctx.lazy(['system', 'agent', 'status']);
    expectOutput(status, 'cursor — credential store (api-key, file)');

    const cleared = await ctx.lazy(['system', 'agent', 'clear-key', 'cursor']);
    expectSuccess(cleared);
    expectOutput(cleared, 'Removed the stored cursor API key');
    expect((await readStore(ctx.root)).cursor).toBeUndefined();
  });

  // INVARIANT: `set-key` writes the slot the PROFILE bills — the credential
  // name, not the agent name. Codex bills `openai`, and the proxy resolves that
  // same slot per request, so a key stored under any other key would pass the
  // launch check and then 401 upstream.
  test('set-key codex stores under the openai credential and clears it', async () => {
    const result = await ctx.lazy(['system', 'agent', 'set-key', 'codex'], { input: 'sk-codex-test-key\n' });
    expectSuccess(result);
    expectOutput(result, 'Stored codex API key');
    expectOutput(result, '"openai" credential');
    expectOutput(result, 'OPENAI_API_KEY');
    expect((await readStore(ctx.root)).openai).toBe('sk-codex-test-key');

    // Same slot `lazy auth` speaks — one store, not two.
    const list = await ctx.lazy(['auth', 'list']);
    expectOutput(list, 'openai');
    expectOutput(list, 'store');

    const cleared = await ctx.lazy(['system', 'agent', 'clear-key', 'codex']);
    expectSuccess(cleared);
    expectOutput(cleared, 'Removed the stored codex API key');
  });

  // INVARIANT (engineer, 2026-09-14): the two things codex can spend are two
  // BUILT-IN agents, selectable by name with no lazy.toml block. "Which account
  // is this task about to bill" has to be readable off the agent name; working it
  // out from which credential happens to be stored is the confusion this
  // replaced. `set-key` is refused on the subscription one because a ChatGPT plan
  // issues no API key — the session comes from `codex login`.
  test('codex-api and codex-subscription are selectable built-ins that bill differently', async () => {
    const status = await ctx.lazy(['system', 'agent', 'status']);
    expectSuccess(status);
    expectOutput(status, 'codex-api');
    expectOutput(status, 'codex-subscription');
    // Each names the credential it bills, so the readiness view answers it too.
    expectOutput(status, 'chatgpt');

    // Selectable as a project default — no block written, nothing to configure.
    const set = await ctx.lazy(['system', 'agent', 'set', 'codex-subscription']);
    expectSuccess(set);
    expectOutput(set, 'Default agent is now "codex-subscription"');
    // And the remedy it offers is the one that works for a subscription.
    expectOutput(set, 'lazy auth import chatgpt');

    const rejected = await ctx.lazy(['system', 'agent', 'set-key', 'codex-subscription'], {
      input: 'sk-not-a-session\n',
    });
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toContain('issues no API key');
    expect(rejected.stderr).toContain('lazy auth import chatgpt');

    // The older `codex` name keeps working and keeps meaning the API key.
    const back = await ctx.lazy(['system', 'agent', 'set', 'codex']);
    expectSuccess(back);
    expectOutput(back, 'lazy system agent set-key codex');
  });

  // Two profiles on ONE harness must be able to bill DIFFERENT keys: that is
  // the whole point of a named credential, and the divergence a harness-keyed
  // store could not express.
  test('set-key on a profile with a named credential stores under that name', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(configPath, 'utf-8');
    await writeFile(configPath, `${toml}
[agents.work-codex]
harness = "codex"
model = "gpt-5-codex"
credential = "work-openai"
`);
    expectSuccess(await ctx.lazy(['system', 'agent', 'set-key', 'codex'], { input: 'sk-personal\n' }));
    expectSuccess(await ctx.lazy(['system', 'agent', 'set-key', 'work-codex'], { input: 'sk-work\n' }));

    const store = await readStore(ctx.root);
    expect(store.openai).toBe('sk-personal');
    expect(store['work-openai']).toBe('sk-work');

    // Clearing one leaves the other alone.
    expectSuccess(await ctx.lazy(['system', 'agent', 'clear-key', 'work-codex']));
    const after = await readStore(ctx.root);
    expect(after['work-openai']).toBeUndefined();
    expect(after.openai).toBe('sk-personal');
  });

  test('set-key reads the key from piped stdin', async () => {
    const result = await ctx.lazy(['system', 'agent', 'set-key', 'cursor'], { input: 'piped_key_9\n' });
    expectSuccess(result);
    expect((await readStore(ctx.root)).cursor).toBe('piped_key_9');
  });

  // SECURITY INVARIANT (fix-cursor-security-musts §4): there is no argv form.
  // A key passed as an argument lands in shell history and is visible in `ps`
  // to every user on the machine, so the trailing-argument form was removed
  // outright rather than kept as a convenience. It is REJECTED rather than
  // ignored: a user who typed a real key there has already exposed it, and
  // needs to be told to rotate it instead of assuming it was stored.
  test('set-key rejects a key passed as an argument and says to rotate it', async () => {
    const result = await ctx.lazy(['system', 'agent', 'set-key', 'cursor', 'key_from_argv']);
    expectFailure(result);
    expectError(result, 'takes no key argument');
    expectError(result, 'shell history');
    expectError(result, 'ROTATE IT');
    // Nothing stored, and the key the user typed is not echoed back anywhere.
    await expect(stat(getCredentialsPath(ctx.root))).rejects.toThrow();
    expect(result.stdout + result.stderr).not.toContain('key_from_argv');
  });

  test('set-key refuses agents that have no managed key', async () => {
    const result = await ctx.lazy(['system', 'agent', 'set-key', 'claude-code']);
    expectFailure(result);
    expectError(result, 'does not use an API key');
  });

  test('system agent -h prints its own usage, not the parent help', async () => {
    const result = await ctx.lazy(['system', 'agent', '--help']);
    expectOutput(result, 'lazy system agent [status|set');
  });
});

describe('lazy system agent (daemon-backed pickup)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (cursor-first-class-agent, Goal B): a switch made while a daemon
  // is RUNNING is picked up by the next operation — never a daemon restart.
  // Config is re-read per invocation/launch; nothing caches [agent] agent_id
  // across launches. This is the property that makes direct-file config
  // editing (the `lazy protect` precedent) sufficient.
  test('a default-agent switch takes effect on the next create with the daemon running', async () => {
    const before = await ctx.lazy(['create', '--goal', 'pre-switch task']);
    expectSuccess(before);
    // Default agent → no Agent line is printed (claude-code is the norm).
    expect(before.stdout).not.toContain('Agent:');

    expectSuccess(await ctx.lazy(['system', 'agent', 'set', 'cursor']));

    const after = await ctx.lazy(['create', '--goal', 'post-switch task']);
    expectSuccess(after);
    expectOutput(after, 'Agent:');
    expectOutput(after, 'cursor');
  });
});
