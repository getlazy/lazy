/**
 * `lazy doctor` credential check — WHOSE environment it reports on, and for
 * WHICH credentials.
 *
 * INVARIANT: the daemon is the credential owner. Every agent inherits the
 * DAEMON's environment, so the credential check must ask the daemon and must
 * never present the CLI process's own env as the answer. Reading `process.env`
 * was wrong in both directions: a daemon-only-env deployment reported "not
 * authenticated" while everything worked, and a stale token in the user's shell
 * reported healthy auth the daemon did not have.
 *
 * PER CREDENTIAL: the check lists every credential the project's configured
 * agent profiles bill — the role defaults plus every `[agents.<name>]` block —
 * one line each with presence, source and the profiles that need it, so a
 * project spanning providers learns exactly which key is missing and for whom.
 *
 * These tests need a REAL daemon (withDaemon: true) — under LAZY_TEST the RPC
 * is bypassed by design and only the degraded path is reachable (that one is
 * covered in doctor.test.ts). The daemon reads lazy.toml per request, so one
 * daemon serves every configuration below.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { getCredentialIndexPath } from '../../src/daemon/paths';

/** A declared profile billing OpenRouter — the credential the daemon below never has. */
const OPENROUTER_CODEX =
  '\n[agents.openrouter-codex]\nharness = "codex"\nmodel = "gpt-5-codex"\n' +
  'endpoint = "https://openrouter.ai/api/v1"\n';

describe('lazy doctor — credential source', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // Pin what the DAEMON holds, independent of the developer's shell: the
    // harness's ANTHROPIC_API_KEY (CLAUDE_CODE_OAUTH_TOKEN blanked, or an
    // exported one would win precedence and make the source label
    // machine-dependent), an OpenAI key and a NAMED credential for the
    // multi-credential case, and OPENROUTER_API_KEY pinned ABSENT for the
    // missing-credential cases (a developer with it exported would otherwise
    // turn that ✗ green).
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        CLAUDE_CODE_OAUTH_TOKEN: '',
        OPENAI_API_KEY: 'sk-test-openai',
        LAZY_CREDENTIAL_WORK_OPENAI: 'sk-test-work-openai',
        OPENROUTER_API_KEY: '',
      },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Append to the init-produced lazy.toml (never overwrite: external_path lives there). */
  async function appendConfig(extra: string): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const existing = await readFile(configPath, 'utf-8');
    await writeFile(configPath, existing + extra, 'utf-8');
  }

  test('reports authenticated when only the daemon holds a credential', async () => {
    const result = await ctx.lazy(['doctor'], {
      // The user's shell has nothing — the daemon-only-env deployment.
      env: { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
    });

    expectOutput(result, '✓ Anthropic credential present (daemon env: ANTHROPIC_API_KEY; needed by claude-code)');
    // No caveat: the daemon answered, so nothing was read from this shell.
    expectOutputExcludes(result, 'shell env:');
  });

  test('reports what the DAEMON sees, not a different credential in the shell', async () => {
    const result = await ctx.lazy(['doctor'], {
      // A stale OAuth token in the user's shell. It takes precedence over
      // ANTHROPIC_API_KEY locally, so if doctor were reading this process's env
      // it would say "CLAUDE_CODE_OAUTH_TOKEN" — the daemon has no such token.
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-stale-shell-token' },
    });

    expectOutput(result, '✓ Anthropic credential present (daemon env: ANTHROPIC_API_KEY; needed by claude-code)');
    expectOutputExcludes(result, 'CLAUDE_CODE_OAUTH_TOKEN');
    expectOutputExcludes(result, 'shell env:');
  });

  // INVARIANT: one line per credential the configured profiles bill — a provider
  // inferred from a profile's endpoint, and a credential a profile names
  // outright — each from the DAEMON's environment and each naming the profile
  // that needs it. Declaring a profile is enough; no role has to default to it.
  test('reports every credential the configured profiles bill, one line each', async () => {
    await appendConfig(
      '\n[agents.openai-pi]\nharness = "pi"\nmodel = "gpt-5.2"\nendpoint = "https://api.openai.com"\n' +
      '\n[agents.work-codex]\nharness = "codex"\nmodel = "gpt-5-codex"\ncredential = "work-openai"\n',
    );

    const result = await ctx.lazy(['doctor'], {
      // The shell holds none of them.
      env: {
        ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', OPENAI_API_KEY: '', LAZY_CREDENTIAL_WORK_OPENAI: '',
      },
    });

    expectOutput(result, '✓ Anthropic credential present (daemon env: ANTHROPIC_API_KEY; needed by claude-code)');
    expectOutput(result, '✓ OpenAI credential present (daemon env: OPENAI_API_KEY; needed by openai-pi)');
    expectOutput(result, '✓ work-openai credential present (daemon env: LAZY_CREDENTIAL_WORK_OPENAI; needed by work-codex)');
    expectOutputExcludes(result, 'shell env:');
  });

  // INVARIANT: a credential the daemon cannot pay with FAILS the check by name,
  // with the profile it strands and the command that stores it — and the
  // credentials that ARE present are still reported. The daemon itself starts
  // fine (its gate reads the role defaults only), which is exactly why doctor
  // has to be the surface that says this.
  test('fails by name when the daemon holds no credential a declared profile bills', async () => {
    await appendConfig(OPENROUTER_CODEX);

    const result = await ctx.lazy(['doctor'], { env: { OPENROUTER_API_KEY: '' } });

    expectOutput(result, '✗ OpenRouter credential present (needed by openrouter-codex)');
    expectOutput(result, 'The daemon holds no OpenRouter credential');
    expectOutput(result, 'openrouter-codex profile');
    expectOutput(result, 'lazy auth set openrouter');
    expectOutput(result, 'OPENROUTER_API_KEY');
    expectOutput(result, '✓ Anthropic credential present (daemon env: ANTHROPIC_API_KEY; needed by claude-code)');
  });

  // INVARIANT: one unreadable store index degrades ONE credential's line to the
  // read error — it does not take the whole answer down. The Anthropic
  // credential sits in the daemon's environment, which is consulted before the
  // store, so its line is unaffected; the OpenRouter line carries the error.
  test('a broken credential index fails only the credential it could not answer for', async () => {
    await appendConfig(OPENROUTER_CODEX);
    await writeFile(getCredentialIndexPath(ctx.root), '{ this is not json', 'utf-8');

    const result = await ctx.lazy(['doctor'], { env: { OPENROUTER_API_KEY: '' } });

    expectOutput(result, '✓ Anthropic credential present (daemon env: ANTHROPIC_API_KEY; needed by claude-code)');
    expectOutput(result, '✗ OpenRouter credential present (needed by openrouter-codex)');
    expectOutput(result, 'could not tell whether a OpenRouter credential is available');
    expectOutput(result, 'Failed to parse the credential index');
  });

  // INVARIANT: a project whose configured profiles all use upstreams that take
  // no credential needs none — and says that, rather than reporting a
  // credential it does not use or the absence of one it does not need.
  test('reports no credential needed when every configured profile uses a local upstream', async () => {
    // Overriding the built-in claude-code profile moves BOTH role defaults to a
    // local server, and nothing else is declared.
    await appendConfig(
      '\n[agents.claude-code]\nharness = "claude-code"\nmodel = "qwen3.8:latest"\n' +
      'endpoint = "http://localhost:11434"\n',
    );

    const result = await ctx.lazy(['doctor'], {
      env: { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
    });

    // The ✓/✗ marker on the credential line is the assertion: doctor's exit
    // code aggregates every check (Docker, tmux, …), so it says nothing about
    // this one in particular.
    expectOutput(result, '✓ Model credential present (none needed');
    expectOutputExcludes(result, 'credential present (daemon env');
    expectOutputExcludes(result, 'shell env:');
  });
});
