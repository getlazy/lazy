/**
 * HostProcessRunner — Runner implementation that spawns native processes.
 *
 * Designed for use inside VMs or other already-isolated environments where
 * Docker is unavailable or unnecessary. Runs the supervisor and Claude Code
 * directly on the host.
 *
 * DANGER: No filesystem or process isolation. The agent has full access to
 * the host system. Only use in environments that are already sandboxed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { SandboxConfig } from '../capture/claude';
import type { ClaudeResponse } from '../types';
import type { Runner, RunInfo, FollowHandle } from './types';
import { getAuthEnv } from '../capture/claude';
import { logger } from '../utils/logger';

import hostProcessBuilderInstructions from '../prompts/host-process-builder-runner-instructions.md' with { type: 'text' };

/** Directory inside worktrees where we store PID files and logs. */
const RUN_STATE_DIR = '.lazy-run';

interface PidFileData {
  pid: number;
  startedAt: string;
  logFile: string;
}

function runStateDir(worktreePath: string): string {
  return join(worktreePath, RUN_STATE_DIR);
}

/** Write a PID file for a running supervisor process. */
function writePidFile(runName: string, data: PidFileData): void {
  const dir = pidFileDir();
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${runName}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Read a PID file, or null if not found. */
function readPidFile(runName: string): PidFileData | null {
  const filePath = join(pidFileDir(), `${runName}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Remove a PID file. */
function removePidFile(runName: string): void {
  const filePath = join(pidFileDir(), `${runName}.json`);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Best effort
  }
}

/** Directory where PID files are stored. */
function pidFileDir(): string {
  return join(homedir(), '.lazy', 'run');
}

/**
 * Get the command prefix to re-invoke the current lazy CLI.
 * In compiled mode: ['/path/to/lazy']
 * In dev mode: ['bun', '/path/to/src/index.ts']
 */
function getLazyCliCommand(): string[] {
  // In dev mode, process.argv[1] is the script path (e.g. /path/to/src/index.ts)
  if (process.argv.length > 1 && /index\.[tj]s$/.test(process.argv[1])) {
    return [process.argv[0], process.argv[1]];
  }
  // Compiled mode: just the binary
  return [process.argv[0]];
}

/** Check if a process with the given PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Get mtime of all JSONL session files for a project (for conversation capture). */
function getSessionFileTimes(
  claudeHome: string,
  lazyRoot: string,
  encodeProjectPath: (p: string) => string,
): Map<string, number> {
  const encodedPath = encodeProjectPath(lazyRoot);
  const projectDir = join(claudeHome, '.claude', 'projects', encodedPath);
  const times = new Map<string, number>();

  try {
    const entries = readdirSync(projectDir);
    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) {
        try {
          const mtime = statSync(join(projectDir, entry)).mtimeMs;
          times.set(entry, mtime);
        } catch {
          // Skip inaccessible files
        }
      }
    }
  } catch {
    // Project directory doesn't exist yet
  }

  return times;
}

/** Find the newest JSONL file that was created or modified between two snapshots. */
function findNewOrModifiedFile(
  before: Map<string, number>,
  after: Map<string, number>,
): string | null {
  let newestFile: string | null = null;
  let newestMtime = 0;

  for (const [file, mtime] of after) {
    const beforeMtime = before.get(file);
    if (beforeMtime === undefined || mtime !== beforeMtime) {
      if (mtime > newestMtime) {
        newestMtime = mtime;
        newestFile = file;
      }
    }
  }

  return newestFile;
}

export class HostProcessRunner implements Runner {
  readonly type = 'dangerously-host-process-without-any-isolation' as const;
  readonly runLabel = 'Process';

  runDisplayName(runName: string): string {
    const pidData = readPidFile(runName);
    return pidData ? `PID ${pidData.pid}` : runName;
  }

  checkAvailability(): void {
    // Check that claude is on PATH
    const result = Bun.spawnSync(['claude', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        'Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code\n' +
        'Host-process runner requires Claude Code to be installed on the host.'
      );
    }

    // Check auth
    getAuthEnv();
  }

  async ensureReady(): Promise<void> {
    // No agent binary needed — supervisor runs via `lazy supervise` directly.
  }

  runNameForTask(taskShortId: string): string {
    return `lazy-${taskShortId}`;
  }

  async launchSupervisor(
    sandbox: SandboxConfig,
    runName: string,
    protocolDir: string,
    debug?: boolean,
  ): Promise<void> {
    const auth = getAuthEnv();

    // Set up log file for this run
    const logDir = join(homedir(), '.lazy', 'logs');
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, `${runName}.log`);

    const supervisorArgs = [
      ...getLazyCliCommand(),
      'supervise',
      '--protocol-dir', protocolDir,
      '--worktree', sandbox.worktreePath,
      '--runner', this.type,
    ];

    if (debug) {
      console.log('[DEBUG] Launching supervisor process:', supervisorArgs.join(' '));
    }

    logger.info('Launching supervisor process...');

    // Redirect stdout/stderr to a log file via Bun.file
    const logFileHandle = Bun.file(logFile);

    const proc = Bun.spawn(supervisorArgs, {
      cwd: sandbox.worktreePath,
      stdout: logFileHandle,
      stderr: logFileHandle,
      env: {
        ...process.env as Record<string, string>,
        [auth.key]: auth.value,
        // Ensure HOME is set for Claude Code
        HOME: homedir(),
      },
    });

    // Unref so this process doesn't keep the parent alive
    proc.unref();

    // Store PID for later status checks
    writePidFile(runName, {
      pid: proc.pid,
      startedAt: new Date().toISOString(),
      logFile,
    });

    logger.debug(`Supervisor process ${runName} launched (PID ${proc.pid})`);
  }

  async runClaudeSync(
    prompt: string,
    sandbox: SandboxConfig,
    verbose?: boolean,
    debug?: boolean,
    model?: string,
  ): Promise<ClaudeResponse> {
    const auth = getAuthEnv();

    const claudeArgs = [
      'claude', '-p', prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ];

    if (model) {
      claudeArgs.push('--model', model);
    }

    if (debug) {
      console.log('[DEBUG] Running Claude command:', claudeArgs.join(' '));
    }

    logger.info('Running Claude Code...');

    const proc = Bun.spawn(claudeArgs, {
      cwd: sandbox.worktreePath,
      stdout: 'pipe',
      stderr: verbose || debug ? 'inherit' : 'pipe',
      env: {
        ...process.env as Record<string, string>,
        [auth.key]: auth.value,
        HOME: homedir(),
      },
    });

    const outputPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();

    const [output, stderr, exitCode] = await Promise.all([
      outputPromise,
      stderrPromise,
      proc.exited,
    ]);

    logger.stream('Claude stdout:\n' + output);
    logger.stream('Claude stderr:\n' + stderr);

    if (exitCode !== 0) {
      if (!(verbose || debug) && stderr) {
        const stderrLines = stderr.trim().split('\n');
        const lastOutput = stderrLines.slice(-20).join('\n  ');
        logger.error(`Claude Code exited with code ${exitCode}\n\nLast output:\n  ${lastOutput}`);
      } else {
        logger.error(`Claude Code exited with code ${exitCode}`);
      }
      throw new Error(`Claude exited with code ${exitCode}`);
    }

    logger.debug('Parsing Claude response...');
    return JSON.parse(output) as ClaudeResponse;
  }

  isRunning(runName: string): boolean {
    const pidData = readPidFile(runName);
    if (!pidData) return false;
    return isProcessAlive(pidData.pid);
  }

  runExists(runName: string): boolean {
    return readPidFile(runName) !== null;
  }

  getRunInfo(runName: string): RunInfo | null {
    const pidData = readPidFile(runName);
    if (!pidData) return null;

    const running = isProcessAlive(pidData.pid);
    return {
      running,
      // We can't reliably get exit codes from detached processes after they exit.
      // The reconciler relies on protocol response.json for success detection.
      // For crash detection, the process simply disappears.
      exitCode: running ? 0 : 1,
      finishedAt: running ? null : new Date().toISOString(),
    };
  }

  getRunExitCode(runName: string): number | null {
    const pidData = readPidFile(runName);
    if (!pidData) return null;
    if (isProcessAlive(pidData.pid)) return null;
    // Can't get real exit code of detached process; 1 indicates abnormal exit
    return 1;
  }

  getRunLogs(runName: string, tailLines?: number): string | null {
    const pidData = readPidFile(runName);
    if (!pidData) return null;

    try {
      const content = readFileSync(pidData.logFile, 'utf-8');
      if (!tailLines) return content;
      const lines = content.split('\n');
      return lines.slice(-tailLines).join('\n');
    } catch {
      return null;
    }
  }

  stopRun(runName: string): boolean {
    const pidData = readPidFile(runName);
    if (!pidData) return false;

    try {
      process.kill(pidData.pid, 'SIGTERM');
      // Give it a moment, then SIGKILL if still alive
      const start = Date.now();
      while (Date.now() - start < 5_000) {
        if (!isProcessAlive(pidData.pid)) return true;
        Bun.sleepSync(100);
      }
      // Force kill
      try {
        process.kill(pidData.pid, 'SIGKILL');
      } catch {
        // Already dead
      }
      return true;
    } catch {
      // Process already dead or permission denied
      return false;
    }
  }

  removeRun(runName: string): void {
    const pidData = readPidFile(runName);
    if (!pidData) return;

    // Kill if still running
    if (isProcessAlive(pidData.pid)) {
      try {
        process.kill(pidData.pid, 'SIGKILL');
      } catch {
        // Best effort
      }
    }

    // Remove PID file
    removePidFile(runName);

    // Optionally remove log file
    try {
      if (existsSync(pidData.logFile)) {
        unlinkSync(pidData.logFile);
      }
    } catch {
      // Best effort
    }
  }

  discoverRunningRuns(): string[] {
    const dir = pidFileDir();
    if (!existsSync(dir)) return [];

    try {
      const files = readdirSync(dir) as string[];
      const running: string[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const runName = file.replace(/\.json$/, '');
        const pidData = readPidFile(runName);
        if (pidData && isProcessAlive(pidData.pid)) {
          running.push(runName);
        }
      }

      return running;
    } catch {
      return [];
    }
  }

  followOutput(runName: string, _since?: string): FollowHandle | null {
    const pidData = readPidFile(runName);
    if (!pidData || !existsSync(pidData.logFile)) return null;

    try {
      const proc = Bun.spawn(
        ['tail', '-f', pidData.logFile],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      return {
        process: { kill: () => proc.kill() },
        stdout: proc.stdout as ReadableStream<Uint8Array>,
        exited: proc.exited.then(code => code ?? 0),
      };
    } catch {
      return null;
    }
  }

  usesSandbox(): boolean {
    return false;
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    return [
      { cmd: 'git', name: 'git', hint: 'Required tool not found: git' },
      { cmd: 'claude', name: 'claude', hint: 'Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code' },
      // No lazy-agent check — in host-process mode, the supervisor IS lazy itself.
    ];
  }

  mcpServerConfig(taskId: string, worktreePath: string): { command: string; args: string[] } {
    const lazyCmd = getLazyCliCommand();
    return {
      command: lazyCmd[0],
      args: [...lazyCmd.slice(1), 'mcp', '--task-id', taskId, '--worktree', worktreePath],
    };
  }

  // ----- Builder support -----

  getBuilderInstructions(): string {
    return hostProcessBuilderInstructions;
  }

  async launchBuilderInteractive(
    lazyRoot: string,
    systemPrompt: string,
    _builderConfigPath: string,
    claudeExtraArgs: string[],
    debug?: boolean,
  ): Promise<number> {
    // Host-process mode: launch Claude Code directly (no supervisor, no MCP proxy).
    // MCP tools are not available in this mode — the builder relies on Claude Code's
    // built-in capabilities plus any tools the user has configured.
    // We still capture the conversation after exit by reading JSONL files.

    const claudeArgs = [
      'claude',
      '--append-system-prompt', systemPrompt,
      ...claudeExtraArgs,
    ];

    if (debug) {
      console.log('[DEBUG] Launching Claude Code directly:', claudeArgs.join(' '));
    }

    logger.info('Launching Claude Code...');

    // Snapshot JSONL file times before launch for conversation capture
    const {
      encodeProjectPath,
      discoverAllProjectSessions,
      parseConversation,
      extractSummary,
      conversationStats,
    } = await import('../import/claude-code-logs');
    const { toStoredConversation } = await import('../import/conversation-storage');

    const claudeHome = homedir();
    const beforeTimes = getSessionFileTimes(claudeHome, lazyRoot, encodeProjectPath);

    const proc = Bun.spawn(claudeArgs, {
      cwd: lazyRoot,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });

    const exitCode = await proc.exited;

    // Capture conversation from JSONL files
    try {
      const afterTimes = getSessionFileTimes(claudeHome, lazyRoot, encodeProjectPath);
      const sessionFile = findNewOrModifiedFile(beforeTimes, afterTimes);

      if (sessionFile) {
        const sessionId = sessionFile.replace(/\.jsonl$/, '');
        const available = await discoverAllProjectSessions(lazyRoot);
        const match = available.find(s => s.sessionId === sessionId);

        if (match) {
          const { createStorage } = await import('../storage');
          const storage = await createStorage(lazyRoot);
          try {
            const conversation = await parseConversation(match.projectPath, match.sessionId);
            const summary = extractSummary(conversation);
            const stats = conversationStats(conversation);
            const stored = toStoredConversation(conversation, summary, stats);
            await storage.saveConversation(stored);
            logger.debug(`Builder conversation captured: ${sessionId}`);
            console.error(`\nBuilder session: ${sessionId}`);
          } finally {
            await storage.close();
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to capture builder conversation: ${msg}`);
    }

    return exitCode;
  }
}
