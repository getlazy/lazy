/**
 * Mock implementation of src/capture/claude.ts for e2e tests.
 *
 * Reads mock response from LAZY_MOCK_CLAUDE_RESPONSE env var.
 * Optionally makes real git commits when LAZY_MOCK_SHOULD_COMMIT=1.
 *
 * Must export every symbol that source files import from capture/claude.
 */

import type { AgentResponse, TokenUsage } from '../../src/types';
// Imported, not restated: this module REPLACES src/capture/claude.ts, and a mock
// that invents its own tag shape keeps passing after the real one changes.
// src/capture/image-tag.ts is a separate module, so importing it here is not
// circular — the preload only aliases capture/claude.
import { IMAGE_TAG, IMAGE_NAME, IMAGE_MAX_AGE_DAYS, IMAGE_MAX_AGE_MS } from '../../src/capture/image-tag';
import { AGENT_SELFCHECK_SENTINEL } from '../../src/agent/binary-identity';
// Same reasoning as image-tag above: the placeholder SHAPE and the launch env
// SHAPE are production's to define, so the mock borrows both rather than
// inventing look-alikes that would drift. None of these modules imports
// capture/claude, so the preload alias cannot make them circular.
import { placeholderValueFor } from '../../src/proxy/credential-broker';
import { isCredentialEnvKey } from '../../src/utils/redact';
import {
  targetEnvVars,
  ANTHROPIC_DEFAULT_TARGET,
  LOCAL_BACKEND_CREDS,
  type ProxyAuditHints,
  type LaunchSurface,
} from '../../src/utils/role-target';
import type { LaunchIdentity } from '../../src/proxy/placeholder-env';
import type { RoleTarget } from '../../src/config/types';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, writeFile } from 'fs/promises';

export { IMAGE_TAG, IMAGE_MAX_AGE_DAYS, IMAGE_MAX_AGE_MS };
const MOCK_IMAGE_REF = `${IMAGE_NAME}:${IMAGE_TAG}`;

export interface SandboxConfig {
  worktreePath: string;
  sandboxPath: string;
}

export function checkDocker(): void {
  // No-op in tests
}

export async function ensureImage(): Promise<string> {
  // No-op in tests, return the default version-tagged image ref
  return MOCK_IMAGE_REF;
}

/**
 * Mock of `buildLazyRunnerImage` that records its options to
 * `LAZY_MOCK_BUILD_LOG` (a file path) when set, so tests can verify that
 * `--no-cache` and similar flags were passed through correctly.
 */
export async function buildLazyRunnerImage(
  options: { binary?: string; noCache?: boolean } = {}
): Promise<string[]> {
  const logPath = process.env.LAZY_MOCK_BUILD_LOG;
  if (logPath) {
    const { appendFile } = await import('fs/promises');
    await appendFile(
      logPath,
      JSON.stringify({ binary: options.binary ?? 'docker', noCache: options.noCache ?? false }) + '\n'
    );
  }
  return [MOCK_IMAGE_REF, 'lazy-runner:latest'];
}

export function resolveImageName(_lazyRoot: string): string {
  return MOCK_IMAGE_REF;
}

/**
 * Mirrors the real resolution via the REAL loader (which the preload does not
 * alias), so `lazy upgrade`'s image-source announcement prints truthful paths
 * in mocked e2e runs instead of a canned stub: LAZY_DOCKERFILE_LAZY override
 * first, else [docker].dockerfile joined to the project root.
 */
export async function resolveCustomDockerfile(lazyRoot: string): Promise<string | null> {
  const override = process.env.LAZY_DOCKERFILE_LAZY;
  if (override) {
    const { isAbsolute } = await import('path');
    return isAbsolute(override) ? override : join(lazyRoot, override);
  }
  const { loadConfig } = await import('../../src/config/loader');
  const config = await loadConfig(lazyRoot);
  if (!config.docker.dockerfile) return null;
  return join(lazyRoot, config.docker.dockerfile);
}

export function resolveImageRepository(_lazyRoot: string): { repository: string; isCustom: boolean } {
  return { repository: 'lazy-runner', isCustom: false };
}

export async function resolveImageBuildTags(_lazyRoot: string): Promise<string[]> {
  return [MOCK_IMAGE_REF, 'lazy-runner:latest'];
}

/**
 * Mock of the staged image build used by `lazy upgrade`'s background rebuild.
 * Records its options to LAZY_MOCK_BUILD_LOG (same channel as
 * buildLazyRunnerImage) so tests can assert the staging tag and --no-cache.
 */
export async function buildProjectImageToTag(
  _lazyRoot: string,
  tag: string,
  options: { binary?: string; noCache?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const logPath = process.env.LAZY_MOCK_BUILD_LOG;
  if (logPath) {
    const { appendFileSync } = await import('fs');
    appendFileSync(
      logPath,
      JSON.stringify({ stagedTag: tag, binary: options.binary ?? 'docker', noCache: options.noCache ?? false }) + '\n'
    );
  }
  return `lazy-runner:${tag}`;
}

export async function tagImage(_sourceRef: string, _targetRefs: string[], _binary?: string): Promise<void> {
  // No-op in tests — no real images exist to tag.
}

export async function removeImageTag(_ref: string, _binary?: string): Promise<boolean> {
  return true;
}

/** Mirrors the real LazyImageInfo, which src/cli/commands/doctor.ts imports as a type. */
export interface LazyImageInfo {
  ref: string;
  repository: string;
  tag: string;
  id: string;
  size: string;
}

export async function listLazyImages(): Promise<LazyImageInfo[]> {
  // Tests never have real images; doctor's stale-image report is exercised
  // against the real implementation in test/e2e/image-version-tag.test.ts.
  return [];
}

/**
 * A stand-in for the real agent binary that PASSES verifyAgentBinary().
 *
 * This used to return a path that did not exist. Callers only ever passed it to
 * Docker as a bind-mount source, so nothing noticed — until `lazy upgrade` began
 * verifying what it had just installed, at which point every upgrade test failed
 * on a file the mock had never created. The mock must produce something that
 * looks like the compiled agent (ELF magic + the selfcheck sentinel), because
 * that is what the real one produces.
 */
export async function ensureAgentBinary(): Promise<string> {
  const dir = join(tmpdir(), 'lazy-test-agent-binary');
  const path = join(dir, 'lazy-agent');
  await mkdir(dir, { recursive: true });
  const head = '\u007fELF' /* ELF magic */ + AGENT_SELFCHECK_SENTINEL + ' 0.0.0-test';
  await writeFile(path, head + 'x'.repeat(4096 - head.length), { mode: 0o755 });
  return path;
}

export function hasAuthEnv(): boolean {
  return !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
}

export function getAuthEnvVars(): Array<{ key: string; value: string }> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthToken) {
    return [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: oauthToken }];
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return [{ key: 'ANTHROPIC_API_KEY', value: apiKey }];
  }
  throw new Error(
    'Authentication required. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) or ANTHROPIC_API_KEY.'
  );
}

/**
 * Mock of the JIT-credential launch path.
 *
 * The real one mints a per-launch grant against the daemon's registry and hands
 * the launched process a PLACEHOLDER that the proxy resolves upstream. There is
 * no daemon or proxy behind the module mock, so this mints nothing — but it
 * still placeholder-izes, because the property the production function exists
 * to guarantee is 'nothing handed to a launch carries a real secret', and a
 * mock that returned the real credential would let a test assert launch env
 * that production never produces.
 *
 * It runs the result through targetEnvVars for the same reason: the address a
 * launch is handed is the proxy's, never a role's own endpoint
 * (proxy-role-upstreams), and a mock that skipped that step would let a test
 * assert a base URL production cannot emit.
 *
 * injectedCreds mirrors the real parameter: a runner holding its own agent
 * instance passes that agent's credential rather than the module-level default.
 * An ollama role has no real credential to pass — it carries the same synthetic
 * one production uses, so the proxy still gets a grant to route by.
 */
export async function getLaunchAuthEnvVars(
  _identity: LaunchIdentity,
  target?: RoleTarget,
  hints?: ProxyAuditHints,
  surface: LaunchSurface = 'container',
  injectedCreds?: Array<{ key: string; value: string }>,
): Promise<Array<{ key: string; value: string }>> {
  const resolved = target ?? ANTHROPIC_DEFAULT_TARGET;
  const real = resolved.backend === 'ollama'
    ? LOCAL_BACKEND_CREDS
    : (injectedCreds ?? getAuthEnvVars());
  const placeholders = real.map(v =>
    isCredentialEnvKey(v.key) ? { key: v.key, value: placeholderValueFor(v.key) } : v
  );
  return targetEnvVars(resolved, placeholders, surface, hints);
}

function getMockResponse(): AgentResponse {
  const envResponse = process.env.LAZY_MOCK_CLAUDE_RESPONSE;
  if (envResponse) {
    const parsed = JSON.parse(envResponse);
    return {
      result: parsed.result ?? 'Mock Claude response',
      session_id: parsed.session_id ?? 'mock-session-id-' + Date.now(),
      usage: parsed.usage ?? { input_tokens: 100, output_tokens: 200 },
    };
  }
  return {
    result: 'Default mock response',
    session_id: 'mock-session-id-default',
    usage: { input_tokens: 100, output_tokens: 200 },
  };
}

async function maybeCommit(worktreePath: string, label: string): Promise<void> {
  if (process.env.LAZY_MOCK_SHOULD_COMMIT === '1') {
    const { writeFileSync, mkdirSync } = await import('fs');
    const { join, dirname } = await import('path');
    const timestamp = Date.now();

    // If LAZY_MOCK_FILES is set, create those specific files instead of the default
    const mockFiles = process.env.LAZY_MOCK_FILES;
    if (mockFiles) {
      const files = JSON.parse(mockFiles) as Array<{ path: string; content: string; action?: 'create' | 'modify' | 'delete' }>;
      for (const file of files) {
        const fullPath = join(worktreePath, file.path);
        if (file.action === 'delete') {
          Bun.spawnSync(['git', 'rm', file.path], { cwd: worktreePath });
        } else {
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, file.content);
          Bun.spawnSync(['git', 'add', file.path], { cwd: worktreePath });
        }
      }
    } else {
      const filename = `agent-output-${timestamp}.txt`;
      writeFileSync(join(worktreePath, filename), `Mock agent output (${label})\n`);
      Bun.spawnSync(['git', 'add', filename], { cwd: worktreePath });
    }
    Bun.spawnSync(['git', 'commit', '-m', `Mock agent commit (${label})`], { cwd: worktreePath });
  }
}

// --- Synchronous (legacy) API ---

export async function runClaude(
  prompt: string,
  sandbox: SandboxConfig,
  verbose: boolean = false,
  debug: boolean = false,
  model?: string,
): Promise<AgentResponse> {
  await maybeCommit(sandbox.worktreePath, 'start');
  return getMockResponse();
}

/**
 * Mock for `runClaudeOneshot` used by `lazy report`'s map-reduce.
 *
 * The real command makes N+1 calls: one per task or non-lazy commit
 * (map phase), then one reduce. To let tests verify map+reduce wiring,
 * the mock inspects the prompt's stage marker:
 *
 *   <!-- LAZY_REPORT_STAGE: task   -->  → return `[map:task:<code>]`
 *   <!-- LAZY_REPORT_STAGE: commit -->  → return `[map:commit:<sha7>]`
 *   <!-- LAZY_REPORT_STAGE: reduce -->  → return a synthesized three-section
 *       markdown whose lead tier echoes every unit summary the reduce saw,
 *       so tests can grep stdout for the expected `[map:task:*]` /
 *       `[map:commit:*]` markers. If `LAZY_MOCK_CLAUDE_RESPONSE` is set,
 *       its `result` overrides this synthesis (lets older tests pin the
 *       final body verbatim).
 *
 * Two extra knobs for new tests:
 *   LAZY_MOCK_FAIL_KEYWORD       — if the prompt contains this substring,
 *                                   the mock throws (simulates a map
 *                                   failure that the reduce must survive).
 *   No marker present            — falls through to the default
 *                                   `LAZY_MOCK_CLAUDE_RESPONSE` behavior,
 *                                   matching the non-report callers.
 */
export async function runClaudeOneshot(
  prompt: string,
  _model?: string,
  opts: { readOnly?: boolean } = {},
): Promise<AgentResponse> {
  // --- Conversation ask (`lazy ask <conversation-id>`, lazy_conversation_ask) ---
  //
  // Same stage-marker dispatch as the report mock below, on its own markers.
  // The `[ro]` suffix echoes whether the caller asked for a read-only one-shot,
  // so a test can assert the lockdown is requested without spawning an agent.
  //
  //   LAZY_MOCK_CONV_ASK_IRRELEVANT — comma-separated 1-based excerpt indexes
  //                                   whose map pass returns NOTHING_RELEVANT.
  {
    const ro = opts.readOnly ? '[ro]' : '';
    if (prompt.includes('LAZY_CONV_ASK_STAGE: single')) {
      const q = prompt.match(/## Question\n\n([^\n]*)/)?.[1] ?? '';
      return {
        result: `[conv-ask:single]${ro} mocked answer to: ${q}`,
        session_id: 'mock-conv-ask',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
    if (prompt.includes('LAZY_CONV_ASK_STAGE: map')) {
      const idx = prompt.match(/## Excerpt (\d+) of (\d+)/)?.[1] ?? '?';
      const failKeyword = process.env.LAZY_MOCK_FAIL_KEYWORD;
      if (failKeyword && prompt.includes(failKeyword)) {
        throw new Error('mock claude failure (sentinel matched)');
      }
      const irrelevant = (process.env.LAZY_MOCK_CONV_ASK_IRRELEVANT ?? '')
        .split(',').map(s => s.trim()).filter(Boolean);
      if (irrelevant.includes(idx)) {
        return { result: 'NOTHING_RELEVANT', session_id: `mock-conv-map-${idx}`, usage: { input_tokens: 1, output_tokens: 1 } };
      }
      return {
        result: `[conv-ask:map:${idx}]${ro} mocked finding from excerpt ${idx}.`,
        session_id: `mock-conv-map-${idx}`,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
    if (prompt.includes('LAZY_CONV_ASK_STAGE: reduce')) {
      const markers = Array.from(prompt.matchAll(/\[conv-ask:map:(\d+)\]/g)).map(mm => `[conv-ask:map:${mm[1]}]`);
      return {
        result: `[conv-ask:reduce]${ro} mocked answer from ${markers.length} excerpt(s): ${markers.join(' ')}`,
        session_id: 'mock-conv-reduce',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
  }

  // Only fail at map stages — the reduce prompt may legitimately echo the
  // failure keyword in the failed-units list, and we don't want that to
  // cascade into a reduce failure too.
  const failKw = process.env.LAZY_MOCK_FAIL_KEYWORD;
  const isMap = prompt.includes('LAZY_REPORT_STAGE: task') || prompt.includes('LAZY_REPORT_STAGE: commit');
  if (failKw && isMap && prompt.includes(failKw)) {
    throw new Error(`mock claude failure (sentinel matched)`);
  }

  if (prompt.includes('LAZY_REPORT_STAGE: task')) {
    // Extract the task display id from the bundle header
    // `### Task <code> — <goal>`.
    const m = prompt.match(/### Task ([^\s—]+)/);
    const code = m ? m[1] : 'unknown';
    return {
      result: `[map:task:${code}] mocked lead-tier summary for task ${code}.`,
      session_id: `mock-task-${code}`,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  if (prompt.includes('LAZY_REPORT_STAGE: commit')) {
    // Extract the short SHA from `### Commit <sha7> on main`.
    const m = prompt.match(/### Commit ([0-9a-f]{7,40}) on main/);
    const sha = m ? m[1].slice(0, 7) : 'unknown';
    return {
      result: `[map:commit:${sha}] mocked lead-tier summary for commit ${sha}.`,
      session_id: `mock-commit-${sha}`,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  // Memory compaction (`lazy memory compact`, LLM path). Deterministic and
  // deliberately TINY so the real "a compact must be smaller than the index it
  // replaces" guard is satisfied: one line naming every record in backticks.
  //
  //   LAZY_MOCK_COMPACT_FAIL=1        — throw (exercises the mechanical fallback)
  //   LAZY_MOCK_COMPACT_RESPONSE=...  — return this verbatim (used to exercise the
  //                                     omitted-name repair path with a summary
  //                                     that skips names on purpose)
  if (prompt.includes('LAZY_MEMORY_COMPACT')) {
    if (process.env.LAZY_MOCK_COMPACT_FAIL === '1') {
      throw new Error('mock claude failure (memory compaction)');
    }
    const override = process.env.LAZY_MOCK_COMPACT_RESPONSE;
    if (override !== undefined) {
      return { result: override, session_id: 'mock-compact', usage: { input_tokens: 1, output_tokens: 1 } };
    }
    const names = Array.from(prompt.matchAll(/^### `([a-z0-9-]+)`/gm)).map(mm => mm[1]);
    return {
      result: `## Mocked memory summary\n\n- ${names.map(n => `\`${n}\``).join(', ')}`,
      session_id: 'mock-compact',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  if (prompt.includes('LAZY_REPORT_STAGE: reduce')) {
    // Always synthesize for the reduce stage — tests that need the
    // synthesized body to be observable shouldn't have to fight the
    // harness's default `LAZY_MOCK_CLAUDE_RESPONSE`. The synthesis
    // echoes every `[map:...]` marker from the units block so tests
    // can verify map outputs flow into the reduce input.
    const markers = Array.from(prompt.matchAll(/\[map:(task|commit):([^\]]+)\]/g))
      .map(mm => `[map:${mm[1]}:${mm[2]}]`);
    const leadBody = markers.length > 0
      ? markers.map(m => `- ${m}`).join('\n')
      : 'Nothing of note in this window.';
    const result = [
      '## Brief',
      '',
      `Mocked digest covering ${markers.length} unit(s).`,
      '',
      '## For the engineering manager',
      '',
      '- Mocked manager-tier bullet.',
      '',
      '## For the engineering lead',
      '',
      leadBody,
    ].join('\n');
    return {
      result,
      session_id: 'mock-reduce',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  return getMockResponse();
}

export async function resumeClaude(
  claudeSessionId: string,
  prompt: string,
  sandbox: SandboxConfig,
  verbose: boolean = false,
  debug: boolean = false,
  model?: string,
): Promise<AgentResponse> {
  await maybeCommit(sandbox.worktreePath, 'resume');
  return getMockResponse();
}

// --- Async (detached container) API ---

export async function launchClaudeAsync(
  prompt: string,
  sandbox: SandboxConfig,
  containerName: string,
  debug: boolean = false,
  model?: string,
): Promise<void> {
  // In mock mode, we do the work synchronously (make commits if requested)
  // since there's no actual container to poll
  await maybeCommit(sandbox.worktreePath, 'async-start');
}

export async function resumeClaudeAsync(
  claudeSessionId: string,
  prompt: string,
  sandbox: SandboxConfig,
  containerName: string,
  debug: boolean = false,
  model?: string,
): Promise<void> {
  await maybeCommit(sandbox.worktreePath, 'async-resume');
}

// --- Supervisor API ---

/**
 * The launch settings the host asked for, echoed onto a response exactly as the
 * real supervisor does (`launchSettings` in src/supervisor/index.ts): `model` is
 * the resolved value the host put in the command, `effort` the resolved effort.
 *
 * Deliberately NO `model_id`. This seam runs no agent, so nothing here ever
 * learns a concrete model id — emitting a synthetic one would let a test pass on
 * a value production never produces. Concrete-id coverage belongs to the fake-
 * binary seam, where a real agent process reports it.
 */
function launchSettingsFromCommand(cmd: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof cmd.model_id === 'string' && cmd.model_id ? { model: cmd.model_id } : {}),
    ...(typeof cmd.effort === 'string' && cmd.effort ? { effort: cmd.effort } : {}),
  };
}

/** Read the command the host wrote, or `{}` when there is none to read. */
async function readCommand(protocolDir: string): Promise<Record<string, unknown>> {
  const { readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');
  const commandPath = join(protocolDir, 'command.json');
  if (!existsSync(commandPath)) return {};
  try {
    return JSON.parse(readFileSync(commandPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`mock supervisor: failed to parse ${commandPath}: ${(err as Error).message}`);
  }
}

/**
 * Mock of the supervisor's pre-accept handler. The mock agent optionally commits
 * (LAZY_MOCK_SHOULD_COMMIT), then the gate commands are re-run authoritatively —
 * exactly like the real handlePreAcceptCommand. Writes a single CompletedResponse
 * with the `pre_accept` gate outcome.
 */
async function handleMockPreAccept(
  sandbox: SandboxConfig,
  protocolDir: string,
  cmd: Record<string, unknown>,
  preTurnSha: string,
): Promise<void> {
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');
  const { truncateLog } = await import('../../src/utils/log-truncate');

  // Mock agent "work" (fixes / CHANGELOG / post-mortem) — commit if configured.
  await maybeCommit(sandbox.worktreePath, 'pre-accept');

  const postWorkShaResult = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
  });
  const postWorkSha = postWorkShaResult.exitCode === 0
    ? postWorkShaResult.stdout.toString().trim()
    : preTurnSha;

  // Authoritative gate: run each configured command in order, stop at first failure.
  const commands = (cmd.pre_accept_commands as string[] | undefined) ?? [];
  let preAccept: Record<string, unknown> = { passed: true };
  for (const command of commands) {
    const r = Bun.spawnSync(['sh', '-c', command], {
      cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
    });
    if (r.exitCode !== 0) {
      const out = (r.stderr?.toString() ?? '') + (r.stdout?.toString() ?? '');
      preAccept = { passed: false, failed_command: command, exit_code: r.exitCode, output: truncateLog(out) };
      break;
    }
  }

  const mockResp = getMockResponse();
  mkdirSync(protocolDir, { recursive: true });
  writeFileSync(join(protocolDir, 'status.json'), JSON.stringify({
    phase: 'work_done',
    task_id: cmd.task_id ?? 'mock-task',
    command_type: 'pre_accept',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pre_turn_sha: preTurnSha,
    post_work_sha: postWorkSha,
    pid: process.pid,
  }, null, 2));

  const response: Record<string, unknown> = {
    status: 'completed',
    result: process.env.LAZY_MOCK_PRE_ACCEPT_RESPONSE ?? mockResp.result,
    session_id: mockResp.session_id,
    usage: mockResp.usage,
    start_sha_work: preTurnSha,
    end_sha_work: postWorkSha,
    pre_accept: preAccept,
    ...launchSettingsFromCommand(cmd),
  };
  writeFileSync(join(protocolDir, 'response.json'), JSON.stringify(response, null, 2));
}

export async function launchSupervisorAsync(
  sandbox: SandboxConfig,
  containerName: string,
  protocolDir: string,
  debug: boolean = false,
): Promise<void> {
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');

  // Capture pre-turn SHA (HEAD before any work)
  const preTurnShaResult = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
  });
  const preTurnSha = preTurnShaResult.exitCode === 0
    ? preTurnShaResult.stdout.toString().trim()
    : 'unknown';

  // Launch settings the host asked for — echoed onto every response this
  // invocation writes, exactly as the real supervisor does.
  const launchSettings = launchSettingsFromCommand(await readCommand(protocolDir));

  // Pre-accept turn: a WRITE turn (mock agent may commit) followed by the
  // AUTHORITATIVE gate re-run. Mirrors src/supervisor/index.ts#handlePreAcceptCommand:
  // a single CompletedResponse carrying `pre_accept`, not a start-style bundle.
  {
    const cmd = await readCommand(protocolDir);
    if (cmd.type === 'pre_accept') {
      await handleMockPreAccept(sandbox, protocolDir, cmd, preTurnSha);
      return;
    }
  }

  // In mock mode, simulate the supervisor: make commits, then write response.json
  await maybeCommit(sandbox.worktreePath, 'supervisor');

  // Capture post-work SHA (HEAD after agent's work, before any post-turn sync)
  const postWorkShaResult = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
  });
  const postWorkSha = postWorkShaResult.exitCode === 0
    ? postWorkShaResult.stdout.toString().trim()
    : undefined;

  // If LAZY_MOCK_PLAN_CONTENT is set, simulate Claude Code writing a plan file
  // to the sandbox's .claude/plans/ directory (as Claude Code does in plan mode)
  const planContent = process.env.LAZY_MOCK_PLAN_CONTENT;
  if (planContent) {
    const plansDir = join(sandbox.sandboxPath, '.claude', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'plan.md'), planContent);
  }

  // Write supervisor status with SHAs so reconciliation can record per-turn diffs
  mkdirSync(protocolDir, { recursive: true });
  const status: Record<string, unknown> = {
    phase: 'work_done',
    task_id: 'mock-task',
    command_type: 'start',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pre_turn_sha: preTurnSha,
    post_work_sha: postWorkSha,
    pid: process.pid,
  };
  writeFileSync(join(protocolDir, 'status.json'), JSON.stringify(status, null, 2));

  // Per-invocation responses for the bundle. responses[0] is the WORK response;
  // supervised follow-ups (push-back, maintain) append after it as FULL responses
  // with their own SHA window + usage (incl. cache) + (for push-back) violation set.
  // Mirrors src/supervisor/index.ts. Synthetic non-zero cache tokens on supervised
  // responses let tests assert cache usage lands per supervised turn.
  const supervised: Array<Record<string, unknown>> = [];
  const SUPERVISED_USAGE = {
    input_tokens: 50, output_tokens: 20,
    cache_creation_input_tokens: 30, cache_read_input_tokens: 40,
  };
  let lastSha = postWorkSha;
  // Final remaining violations across the exchange (set by push-back re-detection).
  let finalViolations: Array<{ file: string; base_sha: string; status: string }> = [];
  let pushbackTriggered = false;

  // Detect file permission violations (same logic as real supervisor).
  // Read protected_patterns from command.json (written by the host before launching us).
  try {
    const { readFileSync: readFs, existsSync: existsFs } = await import('fs');
    const commandPath = join(protocolDir, 'command.json');
    if (existsFs(commandPath)) {
      const cmd = JSON.parse(readFs(commandPath, 'utf-8'));
      const patterns = cmd.protected_patterns as string[] | undefined;
      if (patterns && patterns.length > 0 && preTurnSha !== 'unknown' && postWorkSha && preTurnSha !== postWorkSha) {
        const { detectViolations } = await import('../../src/supervisor/permissions');

        // Compute the branch point exactly as the real supervisor does
        // (src/supervisor/index.ts): merge-base with the parent branch, with
        // cmd.branch_point_sha as the fallback. Files that did not exist at
        // that point were created by the task and are EXEMPT from violations.
        // Omitting it here made the mock flag task-created files that the real
        // supervisor exempts.
        let branchPointSha: string | undefined = cmd.branch_point_sha;
        if (cmd.parent_branch) {
          const mergeBase = Bun.spawnSync(['git', 'merge-base', cmd.parent_branch, 'HEAD'], {
            cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
          });
          if (mergeBase.exitCode === 0 && mergeBase.stdout.toString().trim()) {
            branchPointSha = mergeBase.stdout.toString().trim();
          }
        }

        const detected = await detectViolations(sandbox.worktreePath, preTurnSha, postWorkSha, patterns, branchPointSha);
        if (detected.length > 0) {
          pushbackTriggered = true;
          // Simulate push-back: give the agent one chance to self-correct.
          // LAZY_MOCK_PUSHBACK_REVERTS: JSON array of file paths the agent "reverts".
          const pushbackReverts = process.env.LAZY_MOCK_PUSHBACK_REVERTS;
          if (pushbackReverts) {
            const revertFiles = JSON.parse(pushbackReverts) as string[];
            for (const filePath of revertFiles) {
              Bun.spawnSync(['git', 'checkout', preTurnSha, '--', filePath], { cwd: sandbox.worktreePath });
            }
            if (revertFiles.length > 0) {
              Bun.spawnSync(['git', 'commit', '-m', 'Push-back: revert unnecessary file changes'], { cwd: sandbox.worktreePath });
            }
          }

          // Re-detect violations after push-back (agent may have reverted some files).
          const postPushbackShaResult = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
            cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
          });
          const postPushbackSha = postPushbackShaResult.exitCode === 0
            ? postPushbackShaResult.stdout.toString().trim()
            : postWorkSha;

          // INVARIANT: status.post_work_sha stays pinned at the WORK end — NOT
          // advanced past push-back commits (no double-count on the work turn).
          finalViolations = await detectViolations(sandbox.worktreePath, preTurnSha, postPushbackSha, patterns, branchPointSha);

          // The push-back is a FULL response: its own SHA window + usage + the
          // FINAL violation set (empty array when resolved). LAZY_MOCK_PUSHBACK_RESPONSE
          // supplies the agent's justification text.
          const pushbackResponse = process.env.LAZY_MOCK_PUSHBACK_RESPONSE
            ?? 'Mock agent: reviewed the protected-file changes.';
          supervised.push({
            status: 'completed',
            result: pushbackResponse,
            session_id: 'mock-sess-pushback',
            usage: { ...SUPERVISED_USAGE },
            start_sha_work: lastSha,
            end_sha_work: postPushbackSha,
            violations: finalViolations,
            ...launchSettings,
            supervised: { kind: 'permission_pushback', prompt: 'Mock push-back prompt: you modified protected file(s). Revert or justify.' },
          });
          lastSha = postPushbackSha;
        }
      }
    }
  } catch {
    // Non-fatal: skip violation detection if it fails in tests
  }

  // Maintained-file skip check (mirrors src/supervisor/index.ts).
  // PRECEDENCE INVARIANT (maintain-nudge-violation-precedence): the maintain nudge
  // runs AFTER the push-back exchange and is INDEPENDENT of its outcome — it is NOT
  // gated on `finalViolations.length === 0`. It appends after the push-back response
  // (start_sha_work = lastSha, which advanced to the post-push-back SHA) and never
  // re-triggers push-back (push-back is single-shot above). The maintain response
  // carries NO `violations` field, so the reconciler's final-violation lookup still
  // reads the push-back set and a still-violating turn stays `conflict`.
  try {
    const { readFileSync: readFs, existsSync: existsFs } = await import('fs');
    const commandPath = join(protocolDir, 'command.json');
    if (existsFs(commandPath)) {
      const cmd = JSON.parse(readFs(commandPath, 'utf-8'));
      const maintain = cmd.maintain as Array<{ title: string; pattern: string; instructions: string }> | undefined;
      if (maintain && maintain.length > 0 && preTurnSha !== 'unknown') {
        const currentShaResult = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
          cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
        });
        const currentSha = currentShaResult.exitCode === 0
          ? currentShaResult.stdout.toString().trim()
          : preTurnSha;
        const { detectSkippedMaintainEntries } = await import('../../src/supervisor/maintain');
        const { skipped } = await detectSkippedMaintainEntries(sandbox.worktreePath, preTurnSha, currentSha, maintain);
        if (skipped.length > 0) {
          const response = process.env.LAZY_MOCK_MAINTAIN_RESPONSE
            ?? 'Mock agent: reviewed the skipped maintained files.';
          supervised.push({
            status: 'completed',
            result: response,
            session_id: 'mock-sess-maintain',
            usage: { ...SUPERVISED_USAGE },
            start_sha_work: lastSha,
            end_sha_work: currentSha,
            ...launchSettings,
            supervised: { kind: 'maintain', prompt: `Mock maintain nudge: you skipped ${skipped.map(s => s.title).join(', ')}. Update or justify.` },
          });
          lastSha = currentSha;
        }
      }
    }
  } catch {
    // Non-fatal: skip maintained-file check if it fails in tests
  }

  // Post-turn check: if the command has post_turn_check, run it and capture result
  let checkExitCode: number | undefined;
  let checkOutput: string | undefined;
  try {
    const { readFileSync: readFs, existsSync: existsFs } = await import('fs');
    const { truncateLog } = await import('../../src/utils/log-truncate');
    const commandPath = join(protocolDir, 'command.json');
    if (existsFs(commandPath)) {
      const cmd = JSON.parse(readFs(commandPath, 'utf-8'));
      const postTurnCheck = cmd.post_turn_check as string | undefined;
      if (postTurnCheck) {
        const checkResult = Bun.spawnSync(['sh', '-c', postTurnCheck], {
          cwd: sandbox.worktreePath,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        checkExitCode = checkResult.exitCode;
        const stderr = checkResult.stderr?.toString() ?? '';
        checkOutput = truncateLog(stderr);
      }
    }
  } catch {
    // Non-fatal: skip check execution if it fails in tests
  }

  // Build the completed bundle: work response (clean) + supervised follow-ups.
  // The work response carries turn-level outputs (post-turn check) and `pushed_back`
  // metadata but NOT violations — those live on the push-back response.
  const mockResp = getMockResponse();
  const workResponse: Record<string, unknown> = {
    status: 'completed',
    result: mockResp.result,
    session_id: mockResp.session_id,
    usage: mockResp.usage,
    ...launchSettings,
    ...(pushbackTriggered ? { pushed_back: true } : {}),
    ...(checkExitCode !== undefined ? { check_exit_code: checkExitCode } : {}),
    ...(checkOutput !== undefined ? { check_output: checkOutput } : {}),
  };

  const bundle: Record<string, unknown> = {
    status: 'completed',
    responses: [workResponse, ...supervised],
  };
  writeFileSync(join(protocolDir, 'response.json'), JSON.stringify(bundle, null, 2));
}

// --- Container management ---

export interface ContainerInfo {
  running: boolean;
  exitCode: number;
  finishedAt: string | null;
}

export function isContainerRunning(containerName: string): boolean {
  return false; // No containers in tests
}

export function containerExists(containerName: string): boolean {
  return false;
}

export function getContainerExitCode(containerName: string): number | null {
  return 0; // Simulate successful exit
}

/**
 * Mock container info. When LAZY_MOCK_CRASHED_CONTAINERS is set to a comma-separated
 * list of container names, those containers are reported as crashed (stopped with exit 139).
 * When LAZY_MOCK_CONTAINER_EXIT_CODE is set, uses that exit code instead of 139.
 */
export function getContainerInfo(containerName: string): ContainerInfo | null {
  const crashedContainers = process.env.LAZY_MOCK_CRASHED_CONTAINERS;
  if (crashedContainers) {
    const names = crashedContainers.split(',').map(s => s.trim());
    if (names.includes(containerName)) {
      const exitCode = parseInt(process.env.LAZY_MOCK_CONTAINER_EXIT_CODE ?? '139', 10);
      return {
        running: false,
        exitCode,
        finishedAt: new Date(Date.now() - 37 * 60 * 1000).toISOString(), // 37 minutes ago
      };
    }
  }
  return null; // Container doesn't exist
}

export function getContainerLogs(containerName: string, tailLines: number = 50): string | null {
  return 'Mock container logs for testing';
}

export function removeContainer(containerName: string): void {
  // No-op in tests
}

export function containerNameForTask(taskShortId: string): string {
  return `lazy-${taskShortId}`;
}

// --- Dockerfile hash ---

export function calculateDockerfileHash(_lazyRoot: string): string {
  return 'mock-dockerfile-hash';
}

// Mirror the real module's re-export (consumed by `lazy system export-dockerfile`).
// The mock replaces capture/claude entirely under LAZY_TEST, so every symbol the
// source imports must be present here or module resolution fails CLI-wide.
export const DEFAULT_DOCKERFILE = '# mock Dockerfile\n';

// --- Token usage extraction ---

export function extractTokenUsage(response: AgentResponse): TokenUsage {
  return {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}
