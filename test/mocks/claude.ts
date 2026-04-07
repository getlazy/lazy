/**
 * Mock implementation of src/capture/claude.ts for e2e tests.
 *
 * Reads mock response from LAZY_MOCK_CLAUDE_RESPONSE env var.
 * Optionally makes real git commits when LAZY_MOCK_SHOULD_COMMIT=1.
 *
 * Must export every symbol that source files import from capture/claude.
 */

import type { AgentResponse, TokenUsage } from '../../src/types';

export interface SandboxConfig {
  worktreePath: string;
  sandboxPath: string;
}

export function checkDocker(): void {
  // No-op in tests
}

export async function ensureImage(): Promise<string> {
  // No-op in tests, return default image name
  return 'lazy-runner';
}

export function resolveImageName(_lazyRoot: string): string {
  return 'lazy-runner';
}

export async function ensureAgentBinary(): Promise<string> {
  return '/fake/path/to/lazy-agent';
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

  // Detect file permission violations (same logic as real supervisor).
  // Read protected_patterns from command.json (written by the host before launching us).
  let violations: Array<{ file: string; base_sha: string; status: string }> | undefined;
  try {
    const { readFileSync: readFs, existsSync: existsFs } = await import('fs');
    const commandPath = join(protocolDir, 'command.json');
    if (existsFs(commandPath)) {
      const cmd = JSON.parse(readFs(commandPath, 'utf-8'));
      const patterns = cmd.protected_patterns as string[] | undefined;
      if (patterns && patterns.length > 0 && preTurnSha !== 'unknown' && postWorkSha && preTurnSha !== postWorkSha) {
        const { detectViolations } = await import('../../src/supervisor/permissions');
        const detected = await detectViolations(sandbox.worktreePath, preTurnSha, postWorkSha, patterns);
        if (detected.length > 0) {
          // Simulate push-back: give the agent one chance to self-correct.
          // LAZY_MOCK_PUSHBACK_REVERTS: JSON array of file paths the agent "reverts" during push-back.

          const pushbackReverts = process.env.LAZY_MOCK_PUSHBACK_REVERTS;
          if (pushbackReverts) {
            const revertFiles = JSON.parse(pushbackReverts) as string[];
            for (const filePath of revertFiles) {
              // Revert file to its state at preTurnSha
              Bun.spawnSync(['git', 'checkout', preTurnSha, '--', filePath], { cwd: sandbox.worktreePath });
            }
            if (revertFiles.length > 0) {
              Bun.spawnSync(['git', 'commit', '-m', 'Push-back: revert unnecessary file changes'], { cwd: sandbox.worktreePath });
            }
          }

          // Re-detect violations after push-back (agent may have reverted some files)
          const postPushbackShaResult = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
            cwd: sandbox.worktreePath, stdout: 'pipe', stderr: 'pipe',
          });
          const postPushbackSha = postPushbackShaResult.exitCode === 0
            ? postPushbackShaResult.stdout.toString().trim()
            : postWorkSha;

          // Update post_work_sha in status
          status.post_work_sha = postPushbackSha;
          writeFileSync(join(protocolDir, 'status.json'), JSON.stringify(status, null, 2));

          const remaining = await detectViolations(sandbox.worktreePath, preTurnSha, postPushbackSha, patterns);
          violations = remaining.length > 0 ? remaining : undefined;
        }
      }
    }
  } catch {
    // Non-fatal: skip violation detection if it fails in tests
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

  // Write a mock response to the protocol directory so reconciliation picks it up.
  // Violations are stored in the structured field — NOT prepended to resultText.
  // The pushback response IS appended so reviewers can see the agent's justification.
  const mockResp = getMockResponse();

  let resultText = mockResp.result;
  const pushbackResponse = process.env.LAZY_MOCK_PUSHBACK_RESPONSE;
  if (pushbackResponse) {
    resultText += '\n\n---\n\n## Permission Violation Review\n\n' + pushbackResponse;
  }

  const response: Record<string, unknown> = {
    status: 'completed',
    result: resultText,
    session_id: mockResp.session_id,
    usage: mockResp.usage,
    ...(violations ? { violations, pushed_back: true } : {}),
    ...(checkExitCode !== undefined ? { check_exit_code: checkExitCode } : {}),
    ...(checkOutput !== undefined ? { check_output: checkOutput } : {}),
  };
  writeFileSync(join(protocolDir, 'response.json'), JSON.stringify(response, null, 2));
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

export function getContainerOutput(containerName: string): string | null {
  return JSON.stringify(getMockResponse());
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

// --- Token usage extraction ---

export function extractTokenUsage(response: AgentResponse): TokenUsage {
  return {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}
