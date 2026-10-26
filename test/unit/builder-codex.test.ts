/**
 * The Codex builder's pure pieces: argv translation, the rollout importer (run
 * against a rollout read off the real codex-cli 0.164.0), the per-run
 * CODEX_HOME, the profile recorded on the builder's MCP token, and the managed
 * config.toml. The end-to-end path is test/e2e/builder-codex.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { composeCodexBuilderArgs, builderResumeIdFromArgs, assertHeadlessBuilderHarness } from '../../src/builder/codex-args';
import { parseCodexRolloutText } from '../../src/import/codex-builder-logs';
import { resolveBuilderCodexHome, detectCodexBuilderSessionId } from '../../src/builder/codex-home';
import { renderCodexConfig } from '../../src/agent/codex-config';
import { mintDaemonToken, lookupDaemonTokenBuilderProfile, BuilderProfileMismatchError } from '../../src/daemon/actor-tokens';
import { buildBuilderDockerArgs } from '../../src/runner/docker-runner';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'codex', 'codex-rollout-0.164.0.jsonl');

describe('Codex builder argv', () => {
  const sandboxChoices = (args: string[]) => args.filter(arg => arg === '--sandbox' || arg === '-s').length;
  // INVARIANT: clap accepts one sandbox choice; combining Pair's default with
  // the builder's choice can reject launch or select the wrong host boundary.
  // INVARIANT: every builder launch composes ONE Claude-spelled argv tail and a
  // Codex builder translates it at launch. A flag Codex has no counterpart for
  // fails loudly — passed through, it would make clap reject the whole argv.
  test('translates the container builder tail', () => {
    const args = composeCodexBuilderArgs({
      claudeArgs: ['--dangerously-skip-permissions', '--add-dir', '/scratch', '--resume', '01a16c71-9006-7ad0-9fea-0da04bb48602', '--model', 'gpt-5.5', '--effort', 'max'],
      externallySandboxed: true,
    });
    expect(args.slice(0, 3)).toEqual(['codex', 'resume', '01a16c71-9006-7ad0-9fea-0da04bb48602']);
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(sandboxChoices(args)).toBe(0);
    expect(args.join(' ')).toContain('-m gpt-5.5');
    // lazy's `max` maps to Codex's ceiling.
    expect(args).toContain('model_reasoning_effort="xhigh"');
    expect(args.join(' ')).toContain('--add-dir /scratch');
  });

  test('--no-autonomous in a container asks before acting, without a nested sandbox', () => {
    const args = composeCodexBuilderArgs({ claudeArgs: ['--model', 'gpt-5.5'], externallySandboxed: true });
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args.join(' ')).toContain('-s danger-full-access -a on-request');
    expect(sandboxChoices(args)).toBe(1);
  });

  test('host sandbox settings select Codex\'s own sandbox', () => {
    const args = composeCodexBuilderArgs({
      claudeArgs: ['--settings', '{"sandbox":{}}', '--dangerously-skip-permissions', '--model', 'gpt-5.5'],
      externallySandboxed: false,
    });
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args.join(' ')).toContain('-s workspace-write -a never');
    expect(sandboxChoices(args)).toBe(1);
  });

  test('an untranslatable Claude flag is refused', () => {
    expect(() => composeCodexBuilderArgs({ claudeArgs: ['--model', 'm', '--append-system-prompt', 'x'], externallySandboxed: true }))
      .toThrow(/no Codex counterpart/);
  });

  test('resume id is read from the tail', () => {
    expect(builderResumeIdFromArgs(['--model', 'm', '--resume', 'abc'])).toBe('abc');
    expect(builderResumeIdFromArgs(['--model', 'm'])).toBeNull();
  });

  // INVARIANT: the headless builder (review conversations) runs `claude -p`;
  // under a Codex profile it refuses rather than launching Claude Code on a
  // profile that bills an OpenAI credential.
  test('headless builder turns refuse a Codex profile', () => {
    expect(() => assertHeadlessBuilderHarness('codex', 'codex-subscription')).toThrow(/Claude Code only/);
    expect(() => assertHeadlessBuilderHarness('claude-code', 'claude-code')).not.toThrow();
  });

  // INVARIANT: every builder launch runs without codex's shared background
  // server (the image's release binaries cannot start it) and carries exactly
  // one sandbox choice, whatever the runner and permission mode.
  test('every combination: --no-daemon once, one sandbox choice', () => {
    for (const externallySandboxed of [true, false]) {
      for (const skip of [true, false]) {
        for (const settings of [true, false]) {
          const args = composeCodexBuilderArgs({
            externallySandboxed,
            claudeArgs: ['--resume', 't1', '--model', 'gpt-5.5', ...(skip ? ['--dangerously-skip-permissions'] : []), ...(settings ? ['--settings', '{}'] : [])],
          });
          expect(args.filter((a) => a === '--no-daemon')).toHaveLength(1);
          const choices = args.filter((a) => a === '--sandbox' || a === '-s' || a === '--dangerously-bypass-approvals-and-sandbox');
          expect(choices).toHaveLength(1);
        }
      }
    }
  });
});

describe('Codex rollout capture', () => {
  test('a real 0.164.0 rollout becomes the conversation the person had, with usage', async () => {
    const conversation = parseCodexRolloutText(await readFile(FIXTURE, 'utf-8'), FIXTURE);
    expect(conversation.sessionId).toBe('01a16c71-9006-7ad0-9fea-0da04bb48602');
    expect(conversation.version).toBe('0.164.0');
    // Codex's own injected <environment_context> and developer messages are not
    // the conversation.
    expect(conversation.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'say hi'],
      ['assistant', 'hello from fake'],
    ]);
    const assistant = conversation.messages[1]!;
    expect(assistant.model).toBe('gpt-6.1-sol');
    // input_tokens INCLUDES cached input: 120 total, 20 cached → 100 + 20 read.
    expect(assistant.usage).toEqual({ inputTokens: 100, outputTokens: 7, cacheCreationTokens: 0, cacheReadTokens: 20 });
    expect(conversation.totalUsage).toEqual(assistant.usage!);
  });

  test('a half-written last line is skipped, not fatal', async () => {
    const text = (await readFile(FIXTURE, 'utf-8')) + '{"timestamp":"x","type":"respo';
    expect(parseCodexRolloutText(text, FIXTURE).messages).toHaveLength(2);
  });
});

describe('Codex builder home', () => {
  let base: string;
  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'lazy-codex-home-')); });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  // INVARIANT: one CODEX_HOME per builder run, and a resume runs in the home
  // that holds the rollout — `codex resume <id>` sees only its own home.
  test('a fresh run gets its own home; a resume finds the one holding the rollout', async () => {
    const first = await resolveBuilderCodexHome(base, 'run-a', null);
    expect(first.codexHome).toBe(join(base, 'codex-homes', 'run-a'));
    const day = join(first.codexHome, 'sessions', '2026', '10', '24');
    await mkdir(day, { recursive: true });
    await writeFile(join(day, 'rollout-2026-10-24T05-45-44-01a16c71-9006-7ad0-9fea-0da04bb48602.jsonl'), '');

    const resumed = await resolveBuilderCodexHome(base, 'run-b', '01a16c71-9006-7ad0-9fea-0da04bb48602');
    expect(resumed).toEqual({ codexHome: first.codexHome, holdsResume: true });
    const missing = await resolveBuilderCodexHome(base, 'run-c', '01a16c71-0000-7000-8000-000000000000');
    expect(missing).toEqual({ codexHome: join(base, 'codex-homes', 'run-c'), holdsResume: false });

    expect(await detectCodexBuilderSessionId({ codexHome: first.codexHome, launchedAtMs: 0, resumeId: null }))
      .toBe('01a16c71-9006-7ad0-9fea-0da04bb48602');
  });
});

describe('builder session profile on its MCP token', () => {
  let root: string;
  const prev = process.env.LAZY_DAEMON_BASE_DIR;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-builder-token-'));
    process.env.LAZY_DAEMON_BASE_DIR = join(root, 'daemon');
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = prev;
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: a builder session's profile is fixed at mint; a re-issue for
  // another profile is refused, so a relaunch can never quietly switch what
  // the session runs on (or bills).
  test('records the profile and refuses a re-issue for a different one', async () => {
    const token = await mintDaemonToken(root, { kind: 'builder' }, 'builder-aa11bb22', { builderProfile: 'codex-subscription' });
    expect(await lookupDaemonTokenBuilderProfile(root, token)).toBe('codex-subscription');
    expect(await mintDaemonToken(root, { kind: 'builder' }, 'builder-aa11bb22', { builderProfile: 'codex-subscription' })).toBe(token);
    await expect(mintDaemonToken(root, { kind: 'builder' }, 'builder-aa11bb22', { builderProfile: 'claude-code' }))
      .rejects.toBeInstanceOf(BuilderProfileMismatchError);
    const legacy = await mintDaemonToken(root, { kind: 'builder' }, 'builder-cc33dd44');
    expect(await lookupDaemonTokenBuilderProfile(root, legacy)).toBeNull();
  });
});

describe('Codex builder config and container', () => {
  test('the builder prompt rides config.toml as developer_instructions', () => {
    const toml = renderCodexConfig({
      proxyBaseUrl: 'http://host.docker.internal:4000',
      mcpServer: { command: 'lazy-agent', args: ['mcp'] },
      developerInstructions: 'line one\n"quoted"',
      toolsApproval: 'prompt',
    });
    expect(toml).toContain('developer_instructions = "line one\\n\\"quoted\\""');
    expect(toml).toContain('default_tools_approval_mode = "prompt"');
    // A task turn's config is unchanged.
    expect(renderCodexConfig({ proxyBaseUrl: 'http://x', mcpServer: { command: 'c', args: [] } }))
      .not.toContain('developer_instructions');
  });

  test('a Codex builder container mounts its own CODEX_HOME and runs the codex supervisor', () => {
    const base = {
      binary: 'docker', builderId: 'b1', lazyRoot: '/repo', dataDir: '/repo/.lazy', scratchDir: '/scratch',
      containerConfigFile: '/t/c.json', agentBinaryPath: '/bin/lazy-agent', home: '/h',
      neutralCredentialStore: '/t/cred.json', mergedConfigFile: '/t/claude.json', authEnvVars: [],
      imageName: 'img', promptFile: '/t/p.txt', daemonConfigPath: '/d/mcp.json', claudeExtraArgs: [], debug: false,
    };
    const args = buildBuilderDockerArgs({ ...base, harness: 'codex', codexHome: '/h/codex-homes/b1' });
    expect(args.join(' ')).toContain('-v /h/codex-homes/b1:/home/user/.codex');
    expect(args).toContain('CODEX_HOME=/home/user/.codex');
    expect(args.join(' ')).toContain('lazy-agent builder --harness codex');
    expect(() => buildBuilderDockerArgs({ ...base, harness: 'codex' })).toThrow(/CODEX_HOME/);
    const claude = buildBuilderDockerArgs(base).join(' ');
    expect(claude).not.toContain('.codex');
    expect(claude).not.toContain('--harness');
  });
});

import { reissueRequest } from '../../src/builder/mcp-reissue';
import { resolveBuilderProfileName } from '../../src/builder/builder-profile';

describe('builder profile survives a token re-issue', () => {
  // INVARIANT: a re-issue after a daemon lost the token record carries the
  // session's profile, or the re-minted record answers for the ROLE's profile
  // and a Codex session relaunches with Claude's environment.
  test('the re-issue request names the session profile', () => {
    expect(reissueRequest('builder-aa', 'codex-subscription')).toEqual({ name: 'builder-aa', ownerPid: process.pid, profile: 'codex-subscription' });
    expect(reissueRequest('builder-aa', undefined)).toEqual({ name: 'builder-aa', ownerPid: process.pid });
  });

  test("the role's own profile is not harness-checked; an explicit pick is", () => {
    const config = {
      agents: { 'local-pi': { harness: 'pi', model: 'qwen', endpoint: 'http://localhost:11434', credential: 'none' } },
      models: { roles: { builder: { profile: 'local-pi' }, agent: { profile: 'claude-code' } } },
    } as unknown as Parameters<typeof resolveBuilderProfileName>[0];
    expect(resolveBuilderProfileName(config, 'local-pi')).toBe('local-pi');
    expect(() => resolveBuilderProfileName(config, 'cursor')).toThrow(/cannot run the builder/);
  });
});
