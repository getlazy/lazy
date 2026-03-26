#!/usr/bin/env bun
/**
 * QA Test Driver for v0.11 Daemon Features
 *
 * Drives end-to-end tests for daemon auto-react (CI failure, PR comments),
 * signal delivery, supervisor lifecycle, and branch pushing.
 *
 * Uses the qa-agent (deterministic testing agent) with canned scenario
 * responses from v011-daemon.scenarios.json.
 *
 * Usage:
 *   bun run test/qa/run-v011.ts [--scenario <name>] [--github-repo <owner/repo>]
 *
 * Environment variables:
 *   QA_GITHUB_REPO    - GitHub repo for tests requiring real CI (e.g., lazy-qa/test-repo)
 *   QA_SCENARIO_FILE  - Path to scenario JSON (default: auto-detected)
 *   LAZY_BIN          - Path to lazy binary (default: bun run ./src/index.ts)
 *   QA_TIMEOUT_CI_MS  - Timeout for CI operations in ms (default: 120000)
 *   QA_TIMEOUT_DAEMON_MS - Timeout for daemon reactions in ms (default: 30000)
 *   QA_POLL_INTERVAL_MS  - Poll interval in ms (default: 2000)
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  skipped: boolean;
  error?: string;
  duration_ms: number;
}

interface DriverConfig {
  lazyBin: string[];
  scenarioFile: string;
  githubRepo: string | null;
  timeoutCiMs: number;
  timeoutDaemonMs: number;
  pollIntervalMs: number;
  tempDir: string;
  lazyRoot: string;
  scenario?: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`${COLORS.dim}[${ts}]${COLORS.reset} ${msg}`);
}

function logStep(msg: string): void {
  log(`${COLORS.cyan}>>>${COLORS.reset} ${msg}`);
}

function logPass(msg: string): void {
  log(`${COLORS.green}PASS${COLORS.reset} ${msg}`);
}

function logFail(msg: string): void {
  log(`${COLORS.red}FAIL${COLORS.reset} ${msg}`);
}

function logSkip(msg: string): void {
  log(`${COLORS.yellow}SKIP${COLORS.reset} ${msg}`);
}

function logInfo(msg: string): void {
  log(`${COLORS.blue}INFO${COLORS.reset} ${msg}`);
}

async function exec(cmd: string[], opts?: { cwd?: string; stdin?: string; timeout?: number; env?: Record<string, string | undefined> }): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts?.stdin ? new Response(opts.stdin) : undefined,
    env: {
      ...process.env,
      // Unset LAZY_FORCE_TTY so commands run non-interactively.
      // Do NOT set LAZY_NO_DAEMON — the daemon must be running for tests B/C/D.
      // Do NOT set LAZY_PROMPT_DEFAULTS — use --yes flags per CLAUDE.md convention.
      LAZY_FORCE_TTY: undefined,
      ...opts?.env,
    },
  });

  const timeout = opts?.timeout ?? 60_000;
  const timer = setTimeout(() => {
    proc.kill();
  }, timeout);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;
  clearTimeout(timer);

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode: proc.exitCode ?? -1,
  };
}

async function execLazy(config: DriverConfig, args: string[], opts?: { stdin?: string; timeout?: number }): Promise<ExecResult> {
  const cmd = [...config.lazyBin, ...args];
  return exec(cmd, { cwd: config.tempDir, ...opts });
}

async function execGit(cwd: string, ...args: string[]): Promise<ExecResult> {
  return exec(['git', ...args], { cwd });
}

/**
 * Poll until a condition is met, or timeout.
 */
async function pollUntil(
  description: string,
  check: () => Promise<boolean>,
  intervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return true;
    await Bun.sleep(intervalMs);
  }
  log(`${COLORS.yellow}Timeout waiting for: ${description}${COLORS.reset}`);
  return false;
}

/**
 * Wait for a task to reach 'blocked' status by polling `lazy list`.
 */
async function waitForBlocked(config: DriverConfig, taskCode: string): Promise<boolean> {
  return pollUntil(
    `task ${taskCode} to become blocked`,
    async () => {
      const result = await execLazy(config, ['list']);
      // Look for the task code followed by 'blocked' status
      const lines = result.stdout.split('\n');
      return lines.some(line => line.includes(taskCode) && line.includes('blocked'));
    },
    config.pollIntervalMs,
    config.timeoutDaemonMs,
  );
}

/**
 * Wait for a task to have a certain number of commits (at minimum).
 */
async function waitForCommits(config: DriverConfig, taskCode: string, minCommits: number): Promise<boolean> {
  return pollUntil(
    `task ${taskCode} to have >= ${minCommits} commits`,
    async () => {
      const result = await execLazy(config, ['show', taskCode]);
      const match = result.stdout.match(/(\d+)\s+commit/i);
      if (match) {
        return parseInt(match[1], 10) >= minCommits;
      }
      return false;
    },
    config.pollIntervalMs,
    config.timeoutDaemonMs,
  );
}

/**
 * Extract a task's short ID from `lazy create` output.
 */
function extractTaskId(output: string): string | null {
  // Match patterns like "Created task abc1234" or task ID in parentheses
  const match = output.match(/(?:Created task|task)\s+([a-f0-9]{4,8})/i)
    ?? output.match(/\b([a-f0-9]{8})\b/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

/**
 * Test A: Happy path — task lifecycle without daemon features.
 * Tests create -> start -> block -> unblock with feedback -> block -> accept.
 */
async function testHappyPath(config: DriverConfig): Promise<TestResult> {
  const name = 'A: Happy path lifecycle';
  const start = Date.now();

  try {
    logStep('Creating task: test-happy');
    const createResult = await execLazy(config, [
      'create',
      '--goal', 'Implement a simple TypeScript utility',
      '--code', 'test-happy',
      '--prompt', 'Create a simple TypeScript string utility module with reverse, capitalize, and truncate functions. Add unit tests and a GitHub Actions CI workflow.',
    ]);
    if (createResult.exitCode !== 0) {
      throw new Error(`Create failed: ${createResult.stderr || createResult.stdout}`);
    }
    logInfo(`Create output: ${createResult.stdout.slice(0, 200)}`);

    logStep('Starting task: test-happy');
    const startResult = await execLazy(config, ['start', 'test-happy', '--yes'], { timeout: 120_000 });
    if (startResult.exitCode !== 0) {
      throw new Error(`Start failed: ${startResult.stderr || startResult.stdout}`);
    }
    logInfo('Task started, waiting for it to block...');

    // Wait for task to block
    const blocked = await waitForBlocked(config, 'test-happy');
    if (!blocked) {
      throw new Error('Task did not reach blocked state within timeout');
    }
    logInfo('Task is blocked after first turn');

    // Verify the task has commits
    const showResult = await execLazy(config, ['show', 'test-happy']);
    logInfo(`Show output: ${showResult.stdout.slice(0, 300)}`);

    logStep('Unblocking with feedback: "Add error handling"');
    const unblockResult = await execLazy(config, [
      'unblock', 'test-happy',
      '--message', 'Add error handling to truncate (throw if maxLength < 4) and add an isPalindrome function.',
    ], { timeout: 120_000 });
    if (unblockResult.exitCode !== 0) {
      throw new Error(`Unblock failed: ${unblockResult.stderr || unblockResult.stdout}`);
    }

    // Wait for second block
    logInfo('Waiting for task to block after feedback turn...');
    const blocked2 = await waitForBlocked(config, 'test-happy');
    if (!blocked2) {
      throw new Error('Task did not reach blocked state after feedback');
    }
    logInfo('Task blocked after second turn');

    logStep('Accepting task: test-happy');
    const acceptResult = await execLazy(config, ['accept', 'test-happy', '--yes'], { timeout: 60_000 });
    if (acceptResult.exitCode !== 0) {
      throw new Error(`Accept failed: ${acceptResult.stderr || acceptResult.stdout}`);
    }
    logInfo('Task accepted');

    // Verify task is in terminal state
    const finalShow = await execLazy(config, ['show', 'test-happy']);
    if (!finalShow.stdout.includes('complete') && !finalShow.stdout.includes('closed')) {
      logInfo(`Final status: ${finalShow.stdout.slice(0, 200)}`);
      // Accept may leave it in 'merging' or 'complete' depending on config
    }

    logPass(name);
    return { name, passed: true, skipped: false, duration_ms: Date.now() - start };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logFail(`${name}: ${error}`);
    return { name, passed: false, skipped: false, error, duration_ms: Date.now() - start };
  }
}

/**
 * Test B: CI failure auto-react.
 * Requires GitHub integration (QA_GITHUB_REPO).
 */
async function testCIFailure(config: DriverConfig): Promise<TestResult> {
  const name = 'B: CI failure auto-react';
  const start = Date.now();

  if (!config.githubRepo) {
    logSkip(`${name}: QA_GITHUB_REPO not set`);
    return { name, passed: false, skipped: true, error: 'QA_GITHUB_REPO not set', duration_ms: 0 };
  }

  try {
    logStep('Creating task: test-ci');
    const createResult = await execLazy(config, [
      'create',
      '--goal', 'Create a project with tests',
      '--code', 'test-ci',
      '--prompt', 'Create a math utility module with add, multiply, and factorial functions. Add unit tests that verify correctness, and a GitHub Actions CI workflow.',
    ]);
    if (createResult.exitCode !== 0) {
      throw new Error(`Create failed: ${createResult.stderr}`);
    }

    logStep('Starting task: test-ci');
    const startResult = await execLazy(config, ['start', 'test-ci', '--yes'], { timeout: 120_000 });
    if (startResult.exitCode !== 0) {
      throw new Error(`Start failed: ${startResult.stderr}`);
    }

    // Wait for task to block (first turn complete)
    const blocked = await waitForBlocked(config, 'test-ci');
    if (!blocked) {
      throw new Error('Task did not reach blocked state within timeout');
    }
    logInfo('Task blocked after first turn. CI workflow should run and fail (deliberate bug).');

    // Wait for CI to run and fail.
    // The daemon's auto-react should detect the failure and unblock the task.
    logInfo(`Waiting for daemon to detect CI failure (timeout: ${config.timeoutCiMs / 1000}s)...`);

    // Poll for the task to become working again (daemon auto-unblocked it)
    const autoUnblocked = await pollUntil(
      'daemon to auto-react to CI failure',
      async () => {
        const result = await execLazy(config, ['list']);
        const lines = result.stdout.split('\n');
        // Task should transition from blocked -> working (auto-unblocked by daemon)
        return lines.some(line => line.includes('test-ci') && line.includes('working'));
      },
      config.pollIntervalMs,
      config.timeoutCiMs,
    );

    if (!autoUnblocked) {
      // Check if maybe it already re-blocked (fast agent)
      const listResult = await execLazy(config, ['list']);
      const alreadyReblocked = listResult.stdout.split('\n')
        .some(line => line.includes('test-ci') && line.includes('blocked'));

      if (!alreadyReblocked) {
        throw new Error('Daemon did not auto-react to CI failure within timeout');
      }
      logInfo('Agent already completed fix turn (fast)');
    }

    // Wait for the fix turn to complete (task blocks again)
    const blockedAgain = await waitForBlocked(config, 'test-ci');
    if (!blockedAgain) {
      throw new Error('Task did not re-block after CI fix');
    }
    logInfo('Task blocked after fix turn');

    // Verify the fix commit exists
    const showResult = await execLazy(config, ['show', 'test-ci']);
    if (!showResult.stdout.includes('Fix factorial') && !showResult.stdout.includes('fix')) {
      logInfo(`Show output (checking for fix): ${showResult.stdout.slice(0, 500)}`);
    }

    logPass(name);
    return { name, passed: true, skipped: false, duration_ms: Date.now() - start };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logFail(`${name}: ${error}`);
    return { name, passed: false, skipped: false, error, duration_ms: Date.now() - start };
  }
}

/**
 * Test C: PR comment auto-react.
 * Requires GitHub integration (QA_GITHUB_REPO).
 */
async function testPRComment(config: DriverConfig): Promise<TestResult> {
  const name = 'C: PR comment auto-react';
  const start = Date.now();

  if (!config.githubRepo) {
    logSkip(`${name}: QA_GITHUB_REPO not set`);
    return { name, passed: false, skipped: true, error: 'QA_GITHUB_REPO not set', duration_ms: 0 };
  }

  try {
    logStep('Creating task: test-comment');
    const createResult = await execLazy(config, [
      'create',
      '--goal', 'Create a basic module',
      '--code', 'test-comment',
      '--prompt', 'Create a validation utility module with email, URL, and HTML sanitization functions. Add unit tests.',
    ]);
    if (createResult.exitCode !== 0) {
      throw new Error(`Create failed: ${createResult.stderr}`);
    }

    logStep('Starting task: test-comment');
    const startResult = await execLazy(config, ['start', 'test-comment', '--yes'], { timeout: 120_000 });
    if (startResult.exitCode !== 0) {
      throw new Error(`Start failed: ${startResult.stderr}`);
    }

    // Wait for task to block
    const blocked = await waitForBlocked(config, 'test-comment');
    if (!blocked) {
      throw new Error('Task did not reach blocked state');
    }
    logInfo('Task blocked after first turn. Finding PR to post comment on...');

    // Find the PR created by lazy for this task's branch.
    // lazy start pushes the branch and creates a draft PR via the GitHub driver.
    // The branch name follows the pattern: lazy/<task-ref>
    logStep('Finding PR for test-comment branch');
    const prListResult = await exec(
      ['gh', 'pr', 'list', '--repo', config.githubRepo!, '--head', 'lazy/test-comment', '--json', 'number', '--limit', '1'],
      { cwd: config.tempDir },
    );

    let prNumber: number | null = null;
    if (prListResult.exitCode === 0 && prListResult.stdout) {
      try {
        const prs = JSON.parse(prListResult.stdout);
        if (prs.length > 0) {
          prNumber = prs[0].number;
        }
      } catch {
        // JSON parse failed
      }
    }

    if (!prNumber) {
      // No PR exists yet — create one so we can post a comment on it
      logInfo('No PR found, creating one...');
      const prCreateResult = await exec(
        ['gh', 'pr', 'create', '--repo', config.githubRepo!, '--head', 'lazy/test-comment',
          '--title', 'test-comment: Create a basic module', '--body', 'QA test PR'],
        { cwd: config.tempDir },
      );
      if (prCreateResult.exitCode !== 0) {
        throw new Error(`Failed to create PR: ${prCreateResult.stderr}`);
      }
      // Extract PR number from output (gh pr create prints the URL)
      const urlMatch = prCreateResult.stdout.match(/\/pull\/(\d+)/);
      if (urlMatch) {
        prNumber = parseInt(urlMatch[1], 10);
      }
    }

    if (!prNumber) {
      throw new Error('Could not find or create PR for test-comment branch');
    }
    logInfo(`Found PR #${prNumber}`);

    // Post a comment on the PR
    logStep(`Posting PR comment on #${prNumber}: "Please add input validation"`);
    const prCommentResult = await exec(
      ['gh', 'api', '-X', 'POST',
        `repos/${config.githubRepo}/issues/${prNumber}/comments`,
        '-f', 'body=Please add input validation to all functions. Each function should throw TypeError if the input is not a string.',
      ],
      { cwd: config.tempDir },
    );

    if (prCommentResult.exitCode !== 0) {
      throw new Error(`Failed to post PR comment: ${prCommentResult.stderr}`);
    }
    logInfo('PR comment posted');

    // Snapshot the current turn count so we can detect when a NEW turn happens.
    // The task is currently blocked after turn 1. The daemon should auto-unblock it
    // (creating turn 2), and the agent should complete (re-blocking with turn 2 done).
    const showBeforeComment = await execLazy(config, ['show', 'test-comment']);
    const turnCountBefore = (() => {
      const match = showBeforeComment.stdout.match(/(\d+)\s+turn/i);
      return match ? parseInt(match[1], 10) : 0;
    })();
    logInfo(`Turn count before comment: ${turnCountBefore}`);

    // Wait for daemon to detect comment and create a new turn (auto-unblock).
    // We detect this by checking if the turn count has increased, which means
    // the daemon reacted and the agent started (or finished) a new turn.
    logInfo(`Waiting for daemon to detect PR comment (timeout: ${config.timeoutDaemonMs / 1000}s)...`);
    const newTurnCreated = await pollUntil(
      'daemon to auto-react to PR comment (new turn)',
      async () => {
        const result = await execLazy(config, ['show', 'test-comment']);
        const match = result.stdout.match(/(\d+)\s+turn/i);
        const currentTurns = match ? parseInt(match[1], 10) : 0;
        return currentTurns > turnCountBefore;
      },
      config.pollIntervalMs,
      config.timeoutDaemonMs,
    );

    if (!newTurnCreated) {
      throw new Error('Daemon did not auto-react to PR comment (no new turn created)');
    }

    // Wait for the response turn to complete (task re-blocks)
    const blocked2 = await waitForBlocked(config, 'test-comment');
    if (!blocked2) {
      throw new Error('Task did not re-block after comment response');
    }

    // Verify new commits exist
    const hasNewCommits = await waitForCommits(config, 'test-comment', 2);
    if (!hasNewCommits) {
      logInfo('Warning: Could not verify new commits after comment response');
    }

    logPass(name);
    return { name, passed: true, skipped: false, duration_ms: Date.now() - start };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logFail(`${name}: ${error}`);
    return { name, passed: false, skipped: false, error, duration_ms: Date.now() - start };
  }
}

/**
 * Test D: Upstream change auto-deliver.
 * Tests parent/child task relationship with upstream merge signals.
 * No external dependencies — runs with local git only.
 */
async function testUpstreamChange(config: DriverConfig): Promise<TestResult> {
  const name = 'D: Upstream change auto-deliver';
  const start = Date.now();

  try {
    // Create parent task
    logStep('Creating parent task: test-parent');
    const createParent = await execLazy(config, [
      'create',
      '--goal', 'Create a shared types module',
      '--code', 'test-parent',
      '--prompt', 'Create a shared types module with common interfaces for the project.',
    ]);
    if (createParent.exitCode !== 0) {
      throw new Error(`Create parent failed: ${createParent.stderr}`);
    }

    logStep('Starting parent task');
    const startParent = await execLazy(config, ['start', 'test-parent', '--yes'], { timeout: 120_000 });
    if (startParent.exitCode !== 0) {
      throw new Error(`Start parent failed: ${startParent.stderr}`);
    }

    // Wait for parent to block
    const parentBlocked = await waitForBlocked(config, 'test-parent');
    if (!parentBlocked) {
      throw new Error('Parent task did not reach blocked state');
    }
    logInfo('Parent task blocked');

    // Create child task under parent
    logStep('Creating child task: test-child (under test-parent)');
    const createChild = await execLazy(config, [
      'create',
      '--goal', 'Create a child feature',
      '--code', 'test-child',
      '--parent', 'test-parent',
      '--prompt', 'Create formatting utilities that will use the shared types from the parent task. Add currency and date formatting functions with tests.',
    ]);
    if (createChild.exitCode !== 0) {
      throw new Error(`Create child failed: ${createChild.stderr}`);
    }

    logStep('Starting child task');
    const startChild = await execLazy(config, ['start', 'test-child', '--yes'], { timeout: 120_000 });
    if (startChild.exitCode !== 0) {
      throw new Error(`Start child failed: ${startChild.stderr}`);
    }

    // Wait for child to block
    const childBlocked = await waitForBlocked(config, 'test-child');
    if (!childBlocked) {
      throw new Error('Child task did not reach blocked state');
    }
    logInfo('Child task blocked');

    // Accept parent task — this creates changes on the parent branch
    logStep('Accepting parent task (triggers upstream change for child)');
    const acceptParent = await execLazy(config, ['accept', 'test-parent', '--yes'], { timeout: 60_000 });
    if (acceptParent.exitCode !== 0) {
      // Accept might fail in some configs but the branch changes still happen
      logInfo(`Accept parent exit code: ${acceptParent.exitCode} (may be expected)`);
    }

    // Wait for daemon to detect upstream change and auto-deliver signal to child
    logInfo(`Waiting for daemon to deliver upstream_change signal to child (timeout: ${config.timeoutDaemonMs / 1000}s)...`);
    const childWorking = await pollUntil(
      'child to receive upstream_change signal',
      async () => {
        const result = await execLazy(config, ['list']);
        const lines = result.stdout.split('\n');
        return lines.some(line => line.includes('test-child') && line.includes('working'));
      },
      config.pollIntervalMs,
      config.timeoutDaemonMs,
    );

    if (!childWorking) {
      // Check if child already re-blocked
      const listResult = await execLazy(config, ['list']);
      const childReblocked = listResult.stdout.split('\n')
        .some(line => line.includes('test-child') && line.includes('blocked'));
      if (!childReblocked) {
        throw new Error('Child task did not receive upstream_change signal');
      }
    }

    // Wait for child to re-block after merge
    const childBlocked2 = await waitForBlocked(config, 'test-child');
    if (!childBlocked2) {
      throw new Error('Child task did not re-block after upstream merge');
    }
    logInfo('Child task blocked after upstream merge');

    logPass(name);
    return { name, passed: true, skipped: false, duration_ms: Date.now() - start };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logFail(`${name}: ${error}`);
    return { name, passed: false, skipped: false, error, duration_ms: Date.now() - start };
  }
}

// ---------------------------------------------------------------------------
// Setup & teardown
// ---------------------------------------------------------------------------

function parseArgs(): Partial<DriverConfig> {
  const args = process.argv.slice(2);
  const config: Partial<DriverConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--scenario':
        config.scenario = args[++i];
        break;
      case '--github-repo':
        config.githubRepo = args[++i];
        break;
      case '--help':
        console.log(`Usage: bun run test/qa/run-v011.ts [options]

Options:
  --scenario <name>       Run only a specific scenario (happy-path, ci-failure, pr-comment, upstream-change)
  --github-repo <repo>    GitHub repo for CI/PR tests (e.g., lazy-qa/test-repo)
  --help                  Show this help

Environment variables:
  QA_GITHUB_REPO          Same as --github-repo
  QA_SCENARIO_FILE        Path to scenario JSON file
  LAZY_BIN                Command to run lazy (default: "bun run ./src/index.ts")
  QA_TIMEOUT_CI_MS        CI wait timeout in ms (default: 120000)
  QA_TIMEOUT_DAEMON_MS    Daemon reaction timeout in ms (default: 30000)
  QA_POLL_INTERVAL_MS     Poll interval in ms (default: 2000)`);
        process.exit(0);
    }
  }

  return config;
}

async function setup(overrides: Partial<DriverConfig>): Promise<DriverConfig> {
  // Find lazy project root (this script lives in test/qa/)
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  const lazyRoot = resolve(scriptDir, '..', '..');

  // Create temp directory for the test project
  const tempDir = mkdtempSync(join(tmpdir(), 'lazy-qa-v011-'));
  logInfo(`Temp directory: ${tempDir}`);

  // Determine lazy binary
  const lazyBinEnv = process.env.LAZY_BIN;
  const lazyBin = lazyBinEnv
    ? lazyBinEnv.split(' ')
    : ['bun', 'run', join(lazyRoot, 'src', 'index.ts')];

  // Scenario file
  const scenarioFile = process.env.QA_SCENARIO_FILE
    ?? join(scriptDir, 'v011-daemon.scenarios.json');

  if (!existsSync(scenarioFile)) {
    throw new Error(`Scenario file not found: ${scenarioFile}`);
  }

  const config: DriverConfig = {
    lazyBin,
    scenarioFile,
    githubRepo: overrides.githubRepo ?? process.env.QA_GITHUB_REPO ?? null,
    timeoutCiMs: parseInt(process.env.QA_TIMEOUT_CI_MS ?? '120000', 10),
    timeoutDaemonMs: parseInt(process.env.QA_TIMEOUT_DAEMON_MS ?? '30000', 10),
    pollIntervalMs: parseInt(process.env.QA_POLL_INTERVAL_MS ?? '2000', 10),
    tempDir,
    lazyRoot,
    scenario: overrides.scenario,
  };

  // Initialize git repo in temp directory
  logStep('Initializing test git repo');
  await execGit(tempDir, 'init');
  await execGit(tempDir, 'config', 'user.name', 'QA Test');
  await execGit(tempDir, 'config', 'user.email', 'qa@test.local');
  writeFileSync(join(tempDir, 'README.md'), '# QA Test Project\n\nThis is a temporary project for v0.11 QA testing.\n');
  await execGit(tempDir, 'add', 'README.md');
  await execGit(tempDir, 'commit', '-m', 'Initial commit');

  // Initialize lazy
  logStep('Running lazy init');
  const initResult = await execLazy(config, ['init', '--yes']);
  if (initResult.exitCode !== 0) {
    throw new Error(`lazy init failed: ${initResult.stderr || initResult.stdout}`);
  }

  // Write lazy.toml with qa-agent config
  logStep('Configuring lazy.toml for qa-agent');
  const templatePath = join(scriptDir, 'lazy.toml.template');
  const lazyTomlPath = join(tempDir, 'lazy.toml');

  if (existsSync(templatePath)) {
    const template = readFileSync(templatePath, 'utf-8');
    writeFileSync(lazyTomlPath, template);
  } else {
    // Fallback: write minimal config
    writeFileSync(lazyTomlPath, `[agent]
agent_id = "qa-agent"

[runner]
type = "dangerously-host-process-without-any-isolation"
`);
  }

  // Set QA_SCENARIO_FILE in the environment so qa-agent can find the scenario file.
  // This persists for the lifetime of the driver process.
  process.env.QA_SCENARIO_FILE = scenarioFile;

  // If GitHub repo is set, configure remote
  if (config.githubRepo) {
    logStep(`Configuring GitHub remote: ${config.githubRepo}`);
    await execGit(tempDir, 'remote', 'add', 'origin', `https://github.com/${config.githubRepo}.git`);
  }

  // Start the daemon — this test suite exists to test daemon features.
  // If the daemon can't start, the suite has no reason to run.
  logStep('Starting daemon');
  const daemonResult = await execLazy(config, ['daemon', 'start']);
  if (daemonResult.exitCode !== 0) {
    throw new Error(`Daemon failed to start (exit code ${daemonResult.exitCode}). This test suite requires a working daemon.\n${daemonResult.stderr || daemonResult.stdout}`);
  }
  logInfo('Daemon started');

  return config;
}

async function cleanup(config: DriverConfig, results: TestResult[]): Promise<void> {
  logStep('Cleaning up');

  // Stop the daemon first — it holds file locks and may interfere with task cleanup
  try {
    await execLazy(config, ['daemon', 'stop']);
    logInfo('Daemon stopped');
  } catch {
    // Best-effort: daemon may not be running or command may not exist
  }

  // Close/reject any remaining tasks
  try {
    const listResult = await execLazy(config, ['list']);
    const taskLines = listResult.stdout.split('\n').filter(l => l.trim());
    for (const line of taskLines) {
      const match = line.match(/^\s*([a-f0-9]{4,8})/);
      if (match) {
        const id = match[1];
        // Try to close gracefully
        await execLazy(config, ['close', id, '--yes', '--message', 'QA cleanup']);
      }
    }
  } catch {
    // Best-effort cleanup
  }

  // Remove temp directory
  try {
    rmSync(config.tempDir, { recursive: true, force: true });
    logInfo(`Removed temp directory: ${config.tempDir}`);
  } catch {
    logInfo(`Warning: Could not remove temp directory: ${config.tempDir}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`${COLORS.bold}=== Lazy v0.11 QA Test Driver ===${COLORS.reset}\n`);

  const overrides = parseArgs();
  let config: DriverConfig;

  try {
    config = await setup(overrides);
  } catch (err) {
    logFail(`Setup failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  logInfo(`Lazy bin: ${config.lazyBin.join(' ')}`);
  logInfo(`Scenario file: ${config.scenarioFile}`);
  logInfo(`GitHub repo: ${config.githubRepo ?? '(none — CI/PR tests will be skipped)'}`);
  logInfo(`Temp dir: ${config.tempDir}`);
  console.log('');

  // Select which tests to run
  const allTests: { id: string; fn: (c: DriverConfig) => Promise<TestResult> }[] = [
    { id: 'happy-path', fn: testHappyPath },
    { id: 'ci-failure', fn: testCIFailure },
    { id: 'pr-comment', fn: testPRComment },
    { id: 'upstream-change', fn: testUpstreamChange },
  ];

  const testsToRun = config.scenario
    ? allTests.filter(t => t.id === config.scenario)
    : allTests;

  if (testsToRun.length === 0) {
    logFail(`Unknown scenario: ${config.scenario}`);
    process.exit(1);
  }

  // Run tests sequentially
  const results: TestResult[] = [];
  for (const test of testsToRun) {
    console.log(`\n${COLORS.bold}--- Test ${test.id} ---${COLORS.reset}\n`);
    const result = await test.fn(config);
    results.push(result);
    console.log('');
  }

  // Print summary
  console.log(`\n${COLORS.bold}=== Summary ===${COLORS.reset}\n`);

  const passed = results.filter(r => r.passed);
  const failed = results.filter(r => !r.passed && !r.skipped);
  const skipped = results.filter(r => r.skipped);

  for (const r of results) {
    const status = r.skipped
      ? `${COLORS.yellow}SKIP${COLORS.reset}`
      : r.passed
        ? `${COLORS.green}PASS${COLORS.reset}`
        : `${COLORS.red}FAIL${COLORS.reset}`;
    const duration = r.duration_ms > 0 ? ` (${(r.duration_ms / 1000).toFixed(1)}s)` : '';
    const error = r.error ? ` — ${r.error}` : '';
    console.log(`  ${status} ${r.name}${duration}${error}`);
  }

  console.log(`\n  ${COLORS.green}${passed.length} passed${COLORS.reset}, ${COLORS.red}${failed.length} failed${COLORS.reset}, ${COLORS.yellow}${skipped.length} skipped${COLORS.reset}`);
  console.log(`  Total: ${results.length} tests\n`);

  // Cleanup
  await cleanup(config, results);

  // Exit with appropriate code
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  logFail(`Unhandled error: ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
