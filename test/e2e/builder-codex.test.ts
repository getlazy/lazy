/**
 * A Codex builder, end to end through the REAL supervisor.
 *
 * The same arrangement as builder-live-capture.test.ts — a real daemon, the real
 * `lazy-agent builder` supervisor as a subprocess (it behaves exactly as in its
 * container, it just is not in one), the real lazy MCP server — with the fake
 * `codex` binary (docs/fake-agent-binary-seam.md) standing in for the agent.
 * The fake reads its lazy MCP server out of the config.toml the supervisor
 * wrote and calls tools through it, so what is proven is the whole chain a
 * Codex builder depends on:
 *
 *   - the session's agent profile is recorded on its MCP token and the daemon
 *     answers the launch environment FOR THAT PROFILE (OpenAI placeholder,
 *     Codex proxy base) — never the builder role's Claude default;
 *   - the builder prompt reaches Codex as `developer_instructions`;
 *   - the tool surface is the BUILDER's (no agent-only tools), and the tools
 *     work: it lists tasks and writes a journal entry on one;
 *   - the native rollout is captured as a conversation with per-message usage.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeAgentBinary } from '../helpers/fake-agent-binary';
import { writeBuilderClaudeConfig } from '../helpers/builder-claude-config';
import { TURN_IDENTITY_ENV_PINS } from '../helpers/mcp-env';
import { storageDirFor } from '../helpers/storage';
import type { CodexMcpCallRecord } from '../helpers/fake-codex';
import { getWebPortPath } from '../../src/daemon/paths';
import { mintMcpToken } from '../../src/daemon/mcp-tokens';
import { lookupCredentialGrant, looksLikeLazyPlaceholder } from '../../src/proxy/credential-broker';
import { AGENT_ONLY_TOOL_NAMES } from '../../src/mcp/tool-roles';
import { MODEL_OVERRIDE_FLAG, EFFORT_OVERRIDE_FLAG } from '../../src/builder/launch-directive';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');
const SESSION_ID = '01a16c71-9006-7ad0-9fea-0da04bb48602';
const PROMPT_MARK = 'You are the lazy builder (codex e2e).';

describe('Codex builder through the real supervisor', () => {
  let ctx: TestContext;
  let home: string;
  let binDir: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeCodex: true, daemonEnv: { OPENAI_API_KEY: 'sk-test-codex-builder' } });
    home = await mkdtemp(join(tmpdir(), 'lazy-e2e-codex-builder-home-'));
    await mkdir(join(home, '.codex'), { recursive: true });
    binDir = await mkdtemp(join(tmpdir(), 'lazy-e2e-codex-builder-bin-'));
    await installFakeAgentBinary(binDir, AGENT_ENTRY);
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(home, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  // INVARIANT: a builder session runs on the profile it was started on — the
  // profile recorded on its MCP token decides the launch env the daemon hands
  // the supervisor, not [models.roles.builder]. A builder started with
  // `--agent codex-api` that came back with the role's Claude env would launch
  // Codex with no OpenAI credential, or bill the wrong one.
  test('lists tasks and writes a journal entry through its lazy tools; conversation and usage captured', async () => {
    const created = await ctx.lazy(['create', '--goal', 'Codex builder journal target', '--code', 'cx-target']);
    expect(created.exitCode).toBe(0);

    const token = await mintMcpToken(ctx.root, { kind: 'builder' }, 'builder-cx123456', { builderProfile: 'codex-api' });
    const port = (await readFile(getWebPortPath(ctx.root), 'utf-8')).trim();
    await mkdir(join(ctx.root, '.lazy', 'tmp'), { recursive: true });
    const daemonConfigPath = join(ctx.root, '.lazy', 'tmp', 'daemon-mcp-builder-cx123456.json');
    await writeFile(daemonConfigPath, JSON.stringify({ token, projectRoot: ctx.root, taskId: '', target: `http://127.0.0.1:${port}` }));
    await writeBuilderClaudeConfig(home, daemonConfigPath, ctx.root);
    const promptFile = join(ctx.root, '.lazy', 'tmp', 'codex-builder-prompt.txt');
    await writeFile(promptFile, PROMPT_MARK);
    const builderConfigPath = join(ctx.root, '.lazy', 'tmp', 'builder-cfg.json');
    await writeFile(builderConfigPath, JSON.stringify({ host: '127.0.0.1', port: 1, token: 'unused', lazyRoot: ctx.root }));

    await ctx.recordCodexEnvKeys(['OPENAI_API_KEY', 'LAZY_CODEX_API_BASE', 'CODEX_HOME']);
    await ctx.setCodexScenario({ steps: [
      {
        kind: 'mcp-call',
        recordFile: 'builder-mcp.json',
        calls: [
          { tool: 'lazy_list', arguments: {} },
          { tool: 'lazy_journal', arguments: { task_id: 'cx-target', message: 'Journal entry written by the Codex builder.' } },
        ],
      },
      { kind: 'rollout', sessionId: SESSION_ID, userText: 'list my tasks', assistantText: 'You have one task: cx-target.', inputTokens: 150, cachedInputTokens: 50, outputTokens: 12 },
    ] });

    const proc = Bun.spawn([
      'bun', 'run', AGENT_ENTRY, 'builder', '--harness', 'codex',
      '--system-prompt-file', promptFile, '--worktree', ctx.root,
      '--builder-config', builderConfigPath, '--daemon-config', daemonConfigPath,
      '--builder-id', 'cx123456',
      '--', '--dangerously-skip-permissions', '--model', 'gpt-5.5', MODEL_OVERRIDE_FLAG, '--effort', 'high', EFFORT_OVERRIDE_FLAG,
    ], {
      cwd: ctx.root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        PATH: `${binDir}:${ctx.fakeCodexBinDir}:${process.env.PATH ?? ''}`,
        ...TURN_IDENTITY_ENV_PINS,
      },
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });

    // Launched as an interactive Codex session, translated from the builder argv
    // (a TYPED --model/--effort survives the daemon's launch directive).
    const [invocation] = await ctx.codexInvocations();
    expect(invocation!.argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(invocation!.argv.join(' ')).toContain('-m gpt-5.5');
    expect(invocation!.argv).toContain('model_reasoning_effort="high"');
    expect(invocation!.argv).not.toContain('exec');

    // The credential is the codex-api profile's placeholder, never the real key.
    const placeholder = invocation!.env?.OPENAI_API_KEY;
    expect(placeholder).toBeDefined();
    expect(placeholder).not.toBe('sk-test-codex-builder');
    expect(looksLikeLazyPlaceholder(placeholder!)).toBe(true);
    expect((await lookupCredentialGrant(ctx.root, placeholder!))?.profile).toBe('codex-api');
    expect(invocation!.env?.LAZY_CODEX_API_BASE).toMatch(/^http:\/\/.*\/v1$/);

    const record = JSON.parse(await readFile(join(ctx.fakeCodexBinDir!, '..', 'builder-mcp.json'), 'utf-8')) as CodexMcpCallRecord;
    // The builder prompt rides config.toml, with the proxy provider beside it.
    expect(record.configToml).toContain(`developer_instructions = ${JSON.stringify(PROMPT_MARK)}`);
    expect(record.configToml).toContain(`base_url = ${JSON.stringify(invocation!.env!.LAZY_CODEX_API_BASE)}`);
    // The BUILDER tool surface.
    expect(record.tools).toContain('lazy_list');
    expect(record.tools).toContain('lazy_journal');
    for (const agentOnly of AGENT_ONLY_TOOL_NAMES) expect(record.tools).not.toContain(agentOnly);
    expect(record.results.map((r) => r.isError)).toEqual([false, false]);
    expect(record.results[0]!.text).toContain('cx-target');

    const shown = await ctx.lazy(['show', 'cx-target', '--json']);
    expect(shown.stdout).toContain('Journal entry written by the Codex builder.');

    // The rollout became a conversation, with per-call usage (cached input not counted twice).
    const list = await ctx.lazy(['builder', 'list']);
    expect(list.stdout).toContain(SESSION_ID.slice(0, 8));
    const conversation = JSON.parse(await readFile(join(storageDirFor(ctx.root), 'conversations', `${SESSION_ID}.json`), 'utf-8'));
    expect(conversation.messages.map((m: { text: string }) => m.text)).toEqual(['list my tasks', 'You have one task: cx-target.']);
    expect(conversation.totalUsage).toMatchObject({ inputTokens: 100, cacheReadTokens: 50, outputTokens: 12 });
  }, 120_000);
});
