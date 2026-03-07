/**
 * E2E test setup helpers
 *
 * Provides a TestContext that creates an isolated temp git repo with lazy
 * initialized. Tests run the real CLI via subprocess for maximum fidelity.
 */

import { join, resolve } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

const ENTRY_PATH = resolve(__dirname, '../../src/index.ts');
const PRELOAD_PATH = resolve(__dirname, '../mocks/preload-mocks.ts');

export interface WorkResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MockAgentResponse {
  result: string;
  session_id: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface LazyOptions {
  env?: Record<string, string>;
  /** Pipe this string to the command's stdin */
  input?: string;
}

export interface TestContext {
  /** Absolute path to the temporary test directory (git repo root) */
  root: string;
  /** Absolute path to the temporary protocol base directory */
  protocolBase: string;
  /** Run a `lazy` CLI command in this test context */
  lazy: (args: string[], options?: LazyOptions) => Promise<WorkResult>;
  /** Run a `lazy` CLI command with Claude/Docker mocked */
  lazyMocked: (args: string[], mockResponse: MockAgentResponse, options?: LazyOptions) => Promise<WorkResult>;
  /** Run raw git commands in the test directory */
  git: (...args: string[]) => { stdout: string; stderr: string; exitCode: number };
  /** Clean up the temporary directory */
  cleanup: () => Promise<void>;
}

function spawnGit(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

async function runLazy(cwd: string, args: string[], protocolBase: string, extraEnv?: Record<string, string>, input?: string): Promise<WorkResult> {
  const proc = Bun.spawn(['bun', 'run', ENTRY_PATH, ...args], {
    cwd,
    stdin: input !== undefined ? new Blob([input]) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LAZY_PROTOCOL_BASE: protocolBase, ...extraEnv },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

async function runLazyMocked(
  cwd: string,
  args: string[],
  mockResponse: MockAgentResponse,
  protocolBase: string,
  extraEnv?: Record<string, string>,
  input?: string,
): Promise<WorkResult> {
  const proc = Bun.spawn(['bun', 'run', '--preload', PRELOAD_PATH, ENTRY_PATH, ...args], {
    cwd,
    stdin: input !== undefined ? new Blob([input]) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...extraEnv,
      LAZY_TEST: '1',
      LAZY_PROTOCOL_BASE: protocolBase,
      LAZY_MOCK_CLAUDE_RESPONSE: JSON.stringify(mockResponse),
      // Provide fake auth so getAuthEnv() doesn't fail
      ANTHROPIC_API_KEY: 'sk-test-fake-key-for-testing',
    },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

/**
 * Create an isolated test lazy project: temp dir with git repo + `lazy init`.
 * Call cleanup() in afterEach to remove it.
 */
export async function setupTestLazy(): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), 'lazy-e2e-'));
  const protocolBase = await mkdtemp(join(tmpdir(), 'lazy-e2e-protocol-'));

  // Set LAZY_PROTOCOL_BASE for in-process protocol calls (e.g. getProtocolDir in tests)
  process.env.LAZY_PROTOCOL_BASE = protocolBase;

  // Initialize git repo
  spawnGit(root, 'init');
  spawnGit(root, 'config', 'user.email', 'test@lazy.test');
  spawnGit(root, 'config', 'user.name', 'Lazy Test');
  spawnGit(root, 'checkout', '-b', 'main');

  // Create initial file and commit (worktrees require at least one commit)
  await writeFile(join(root, 'README.md'), '# Test Project\n');
  spawnGit(root, 'add', '.');
  spawnGit(root, 'commit', '-m', 'Initial commit');

  // Run `lazy init` (skip auth/github checks, non-interactive for piped test env)
  const initResult = await runLazy(root, ['init', '--skip-auth-check', '--skip-github-check', '--non-interactive'], protocolBase);
  if (initResult.exitCode !== 0) {
    throw new Error(`lazy init failed: ${initResult.stderr}\n${initResult.stdout}`);
  }

  // Commit lazy initialization so worktrees can branch from here
  spawnGit(root, 'add', '.');
  spawnGit(root, 'commit', '-m', 'Initialize lazy');

  const ctx: TestContext = {
    root,
    protocolBase,
    lazy: (args, options) => runLazy(root, args, protocolBase, options?.env, options?.input),
    lazyMocked: (args, mockResponse, options) =>
      runLazyMocked(root, args, mockResponse, protocolBase, options?.env, options?.input),
    git: (...args) => spawnGit(root, ...args),
    cleanup: async () => {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(protocolBase, { recursive: true, force: true }),
      ]);
    },
  };

  return ctx;
}
