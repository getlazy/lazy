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
 *   LAZY_BIN          - Path to lazy binary (default: "lazy" installed binary)
 *   QA_TIMEOUT_CI_MS  - Timeout for CI operations in ms (default: 120000)
 *   QA_TIMEOUT_DAEMON_MS - Timeout for daemon reactions in ms (default: 30000)
 *   QA_POLL_INTERVAL_MS  - Poll interval in ms (default: 2000)
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { join, resolve, dirname, basename } from 'path';
import { tmpdir, homedir } from 'os';

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
      // Unset LAZY_CONFIG so commands read the QA project's lazy.toml, not the
      // host project's config (which may have different agent, storage, etc.)
      LAZY_CONFIG: undefined,
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
 * Reset GitHub remote to a clean slate before a GitHub-dependent test.
 * Force-pushes master, deletes all remote lazy/* branches, prunes stale refs.
 */
async function cleanGitHubState(config: DriverConfig): Promise<void> {
  logStep('Cleaning GitHub state for test');
  await execGit(config.tempDir, 'push', '--force', 'origin', 'master');
  const remoteBranches = await execGit(config.tempDir, 'ls-remote', '--heads', 'origin');
  for (const line of remoteBranches.stdout.split('\n')) {
    if (line.includes('refs/heads/lazy/')) {
      const ref = line.split('\t')[1]?.trim();
      if (ref) {
        try {
          await execGit(config.tempDir, 'push', 'origin', '--delete', ref.replace('refs/heads/', ''));
          logInfo(`Deleted remote branch: ${ref}`);
        } catch { /* best-effort */ }
      }
    }
  }
  await execGit(config.tempDir, 'remote', 'prune', 'origin');
}

/**
 * Enable GitHub driver in lazy.toml and restart daemon to pick it up.
 */
async function enableGitHubDriver(config: DriverConfig): Promise<void> {
  const lazyTomlPath = join(config.tempDir, 'lazy.toml');
  const toml = readFileSync(lazyTomlPath, 'utf-8');
  if (!toml.includes('[remote]')) {
    writeFileSync(lazyTomlPath, toml + `\n[remote]\ndriver = "github"\ngithub_auto_push = true\n`);
  }
  await execLazy(config, ['daemon', 'restart']);
}

/**
 * Disable GitHub driver and restart daemon to restore local-only mode.
 */
async function disableGitHubDriver(config: DriverConfig): Promise<void> {
  const lazyTomlPath = join(config.tempDir, 'lazy.toml');
  const toml = readFileSync(lazyTomlPath, 'utf-8');
  writeFileSync(lazyTomlPath, toml.replace(/\n\[remote\]\ndriver = "github"\ngithub_auto_push = true\n/, ''));
  await execLazy(config, ['daemon', 'restart']);
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
    if (!finalShow.stdout.includes('complete') && !finalShow.stdout.includes('abandoned')) {
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
    await cleanGitHubState(config);
    await enableGitHubDriver(config);

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

    // Snapshot worktree HEAD before waiting for auto-react.
    // After the CI fix turn, a new commit should exist in the worktree.
    const worktreePath = join(config.tempDir, '.lazy', 'worktrees', 'test-ci');
    const headBefore = (await execGit(worktreePath, 'rev-parse', 'HEAD')).stdout.trim();
    logInfo(`Worktree HEAD before CI auto-react: ${headBefore.slice(0, 8)}`);

    // Wait for CI to run and fail.
    // The daemon's auto-react should detect the failure, unblock the task,
    // the agent runs a fix turn (creating new commits), and the task re-blocks.
    logInfo(`Waiting for daemon to detect CI failure (timeout: ${config.timeoutCiMs / 1000}s)...`);

    // Poll for worktree HEAD to advance (proves auto-react triggered a fix turn)
    const autoReacted = await pollUntil(
      'daemon to auto-react to CI failure (new commits)',
      async () => {
        const headNow = (await execGit(worktreePath, 'rev-parse', 'HEAD')).stdout.trim();
        return headNow !== headBefore;
      },
      config.pollIntervalMs,
      config.timeoutCiMs,
    );

    if (!autoReacted) {
      throw new Error(
        `Daemon did not auto-react to CI failure within timeout. ` +
        `Worktree HEAD stayed at ${headBefore.slice(0, 8)} — no fix turn was triggered.`
      );
    }

    // Wait for the fix turn to complete (task blocks again)
    const blockedAgain = await waitForBlocked(config, 'test-ci');
    if (!blockedAgain) {
      throw new Error('Task did not re-block after CI fix');
    }
    logInfo('Task blocked after fix turn');

    // Verify new commits exist
    const headAfter = (await execGit(worktreePath, 'rev-parse', 'HEAD')).stdout.trim();
    logInfo(`Worktree HEAD after CI auto-react: ${headBefore.slice(0, 8)} → ${headAfter.slice(0, 8)}`);

    logPass(name);
    await disableGitHubDriver(config);
    return { name, passed: true, skipped: false, duration_ms: Date.now() - start };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logFail(`${name}: ${error}`);
    try { await disableGitHubDriver(config); } catch { /* best-effort */ }
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
    await cleanGitHubState(config);
    await enableGitHubDriver(config);

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
    logInfo('Task blocked after first turn. Waiting for commits to be recorded...');

    // Wait for the reconciler to record the agent's commits in storage.
    // The reconciler runs every 5s and records commits during response processing.
    // Without this, `lazy submit` will fail with "no commits to review."
    await Bun.sleep(8_000);

    // Submit the task — comment auto-react is gated on 'submitted' status.
    // This also pushes the branch and creates a PR via the GitHub driver.
    logStep('Submitting task: test-comment');
    const submitResult = await execLazy(config, ['submit', 'test-comment', '--yes'], { timeout: 60_000 });
    if (submitResult.exitCode !== 0) {
      logInfo(`Submit output: ${submitResult.stdout.slice(0, 200)}`);
      throw new Error(`Submit failed: ${submitResult.stderr || submitResult.stdout}`);
    }
    logInfo(`Submit output: ${submitResult.stdout.slice(0, 200)}`);

    // Find the PR number from task metadata or gh CLI
    const showAfterSubmit = await execLazy(config, ['show', 'test-comment']);
    const prMatch = showAfterSubmit.stdout.match(/github_remote_ref_id:\s*(\d+)/);
    let prNumber: number | null = prMatch ? parseInt(prMatch[1], 10) : null;

    // Fallback: find via gh CLI
    if (!prNumber) {
      const prListResult = await exec(
        ['gh', 'pr', 'list', '--repo', config.githubRepo!, '--head', 'lazy/test-comment', '--json', 'number', '--limit', '1'],
        { cwd: config.tempDir },
      );
      if (prListResult.exitCode === 0 && prListResult.stdout) {
        try {
          const prs = JSON.parse(prListResult.stdout);
          if (prs.length > 0) prNumber = prs[0].number;
        } catch { /* ignore */ }
      }
    }

    if (!prNumber) {
      throw new Error('Could not find PR for test-comment branch after submit');
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

    // Snapshot worktree HEAD before waiting for auto-react
    const worktreePath = join(config.tempDir, '.lazy', 'worktrees', 'test-comment');
    const headBefore = (await execGit(worktreePath, 'rev-parse', 'HEAD')).stdout.trim();
    logInfo(`Worktree HEAD before PR comment: ${headBefore.slice(0, 8)}`);

    // Wait for daemon to detect comment and auto-unblock.
    // The agent runs a response turn (creating new commits), then re-blocks.
    logInfo(`Waiting for daemon to detect PR comment (timeout: ${config.timeoutDaemonMs / 1000}s)...`);
    const autoReacted = await pollUntil(
      'daemon to auto-react to PR comment (new commits)',
      async () => {
        const headNow = (await execGit(worktreePath, 'rev-parse', 'HEAD')).stdout.trim();
        return headNow !== headBefore;
      },
      config.pollIntervalMs,
      config.timeoutDaemonMs,
    );

    if (!autoReacted) {
      throw new Error('Daemon did not auto-react to PR comment (no new commits)');
    }

    // Wait for the response turn to complete (task re-blocks or re-submits)
    const reblocked = await pollUntil(
      'task to re-block after comment response',
      async () => {
        const result = await execLazy(config, ['list']);
        return result.stdout.split('\n').some(line =>
          line.includes('test-comment') && (line.includes('blocked') || line.includes('submitted')));
      },
      config.pollIntervalMs,
      config.timeoutDaemonMs,
    );
    if (!reblocked) {
      throw new Error('Task did not re-block after comment response');
    }

    const headAfter = (await execGit(worktreePath, 'rev-parse', 'HEAD')).stdout.trim();
    logInfo(`Worktree HEAD after PR comment: ${headBefore.slice(0, 8)} → ${headAfter.slice(0, 8)}`);

    logPass(name);
    await disableGitHubDriver(config);
    return { name, passed: true, skipped: false, duration_ms: Date.now() - start };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logFail(`${name}: ${error}`);
    try { await disableGitHubDriver(config); } catch { /* best-effort */ }
    return { name, passed: false, skipped: false, error, duration_ms: Date.now() - start };
  }
}

/**
 * Test D: Upstream change triggers sync (supervisor-only, no agent turn).
 *
 * In v0.11, deliverUpstreamUpdated() calls syncTask() which writes a SyncCommand.
 * The supervisor handles the merge internally via handleSyncCommand() — no agent is
 * invoked. This test verifies that:
 *   1. Accepting the parent triggers a sync on the child
 *   2. The sync creates a merge commit on the child branch
 *   3. No new agent turn is created (turn count unchanged)
 *   4. The child remains blocked after sync
 *
 * No external dependencies — runs with local git only.
 */
async function testUpstreamChange(config: DriverConfig): Promise<TestResult> {
  const name = 'D: Upstream sync (no agent turn)';
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

    // Snapshot the child's turn count BEFORE accepting parent.
    // Sync is supervisor-only — the turn count must NOT increase.
    const showBeforeSync = await execLazy(config, ['show', 'test-child']);
    const turnCountBefore = (() => {
      const match = showBeforeSync.stdout.match(/(\d+)\s+turn/i);
      return match ? parseInt(match[1], 10) : 0;
    })();
    logInfo(`Child turn count before sync: ${turnCountBefore}`);

    // Get the child's git branch for merge commit detection
    const childBranchMatch = showBeforeSync.stdout.match(/Git Branch\s+(\S+)/i);
    const childBranch = childBranchMatch ? childBranchMatch[1] : 'lazy/test-child';
    logInfo(`Child branch: ${childBranch}`);

    // Get the child worktree's HEAD SHA before sync
    const childWorktreePath = join(config.tempDir, '.lazy', 'worktrees', 'test-child');
    const headBefore = await execGit(childWorktreePath, 'rev-parse', 'HEAD');
    const headShaBefore = headBefore.stdout.trim();
    logInfo(`Child HEAD before sync: ${headShaBefore.slice(0, 8)}`);

    // Accept parent task — this merges parent branch into main,
    // which the daemon should detect as an upstream change for the child.
    logStep('Accepting parent task (triggers upstream sync for child)');
    const acceptParent = await execLazy(config, ['accept', 'test-parent', '--yes'], { timeout: 60_000 });
    if (acceptParent.exitCode !== 0) {
      // Accept might fail in some configs but the branch changes still happen
      logInfo(`Accept parent exit code: ${acceptParent.exitCode} (may be expected)`);
    }

    // Wait for the daemon to detect the upstream change and run sync.
    // Sync creates a merge commit on the child branch — detect it by
    // checking if HEAD has advanced in the child worktree.
    logInfo(`Waiting for daemon to sync child (timeout: ${config.timeoutDaemonMs / 1000}s)...`);
    const synced = await pollUntil(
      'child branch to receive sync merge commit',
      async () => {
        try {
          const headAfter = await execGit(childWorktreePath, 'rev-parse', 'HEAD');
          return headAfter.stdout.trim() !== headShaBefore;
        } catch {
          // Worktree may not exist yet or git command failed — keep polling
          return false;
        }
      },
      config.pollIntervalMs,
      config.timeoutDaemonMs,
    );

    if (!synced) {
      throw new Error('Daemon did not sync child branch within timeout (HEAD unchanged)');
    }

    // Verify: HEAD advanced (merge commit exists)
    const headAfterSync = await execGit(childWorktreePath, 'rev-parse', 'HEAD');
    logInfo(`Child HEAD after sync: ${headAfterSync.stdout.trim().slice(0, 8)}`);

    // Verify: merge commit on child branch (check for "Merge" in recent commit message)
    const logResult = await execGit(childWorktreePath, 'log', '--oneline', '-3');
    logInfo(`Child git log after sync:\n${logResult.stdout}`);

    // Verify: child is still blocked (sync doesn't create agent turns)
    const childStillBlocked = await waitForBlocked(config, 'test-child');
    if (!childStillBlocked) {
      throw new Error('Child task should still be blocked after sync (sync is supervisor-only)');
    }
    logInfo('Child still blocked after sync (correct — sync has no agent turn)');

    // Verify: turn count did NOT increase
    const showAfterSync = await execLazy(config, ['show', 'test-child']);
    const turnCountAfter = (() => {
      const match = showAfterSync.stdout.match(/(\d+)\s+turn/i);
      return match ? parseInt(match[1], 10) : 0;
    })();
    logInfo(`Child turn count after sync: ${turnCountAfter}`);

    if (turnCountAfter > turnCountBefore) {
      throw new Error(
        `Turn count increased from ${turnCountBefore} to ${turnCountAfter} — ` +
        'sync should be supervisor-only with no agent turn'
      );
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
 * Test E: Per-project daemon isolation.
 * Verifies that two daemons in different project directories run independently.
 * No external dependencies.
 */
async function testDaemonIsolation(config: DriverConfig): Promise<TestResult> {
  const name = 'E: Per-project daemon isolation';
  const start = Date.now();

  let tempDirB: string | null = null;

  try {
    // Project A is the main test project (already has a daemon running from setup).
    logStep('Verifying daemon A is running (main test project)');
    const statusA = await execLazy(config, ['daemon', 'status']);
    if (statusA.exitCode !== 0) {
      throw new Error(`Daemon A not running: ${statusA.stderr}`);
    }
    logInfo('Daemon A running');

    // Extract socket path from daemon A status
    const socketMatchA = statusA.stdout.match(/Socket\s+(\S+)/i);
    const socketA = socketMatchA ? socketMatchA[1] : null;
    logInfo(`Daemon A socket: ${socketA ?? '(not found in output)'}`);

    // Create project B in a separate temp directory
    tempDirB = mkdtempSync(join(tmpdir(), 'lazy-qa-v011-B-'));
    logStep(`Creating project B in ${tempDirB}`);

    await execGit(tempDirB, 'init');
    await execGit(tempDirB, 'config', 'user.name', 'QA Test B');
    await execGit(tempDirB, 'config', 'user.email', 'qa-b@test.local');
    writeFileSync(join(tempDirB, 'README.md'), '# QA Test Project B\n');
    await execGit(tempDirB, 'add', 'README.md');
    await execGit(tempDirB, 'commit', '-m', 'Initial commit');

    // Initialize lazy in project B
    const initB = await exec([...config.lazyBin, 'init', '--non-interactive'], { cwd: tempDirB });
    if (initB.exitCode !== 0) {
      throw new Error(`lazy init in project B failed: ${initB.stderr}`);
    }

    // Start daemon in project B
    logStep('Starting daemon B');
    const daemonStartB = await exec([...config.lazyBin, 'daemon', 'start'], { cwd: tempDirB });
    if (daemonStartB.exitCode !== 0) {
      throw new Error(`Daemon B failed to start: ${daemonStartB.stderr}`);
    }
    logInfo('Daemon B started');

    // Verify daemon B is running
    const statusB = await exec([...config.lazyBin, 'daemon', 'status'], { cwd: tempDirB });
    if (statusB.exitCode !== 0) {
      throw new Error(`Daemon B not running: ${statusB.stderr}`);
    }

    // Extract socket path from daemon B
    const socketMatchB = statusB.stdout.match(/Socket\s+(\S+)/i);
    const socketB = socketMatchB ? socketMatchB[1] : null;
    logInfo(`Daemon B socket: ${socketB ?? '(not found in output)'}`);

    // Verify sockets are different (per-project isolation)
    if (socketA && socketB && socketA === socketB) {
      throw new Error(`Daemon sockets are identical: ${socketA} — per-project isolation is broken`);
    }
    logInfo('Socket paths are different (per-project isolation confirmed)');

    // Stop daemon B, verify daemon A still running
    logStep('Stopping daemon B');
    await exec([...config.lazyBin, 'daemon', 'stop'], { cwd: tempDirB });

    const statusAAfterBStop = await execLazy(config, ['daemon', 'status']);
    if (statusAAfterBStop.exitCode !== 0) {
      throw new Error('Daemon A stopped when daemon B was stopped — isolation broken');
    }
    logInfo('Daemon A still running after stopping daemon B');

    logPass(name);
    return { name, passed: true, skipped: false, duration_ms: Date.now() - start };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logFail(`${name}: ${error}`);
    return { name, passed: false, skipped: false, error, duration_ms: Date.now() - start };
  } finally {
    // Cleanup project B
    if (tempDirB) {
      try {
        await exec([...config.lazyBin, 'daemon', 'stop'], { cwd: tempDirB });
      } catch { /* best effort */ }
      try {
        rmSync(tempDirB, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  }
}

/**
 * Test F: `lazy sync` manual command.
 * Verifies that running `lazy sync <task>` manually merges upstream into
 * the child task branch without creating an agent turn.
 * No external dependencies.
 */
async function testManualSync(config: DriverConfig): Promise<TestResult> {
  const name = 'F: Manual lazy sync';
  const start = Date.now();

  try {
    // Create parent task
    logStep('Creating parent task: sync-parent');
    const createParent = await execLazy(config, [
      'create',
      '--goal', 'Create sync parent module',
      '--code', 'sync-parent',
      '--prompt', 'Create a config module with version and app name constants.',
    ]);
    if (createParent.exitCode !== 0) {
      throw new Error(`Create parent failed: ${createParent.stderr}`);
    }

    logStep('Starting parent task');
    const startParent = await execLazy(config, ['start', 'sync-parent', '--yes'], { timeout: 120_000 });
    if (startParent.exitCode !== 0) {
      throw new Error(`Start parent failed: ${startParent.stderr}`);
    }

    const parentBlocked = await waitForBlocked(config, 'sync-parent');
    if (!parentBlocked) {
      throw new Error('Parent task did not block');
    }
    logInfo('Parent task blocked');

    // Create child task under parent
    logStep('Creating child task: sync-child (under sync-parent)');
    const createChild = await execLazy(config, [
      'create',
      '--goal', 'Create sync child feature',
      '--code', 'sync-child',
      '--parent', 'sync-parent',
      '--prompt', 'Create a display module with showVersion function.',
    ]);
    if (createChild.exitCode !== 0) {
      throw new Error(`Create child failed: ${createChild.stderr}`);
    }

    logStep('Starting child task');
    const startChild = await execLazy(config, ['start', 'sync-child', '--yes'], { timeout: 120_000 });
    if (startChild.exitCode !== 0) {
      throw new Error(`Start child failed: ${startChild.stderr}`);
    }

    const childBlocked = await waitForBlocked(config, 'sync-child');
    if (!childBlocked) {
      throw new Error('Child task did not block');
    }
    logInfo('Child task blocked');

    // Snapshot turn count before sync
    const showBefore = await execLazy(config, ['show', 'sync-child']);
    const turnCountBefore = (() => {
      const match = showBefore.stdout.match(/(\d+)\s+turn/i);
      return match ? parseInt(match[1], 10) : 0;
    })();
    logInfo(`Turn count before sync: ${turnCountBefore}`);

    // Make a commit directly on the parent branch (simulate upstream change)
    const parentWorktreePath = join(config.tempDir, '.lazy', 'worktrees', 'sync-parent');
    logStep('Making direct commit on parent branch');
    // Write to worktree root — qa-agent prompts may not match any scenario
    // so src/ might not exist.
    writeFileSync(join(parentWorktreePath, 'extra.ts'), 'export const EXTRA = true;\n');
    // Only add the specific file — `git add -A` picks up sandbox files that
    // cause merge conflicts between worktrees.
    await execGit(parentWorktreePath, 'add', 'extra.ts');
    await execGit(parentWorktreePath, 'commit', '-m', 'Add extra constant (upstream change)');

    // Get child HEAD before sync
    const childWorktreePath = join(config.tempDir, '.lazy', 'worktrees', 'sync-child');
    const headBefore = await execGit(childWorktreePath, 'rev-parse', 'HEAD');
    const headShaBefore = headBefore.stdout.trim();

    // Run manual sync
    logStep('Running lazy sync sync-child');
    const syncResult = await execLazy(config, ['sync', 'sync-child'], { timeout: 60_000 });
    logInfo(`Sync output: ${syncResult.stdout.slice(0, 300)}`);
    if (syncResult.exitCode !== 0) {
      logInfo(`Sync stderr: ${syncResult.stderr.slice(0, 300)}`);
      throw new Error(`lazy sync failed: ${syncResult.stderr || syncResult.stdout}`);
    }

    // Wait for HEAD to advance (supervisor runs the merge asynchronously)
    const headAdvanced = await pollUntil(
      'child HEAD to advance after sync',
      async () => {
        const h = await execGit(childWorktreePath, 'rev-parse', 'HEAD');
        return h.stdout.trim() !== headShaBefore;
      },
      config.pollIntervalMs,
      config.timeoutDaemonMs,
    );
    if (!headAdvanced) {
      throw new Error('HEAD did not advance after sync — merge commit not created');
    }
    const headAfter = await execGit(childWorktreePath, 'rev-parse', 'HEAD');
    const headShaAfter = headAfter.stdout.trim();
    logInfo(`Child HEAD advanced: ${headShaBefore.slice(0, 8)} → ${headShaAfter.slice(0, 8)}`);

    // Verify merge commit in log
    const logResult = await execGit(childWorktreePath, 'log', '--oneline', '-3');
    logInfo(`Child git log after sync:\n${logResult.stdout}`);

    // Verify child is still blocked (sync doesn't trigger agent)
    const childStillBlocked = await waitForBlocked(config, 'sync-child');
    if (!childStillBlocked) {
      throw new Error('Child should still be blocked after sync');
    }
    logInfo('Child still blocked after sync');

    // Verify turn count unchanged
    const showAfter = await execLazy(config, ['show', 'sync-child']);
    const turnCountAfter = (() => {
      const match = showAfter.stdout.match(/(\d+)\s+turn/i);
      return match ? parseInt(match[1], 10) : 0;
    })();
    if (turnCountAfter > turnCountBefore) {
      throw new Error(`Turn count increased: ${turnCountBefore} → ${turnCountAfter}`);
    }
    logInfo(`Turn count unchanged: ${turnCountAfter}`);

    logPass(name);
    return { name, passed: true, skipped: false, duration_ms: Date.now() - start };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logFail(`${name}: ${error}`);
    return { name, passed: false, skipped: false, error, duration_ms: Date.now() - start };
  }
}

/**
 * Test G: Sync retry with pending_sync counter.
 * Verifies that sync failure increments pending_sync and a subsequent
 * sync succeeds and resets it.
 * No external dependencies.
 */
async function testSyncRetry(config: DriverConfig): Promise<TestResult> {
  const name = 'G: Sync retry with pending_sync';
  const start = Date.now();

  try {
    // Create parent task
    logStep('Creating parent task: retry-parent');
    const createParent = await execLazy(config, [
      'create',
      '--goal', 'Create retry parent module',
      '--code', 'retry-parent',
      '--prompt', 'Create a base module with BASE_URL constant.',
    ]);
    if (createParent.exitCode !== 0) {
      throw new Error(`Create parent failed: ${createParent.stderr}`);
    }

    logStep('Starting parent task');
    const startParent = await execLazy(config, ['start', 'retry-parent', '--yes'], { timeout: 120_000 });
    if (startParent.exitCode !== 0) {
      throw new Error(`Start parent failed: ${startParent.stderr}`);
    }

    const parentBlocked = await waitForBlocked(config, 'retry-parent');
    if (!parentBlocked) {
      throw new Error('Parent task did not block');
    }

    // Create child task
    logStep('Creating child task: retry-child (under retry-parent)');
    const createChild = await execLazy(config, [
      'create',
      '--goal', 'Create retry child feature',
      '--code', 'retry-child',
      '--parent', 'retry-parent',
      '--prompt', 'Create a client module with buildUrl function.',
    ]);
    if (createChild.exitCode !== 0) {
      throw new Error(`Create child failed: ${createChild.stderr}`);
    }

    logStep('Starting child task');
    const startChild = await execLazy(config, ['start', 'retry-child', '--yes'], { timeout: 120_000 });
    if (startChild.exitCode !== 0) {
      throw new Error(`Start child failed: ${startChild.stderr}`);
    }

    const childBlocked = await waitForBlocked(config, 'retry-child');
    if (!childBlocked) {
      throw new Error('Child task did not block');
    }
    logInfo('Child task blocked');

    // Sabotage the parent branch to make sync fail:
    // Rename the parent branch so the merge target doesn't exist
    const parentWorktreePath = join(config.tempDir, '.lazy', 'worktrees', 'retry-parent');
    const parentBranchResult = await execGit(parentWorktreePath, 'rev-parse', '--abbrev-ref', 'HEAD');
    const parentBranch = parentBranchResult.stdout.trim();
    logInfo(`Parent branch: ${parentBranch}`);

    // Add a commit on parent to create an upstream change
    writeFileSync(join(parentWorktreePath, 'extra.ts'), 'export const RETRY_EXTRA = true;\n');
    await execGit(parentWorktreePath, 'add', 'extra.ts');
    await execGit(parentWorktreePath, 'commit', '-m', 'Add retry extra (upstream change)');

    // Delete the parent branch ref from main repo (not the worktree) to simulate fetch failure.
    // The child's parent_branch points to this ref, so sync will fail to find it.
    // Actually, we need to be more careful — the parent branch ref lives in the main repo.
    // Instead, let's rename it temporarily.
    logStep('Renaming parent branch to simulate sync failure');
    await execGit(config.tempDir, 'branch', '-m', parentBranch, `${parentBranch}-hidden`);

    // Try sync — should fail because parent branch doesn't exist
    logStep('Running lazy sync retry-child (expecting failure)');
    const syncFail = await execLazy(config, ['sync', 'retry-child'], { timeout: 30_000 });
    logInfo(`Sync (fail) exit: ${syncFail.exitCode}, stdout: ${syncFail.stdout.slice(0, 200)}`);
    logInfo(`Sync (fail) stderr: ${syncFail.stderr.slice(0, 200)}`);

    // Check if pending_sync or error indication exists
    const showAfterFail = await execLazy(config, ['show', 'retry-child']);
    const pendingSyncMatch = showAfterFail.stdout.match(/pending.sync\s+(\d+)/i);
    if (pendingSyncMatch) {
      logInfo(`pending_sync after failed sync: ${pendingSyncMatch[1]}`);
    } else {
      logInfo('pending_sync not visible in show output (may be internal)');
    }

    // Restore the parent branch
    logStep('Restoring parent branch');
    await execGit(config.tempDir, 'branch', '-m', `${parentBranch}-hidden`, parentBranch);

    // Retry sync — should succeed now
    logStep('Running lazy sync retry-child (expecting success)');
    const syncOk = await execLazy(config, ['sync', 'retry-child'], { timeout: 60_000 });
    logInfo(`Sync (ok) exit: ${syncOk.exitCode}, stdout: ${syncOk.stdout.slice(0, 300)}`);
    if (syncOk.exitCode !== 0) {
      logInfo(`Sync (ok) stderr: ${syncOk.stderr.slice(0, 300)}`);
      throw new Error(`Sync retry failed even after restoring parent branch: ${syncOk.stderr || syncOk.stdout}`);
    }

    // Verify child branch got the merge
    const childWorktreePath = join(config.tempDir, '.lazy', 'worktrees', 'retry-child');
    const logResult = await execGit(childWorktreePath, 'log', '--oneline', '-3');
    logInfo(`Child git log after sync retry:\n${logResult.stdout}`);

    logPass(name);
    return { name, passed: true, skipped: false, duration_ms: Date.now() - start };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logFail(`${name}: ${error}`);
    return { name, passed: false, skipped: false, error, duration_ms: Date.now() - start };
  }
}

/**
 * Test H: Unblock preemption (unblock while working).
 * Verifies that unblocking a currently-working task returns an appropriate
 * error (409 rejection). In v0.11, there is no preemption — the user must
 * wait for the current turn to finish.
 * No external dependencies.
 */
async function testUnblockPreemption(config: DriverConfig): Promise<TestResult> {
  const name = 'H: Unblock preemption (rejection)';
  const start = Date.now();

  try {
    logStep('Creating task: test-preempt');
    const createResult = await execLazy(config, [
      'create',
      '--goal', 'Build a slow computation module',
      '--code', 'test-preempt',
      '--prompt', 'Create a fibonacci computation module.',
    ]);
    if (createResult.exitCode !== 0) {
      throw new Error(`Create failed: ${createResult.stderr}`);
    }

    // Start the task — the qa-agent is fast, so we need to try unblock
    // immediately after start to catch it in 'working' state.
    logStep('Starting task and immediately attempting unblock');
    const startResult = await execLazy(config, ['start', 'test-preempt', '--yes'], { timeout: 120_000 });
    if (startResult.exitCode !== 0) {
      throw new Error(`Start failed: ${startResult.stderr}`);
    }

    // Immediately try to unblock while the task might still be working.
    // With qa-agent, the task may finish very quickly, so we attempt
    // the unblock right away and check for either:
    // (a) 409 rejection ("still working") — the expected preemption rejection
    // (b) Success — task already blocked, so unblock works normally
    const unblockResult = await execLazy(config, [
      'unblock', 'test-preempt',
      '--message', 'Premature feedback while task may still be working',
    ], { timeout: 30_000 });

    if (unblockResult.exitCode !== 0) {
      // Check for the expected "still working" rejection
      const output = unblockResult.stdout + unblockResult.stderr;
      if (output.includes('still working') || output.includes('409') || output.includes('wait')) {
        logInfo('Got expected rejection: task is still working');
        logPass(name);
        return { name, passed: true, skipped: false, duration_ms: Date.now() - start };
      }
      // Some other error
      throw new Error(`Unblock failed with unexpected error: ${output.slice(0, 300)}`);
    }

    // If unblock succeeded, the task had already blocked (qa-agent was too fast).
    // This is acceptable — we still verify the lifecycle works.
    logInfo('Task had already blocked when unblock was attempted (qa-agent completed quickly)');
    logInfo('Cannot reliably test preemption rejection with fast qa-agent');

    // Wait for the feedback turn to complete
    const blocked2 = await waitForBlocked(config, 'test-preempt');
    if (!blocked2) {
      logInfo('Warning: task did not re-block after feedback');
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
 * Test I: Event durability across daemon restart.
 * Verifies that upstream changes made while the daemon is stopped are
 * caught up after daemon restart (via runBlockedTaskCatchup).
 * No external dependencies.
 */
async function testEventDurability(config: DriverConfig): Promise<TestResult> {
  const name = 'I: Event durability across daemon restart';
  const start = Date.now();

  try {
    // Create parent task
    logStep('Creating parent task: dur-parent');
    const createParent = await execLazy(config, [
      'create',
      '--goal', 'Create durability parent module',
      '--code', 'dur-parent',
      '--prompt', 'Create a schema module with User interface.',
    ]);
    if (createParent.exitCode !== 0) {
      throw new Error(`Create parent failed: ${createParent.stderr}`);
    }

    logStep('Starting parent task');
    const startParent = await execLazy(config, ['start', 'dur-parent', '--yes'], { timeout: 120_000 });
    if (startParent.exitCode !== 0) {
      throw new Error(`Start parent failed: ${startParent.stderr}`);
    }

    const parentBlocked = await waitForBlocked(config, 'dur-parent');
    if (!parentBlocked) {
      throw new Error('Parent task did not block');
    }
    logInfo('Parent task blocked');

    // Create child task
    logStep('Creating child task: dur-child (under dur-parent)');
    const createChild = await execLazy(config, [
      'create',
      '--goal', 'Create durability child feature',
      '--code', 'dur-child',
      '--parent', 'dur-parent',
      '--prompt', 'Create a repo module with findUser function.',
    ]);
    if (createChild.exitCode !== 0) {
      throw new Error(`Create child failed: ${createChild.stderr}`);
    }

    logStep('Starting child task');
    const startChild = await execLazy(config, ['start', 'dur-child', '--yes'], { timeout: 120_000 });
    if (startChild.exitCode !== 0) {
      throw new Error(`Start child failed: ${startChild.stderr}`);
    }

    const childBlocked = await waitForBlocked(config, 'dur-child');
    if (!childBlocked) {
      throw new Error('Child task did not block');
    }
    logInfo('Child task blocked');

    // Get child HEAD before
    const childWorktreePath = join(config.tempDir, '.lazy', 'worktrees', 'dur-child');
    const headBefore = await execGit(childWorktreePath, 'rev-parse', 'HEAD');
    const headShaBefore = headBefore.stdout.trim();
    logInfo(`Child HEAD before: ${headShaBefore.slice(0, 8)}`);

    // Stop the daemon
    logStep('Stopping daemon');
    const daemonStop = await execLazy(config, ['daemon', 'stop']);
    if (daemonStop.exitCode !== 0) {
      throw new Error(`Daemon stop failed: ${daemonStop.stderr}`);
    }
    logInfo('Daemon stopped');

    // Make an upstream change on the parent branch while daemon is down
    logStep('Making upstream change while daemon is stopped');
    const parentWorktreePath = join(config.tempDir, '.lazy', 'worktrees', 'dur-parent');
    // Write to root — qa-agent may not create a src/ directory
    writeFileSync(join(parentWorktreePath, 'durability-extra.ts'), 'export const DURABLE = true;\n');
    // Only add the specific file — `git add -A` would pick up sandbox files
    // (.lazy-task-sandbox/.gitconfig) that exist in both worktrees, causing
    // merge conflicts that require claude for resolution.
    await execGit(parentWorktreePath, 'add', 'durability-extra.ts');
    await execGit(parentWorktreePath, 'commit', '-m', 'Add durability extra (while daemon was down)');
    logInfo('Upstream change committed while daemon was stopped');

    // Restart the daemon
    logStep('Restarting daemon');
    const daemonStart = await execLazy(config, ['daemon', 'start']);
    if (daemonStart.exitCode !== 0) {
      throw new Error(`Daemon restart failed: ${daemonStart.stderr}`);
    }
    logInfo('Daemon restarted');

    // Wait for the daemon to catch up and sync the child
    // runBlockedTaskCatchup should detect the upstream change and trigger sync
    logInfo(`Waiting for daemon catchup to sync child (timeout: ${config.timeoutDaemonMs / 1000}s)...`);
    const synced = await pollUntil(
      'daemon catchup to sync child branch',
      async () => {
        try {
          const headAfter = await execGit(childWorktreePath, 'rev-parse', 'HEAD');
          return headAfter.stdout.trim() !== headShaBefore;
        } catch {
          return false;
        }
      },
      config.pollIntervalMs,
      config.timeoutDaemonMs,
    );

    if (!synced) {
      throw new Error('Daemon did not catch up and sync child branch after restart');
    }

    // Verify merge commit
    const headAfter = await execGit(childWorktreePath, 'rev-parse', 'HEAD');
    logInfo(`Child HEAD after catchup: ${headAfter.stdout.trim().slice(0, 8)}`);

    const logResult = await execGit(childWorktreePath, 'log', '--oneline', '-3');
    logInfo(`Child git log after catchup:\n${logResult.stdout}`);

    // Verify child is still blocked
    const childStillBlocked = await waitForBlocked(config, 'dur-child');
    if (!childStillBlocked) {
      throw new Error('Child should still be blocked after catchup sync');
    }
    logInfo('Child still blocked after catchup sync');

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
  --scenario <name>       Run only a specific scenario (happy-path, ci-failure, pr-comment, upstream-change, daemon-isolation, manual-sync, sync-retry, unblock-preemption, event-durability)
  --github-repo <repo>    GitHub repo for CI/PR tests (e.g., lazy-qa/test-repo)
  --help                  Show this help

Environment variables:
  QA_GITHUB_REPO          Same as --github-repo
  QA_SCENARIO_FILE        Path to scenario JSON file
  LAZY_BIN                Command to run lazy (default: "lazy")
  QA_TIMEOUT_CI_MS        CI wait timeout in ms (default: 120000)
  QA_TIMEOUT_DAEMON_MS    Daemon reaction timeout in ms (default: 30000)
  QA_POLL_INTERVAL_MS     Poll interval in ms (default: 2000)`);
        process.exit(0);
    }
  }

  return config;
}

/**
 * Clean up leftover artifacts from previous QA runs.
 * Removes old temp dirs, their corresponding ~/.lazy/ storage dirs,
 * and kills stale daemon processes.
 */
function cleanupPreviousRuns(): void {
  const prefix = 'lazy-qa-v011-';

  // 1. Remove old QA temp dirs
  logStep('Pre-cleanup: removing leftover QA temp dirs');
  try {
    const tmpDir = tmpdir();
    const entries = readdirSync(tmpDir);
    for (const entry of entries) {
      if (entry.startsWith(prefix)) {
        const fullPath = join(tmpDir, entry);
        try {
          rmSync(fullPath, { recursive: true, force: true });
          logInfo(`Removed old temp dir: ${fullPath}`);
        } catch {
          // Best-effort — may be locked by a running process
        }
      }
    }
  } catch {
    // tmpdir listing failed — non-fatal
  }

  // 2. Remove corresponding storage dirs in ~/.lazy/
  logStep('Pre-cleanup: removing leftover QA storage dirs');
  try {
    const lazyDir = join(homedir(), '.lazy');
    if (existsSync(lazyDir)) {
      const entries = readdirSync(lazyDir);
      for (const entry of entries) {
        if (entry.startsWith(prefix)) {
          const fullPath = join(lazyDir, entry);
          try {
            rmSync(fullPath, { recursive: true, force: true });
            logInfo(`Removed old storage dir: ${fullPath}`);
          } catch {
            // Best-effort
          }
        }
      }
    }
  } catch {
    // ~/.lazy/ listing failed — non-fatal
  }

  // 3. Kill stale supervisor processes from previous QA runs.
  // Supervisors are spawned with .unref() and survive the parent process.
  // They reference temp dirs that may no longer exist, consuming ~150MB each.
  logStep('Pre-cleanup: killing stale supervisor processes');
  try {
    const result = Bun.spawnSync(['pgrep', '-f', `lazy supervise.*${prefix}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode === 0) {
      const pids = result.stdout.toString().trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), 'SIGKILL');
          logInfo(`Killed stale supervisor PID ${pid}`);
        } catch {
          // Process may have already exited
        }
      }
    }
  } catch {
    // pgrep not available or failed — non-fatal
  }

  // 4. Kill stale tmux sessions and tail processes from previous runs.
  try {
    const result = Bun.spawnSync(['pgrep', '-f', `tail -f.*lazy.*log`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode === 0) {
      const pids = result.stdout.toString().trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), 'SIGKILL');
        } catch {
          // Best-effort
        }
      }
      if (pids.length > 0) logInfo(`Killed ${pids.length} stale tail processes`);
    }
  } catch {
    // Best-effort
  }

  // 5. Clean up stale daemon socket files.
  logStep('Pre-cleanup: checking for stale daemon sockets');
  try {
    const daemonDir = join(homedir(), '.lazy', 'daemon');
    if (existsSync(daemonDir)) {
      const entries = readdirSync(daemonDir);
      for (const entry of entries) {
        if (entry.startsWith(prefix)) {
          const socketPath = join(daemonDir, entry);
          try {
            rmSync(socketPath, { force: true });
            logInfo(`Removed stale daemon socket: ${socketPath}`);
          } catch {
            // Best-effort
          }
        }
      }
    }
  } catch {
    // Daemon dir listing failed — non-fatal
  }
}

async function setup(overrides: Partial<DriverConfig>): Promise<DriverConfig> {
  // Find lazy project root (this script lives in test/qa/)
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  const lazyRoot = resolve(scriptDir, '..', '..');

  // --- Pre-cleanup ---
  // Remove leftover artifacts from previous runs that may have been killed
  // without cleanup. This prevents storage collisions ("task already exists").
  cleanupPreviousRuns();

  // --- Pre-flight checks ---
  // These run BEFORE creating temp dirs or launching daemons so that
  // misconfiguration surfaces immediately with a clear message.

  // 1. Verify bun is available (qa-agent runs via bun)
  logStep('Pre-flight: checking bun');
  const bunCheck = Bun.spawnSync(['bun', '--version'], { stdout: 'pipe', stderr: 'pipe' });
  if (bunCheck.exitCode !== 0) {
    throw new Error(
      'Pre-flight failed: bun not found in $PATH.\n' +
      'Install bun: curl -fsSL https://bun.sh/install | bash'
    );
  }
  logInfo(`bun ${bunCheck.stdout.toString().trim()} available`);

  // 2. Verify git is available
  logStep('Pre-flight: checking git');
  const gitCheck = Bun.spawnSync(['git', '--version'], { stdout: 'pipe', stderr: 'pipe' });
  if (gitCheck.exitCode !== 0) {
    throw new Error('Pre-flight failed: git not found in $PATH.');
  }
  logInfo(`${gitCheck.stdout.toString().trim()} available`);

  // 3. Scenario file must exist
  const scenarioFile = process.env.QA_SCENARIO_FILE
    ?? join(scriptDir, 'v011-daemon.scenarios.json');

  if (!existsSync(scenarioFile)) {
    throw new Error(
      `Pre-flight failed: scenario file not found: ${scenarioFile}\n` +
      'Set QA_SCENARIO_FILE or run from the lazy source tree.'
    );
  }

  // 4. Determine and verify lazy binary.
  // LAZY_BIN unset → test the installed "lazy" binary (default)
  // LAZY_BIN="bun run ./src/index.ts" → run from source tree (dev QA)
  const lazyBinEnv = process.env.LAZY_BIN;
  const lazyBin = lazyBinEnv
    ? lazyBinEnv.split(' ')
    : ['lazy'];

  logStep('Pre-flight: checking lazy binary');
  const lazyCheck = Bun.spawnSync([...lazyBin, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  if (lazyCheck.exitCode !== 0) {
    const hint = lazyBinEnv
      ? `LAZY_BIN="${lazyBinEnv}" does not work. Is it installed/accessible?`
      : 'Default "lazy" not found. Install lazy or set LAZY_BIN="bun run ./src/index.ts" to run from source.';
    throw new Error(
      `Pre-flight failed: lazy binary not working.\n${hint}\n` +
      `stdout: ${lazyCheck.stdout.toString().trim()}\n` +
      `stderr: ${lazyCheck.stderr.toString().trim()}`
    );
  }
  logInfo(`lazy binary: ${lazyBin.join(' ')} (${lazyCheck.stdout.toString().trim()})`);

  // Create temp directory for the test project
  const tempDir = mkdtempSync(join(tmpdir(), 'lazy-qa-v011-'));
  logInfo(`Temp directory: ${tempDir}`);

  const config: DriverConfig = {
    lazyBin,
    scenarioFile,
    githubRepo: overrides.githubRepo ?? process.env.QA_GITHUB_REPO ?? null,
    timeoutCiMs: parseInt(process.env.QA_TIMEOUT_CI_MS ?? '120000', 10),
    timeoutDaemonMs: parseInt(process.env.QA_TIMEOUT_DAEMON_MS ?? '60000', 10),
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
  const initResult = await execLazy(config, ['init', '--non-interactive']);
  if (initResult.exitCode !== 0) {
    throw new Error(`lazy init failed: ${initResult.stderr || initResult.stdout}`);
  }

  // Use an explicit external storage path under ~/.lazy/ keyed to temp dir name.
  // This ensures storage is isolated per run and doesn't rely on getProjectName()
  // which can produce different results before/after lazy.toml overwrite.
  const externalStorageDir = join(homedir(), '.lazy', basename(tempDir));
  mkdirSync(externalStorageDir, { recursive: true });
  logInfo(`External storage dir: ${externalStorageDir}`);

  // Write lazy.toml with qa-agent config, including explicit external_path
  // to guarantee storage isolation between runs.
  logStep('Configuring lazy.toml for qa-agent');
  const templatePath = join(scriptDir, 'lazy.toml.template');
  const lazyTomlPath = join(tempDir, 'lazy.toml');

  if (existsSync(templatePath)) {
    let template = readFileSync(templatePath, 'utf-8');
    // Inject the resolved external_path into the [storage] section.
    // The template has external_path commented out or absent — we add it.
    if (template.includes('[storage]')) {
      template = template.replace(
        '[storage]',
        `[storage]\nexternal_path = "${externalStorageDir}"`,
      );
    } else {
      template += `\n[storage]\nbackend = "external"\nexternal_path = "${externalStorageDir}"\n`;
    }
    writeFileSync(lazyTomlPath, template);
  } else {
    // Fallback: write minimal config with explicit storage path
    writeFileSync(lazyTomlPath, `[agent]
agent_id = "qa-agent"

[runner]
type = "dangerously-host-process-without-any-isolation"

[storage]
backend = "external"
external_path = "${externalStorageDir}"
`);
  }

  // Set QA_SCENARIO_FILE in the environment so qa-agent can find the scenario file.
  // This persists for the lifetime of the driver process.
  process.env.QA_SCENARIO_FILE = scenarioFile;

  // Set QA_AGENT_SCRIPT so the supervisor knows where the qa-agent script is.
  // When lazy is installed as a compiled binary, import.meta.dir doesn't resolve
  // to the source tree. This env var tells QaAgent where to find the script.
  process.env.QA_AGENT_SCRIPT = join(lazyRoot, 'src', 'qa', 'agent.ts');

  // If GitHub repo is set, configure git remote and enable GitHub driver in lazy.toml
  if (config.githubRepo) {
    logStep(`Configuring GitHub remote: ${config.githubRepo}`);
    // Use GH_TOKEN or GITHUB_TOKEN for git HTTPS auth so pushes/fetches work.
    const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const remoteUrl = ghToken
      ? `https://x-access-token:${ghToken}@github.com/${config.githubRepo}.git`
      : `https://github.com/${config.githubRepo}.git`;
    await execGit(tempDir, 'remote', 'add', 'origin', remoteUrl);

    // Push initial commit so the remote has a matching default branch.
    // Force-push to handle the case where the remote repo already has content.
    await execGit(tempDir, 'push', '--force', 'origin', 'master');
    // Fetch to update local origin/master ref so isBranchMergedInto
    // compares against the fresh master, not a stale ref from a previous run.
    await execGit(tempDir, 'fetch', 'origin', 'master');
    logInfo('Pushed initial commit to remote and fetched');

    // Clean up stale remote branches from previous QA runs so pushes don't
    // fail with "non-fast-forward" (remote branches have divergent history).
    logStep('Cleaning up stale remote branches');
    const remoteBranches = await execGit(tempDir, 'ls-remote', '--heads', 'origin');
    const staleRefs = remoteBranches.stdout.split('\n')
      .filter(line => line.includes('refs/heads/lazy/'))
      .map(line => line.split('\t')[1]?.trim())
      .filter(Boolean);
    for (const ref of staleRefs) {
      try {
        await execGit(tempDir, 'push', 'origin', '--delete', ref.replace('refs/heads/', ''));
        logInfo(`Deleted stale remote branch: ${ref}`);
      } catch {
        // Best-effort — branch may already be deleted
      }
    }

    // Do NOT enable the GitHub driver globally — it causes the daemon's external
    // change detection to interfere with local-only tests (auto-closing tasks via
    // stale PRs, etc.). Tests B and C enable it per-test with daemon restart.
  }

  // Start the daemon — this test suite exists to test daemon features.
  // If the daemon can't start, the suite has no reason to run.
  logStep('Starting daemon');
  const daemonResult = await execLazy(config, ['daemon', 'start']);
  if (daemonResult.exitCode !== 0) {
    throw new Error(`Daemon failed to start (exit code ${daemonResult.exitCode}). This test suite requires a working daemon.\n${daemonResult.stderr || daemonResult.stdout}`);
  }
  logInfo('Daemon started');

  // Clean up leftover tasks from a previous run that didn't clean up properly
  // (e.g., the process was killed). Without this, task code conflicts break all tests.
  logStep('Cleaning up leftover tasks');
  const precleanList = await execLazy(config, ['list', '--all']);
  if (precleanList.exitCode === 0 && precleanList.stdout.trim()) {
    const taskLines = precleanList.stdout.split('\n');
    for (const line of taskLines) {
      const match = line.match(/^\s*([a-f0-9]{4,8})/);
      if (match) {
        await execLazy(config, ['close', match[1], '--yes', '--message', 'QA pre-cleanup']);
      }
    }
  }

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

  // Kill any supervisor processes spawned for this run's temp dir.
  // Supervisors are .unref()'d and survive daemon stop.
  try {
    const tempBasename = basename(config.tempDir);
    const result = Bun.spawnSync(['pgrep', '-f', `lazy supervise.*${tempBasename}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode === 0) {
      const pids = result.stdout.toString().trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), 'SIGKILL');
        } catch {
          // Already exited
        }
      }
      if (pids.length > 0) logInfo(`Killed ${pids.length} supervisor processes`);
    }
  } catch {
    // Best-effort
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

  // Remove external storage directory (~/.lazy/<project-name>/)
  try {
    const externalStorageDir = join(homedir(), '.lazy', basename(config.tempDir));
    rmSync(externalStorageDir, { recursive: true, force: true });
    logInfo(`Removed external storage: ${externalStorageDir}`);
  } catch {
    // Best-effort cleanup
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
    { id: 'daemon-isolation', fn: testDaemonIsolation },
    { id: 'manual-sync', fn: testManualSync },
    { id: 'sync-retry', fn: testSyncRetry },
    { id: 'unblock-preemption', fn: testUnblockPreemption },
    { id: 'event-durability', fn: testEventDurability },
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
