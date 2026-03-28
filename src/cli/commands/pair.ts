import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, symlinkSync, unlinkSync, lstatSync, readdirSync, readFileSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, resolveTaskOrExit, getWorktreePath } from '../helpers';
import { isBlockedStatus } from '../../types';
import { theme } from '../theme';
import { getCurrentBranch, getCurrentSha, getNewCommits, getDiffStat } from '../../git/operations';
import {
  acquirePairingLock,
  removePairingLock,
  checkPairingLock,
  forceRemovePairingLock,
} from '../../utils/pairing-lock';
import { runClaude, hasAuthEnv } from '../../capture/claude';
import { loadConfig } from '../../config/loader';
import { logger, LogLevel } from '../../utils/logger';
import { encodeProjectPath } from '../../import/claude-code-logs';
import { snapshotSessionFiles, captureConversation } from '../../import/capture-session';
import { getActor } from '../../constants';
import { spawnSync, spawn } from '../../utils/spawn';

const SANDBOX_DIR = '.lazy-task-sandbox';
/** Max characters of conversation transcript to include in the summary prompt */
const MAX_TRANSCRIPT_CHARS = 20_000;

/**
 * Read the Claude session JSONL file and extract a human-readable conversation
 * transcript. Returns the last portion of the conversation (capped at
 * MAX_TRANSCRIPT_CHARS) to stay within prompt limits.
 */
function readSessionTranscript(worktreePath: string, sessionId: string, sinceTimestamp?: string): string | null {
  const encodedPath = encodeProjectPath(worktreePath);

  // Check multiple locations where the JSONL might live:
  // 1. Host ~/.claude/projects/ (direct pairing or persisted symlink)
  // 2. Sandbox .lazy-task-sandbox/.claude/projects/ (supervisor-created sessions)
  const candidates = [
    join(homedir(), '.claude', 'projects', encodedPath, `${sessionId}.jsonl`),
    join(worktreePath, SANDBOX_DIR, '.claude', 'projects', encodedPath, `${sessionId}.jsonl`),
  ];

  let jsonlPath: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      jsonlPath = candidate;
      break;
    }
  }

  if (!jsonlPath) {
    return null;
  }

  const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim());
  const transcript: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Skip entries from before the pairing session started
      if (sinceTimestamp && obj.timestamp && obj.timestamp < sinceTimestamp) {
        continue;
      }
      if (obj.type === 'user') {
        const content = obj.message?.content;
        if (typeof content === 'string') {
          transcript.push(`Human: ${content}`);
        } else if (Array.isArray(content)) {
          const texts = content
            .filter((c: { type: string }) => c.type === 'text')
            .map((c: { text: string }) => c.text);
          if (texts.length > 0) {
            transcript.push(`Human: ${texts.join('\n')}`);
          }
        }
      } else if (obj.type === 'assistant') {
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          const texts = content
            .filter((c: { type: string }) => c.type === 'text')
            .map((c: { text: string }) => c.text);
          if (texts.length > 0) {
            transcript.push(`Assistant: ${texts.join('\n')}`);
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (transcript.length === 0) return null;

  // Take the tail of the transcript to stay within limits
  let result = transcript.join('\n\n');
  if (result.length > MAX_TRANSCRIPT_CHARS) {
    result = '...(earlier conversation truncated)...\n\n' + result.slice(-MAX_TRANSCRIPT_CHARS);
  }
  return result;
}

/**
 * Symlink session files from the sandbox's .claude/projects into the user's
 * ~/.claude/projects so that `claude --resume` can find them on the host.
 *
 * Returns a cleanup function that removes the symlinks we created.
 */
interface BridgeResult {
  /** True if the session JSONL is accessible at the host's ~/.claude/projects/ */
  accessible: boolean;
  /** Cleanup function that removes any symlinks we created */
  cleanup: () => void;
}

function bridgeSessionFiles(worktreePath: string, sessionId?: string): BridgeResult {
  const sandboxClaudeDir = join(worktreePath, SANDBOX_DIR, '.claude');
  const encodedPath = encodeProjectPath(worktreePath);
  const sandboxProjectDir = join(sandboxClaudeDir, 'projects', encodedPath);
  const hostProjectsDir = join(homedir(), '.claude', 'projects');
  const hostProjectDir = join(hostProjectsDir, encodedPath);

  const noop: BridgeResult = { accessible: false, cleanup: () => {} };

  // If there's no sandbox dir, check if the session is already accessible
  // at the host location (host-process runner writes directly to ~/.claude/).
  if (!existsSync(sandboxProjectDir)) {
    if (sessionId) {
      const hostSessionFile = join(hostProjectDir, `${sessionId}.jsonl`);
      if (existsSync(hostSessionFile)) {
        return { accessible: true, cleanup: () => {} };
      }
    }
    return noop;
  }

  // If the session file already exists at the destination, check if it's
  // actually the same file (e.g., Docker bind mount). If so, no bridging needed.
  if (sessionId) {
    const sessionFile = `${sessionId}.jsonl`;
    const destFile = join(hostProjectDir, sessionFile);
    const srcFile = join(sandboxProjectDir, sessionFile);
    if (existsSync(destFile) && existsSync(srcFile)) {
      try {
        const destStat = lstatSync(destFile);
        const srcStat = lstatSync(srcFile);
        if (destStat.ino === srcStat.ino && destStat.dev === srcStat.dev) {
          return { accessible: true, cleanup: () => {} };
        }
      } catch {
        // Fall through to symlink approach
      }
    }
  }

  // Ensure host projects dir exists
  mkdirSync(hostProjectsDir, { recursive: true });

  // Strategy: if the host project dir doesn't exist, symlink the entire
  // sandbox project dir. If it does exist (host has its own sessions for
  // this project), symlink individual session files that don't conflict.
  let hostDirExisted = false;
  try {
    lstatSync(hostProjectDir);
    hostDirExisted = true;
  } catch {
    hostDirExisted = false;
  }

  const createdSymlinks: string[] = [];

  if (!hostDirExisted) {
    // No host project dir — symlink the entire sandbox project dir
    try {
      symlinkSync(sandboxProjectDir, hostProjectDir);
      createdSymlinks.push(hostProjectDir);
    } catch {
      return noop;
    }
  } else {
    // Host project dir exists — symlink individual session files
    const entries = readdirSync(sandboxProjectDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(sandboxProjectDir, entry.name);
      const destPath = join(hostProjectDir, entry.name);

      // Don't overwrite existing files (could be from a real host session)
      try {
        lstatSync(destPath);
        continue;
      } catch {
        // Doesn't exist — safe to create symlink
      }

      try {
        symlinkSync(srcPath, destPath);
        createdSymlinks.push(destPath);
      } catch {
        // Best effort — continue with other files
      }
    }
  }

  // Verify the session file is actually accessible now
  let accessible = true;
  if (sessionId) {
    const sessionFile = join(hostProjectDir, `${sessionId}.jsonl`);
    accessible = existsSync(sessionFile);
  }

  const cleanup = () => {
    for (const linkPath of createdSymlinks) {
      try {
        const stat = lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          unlinkSync(linkPath);
        }
      } catch {
        // Best effort cleanup
      }
    }
  };

  return { accessible, cleanup };
}

/**
 * Try to detect a task from the current git branch.
 * Returns the task ref (code or short ID) if the branch matches the
 * configured branch prefix pattern (e.g. `lazy/<ref>`), or null if
 * on a non-task branch.
 */
function detectTaskRefFromBranch(branchPrefix: string): string | null {
  try {
    const branch = getCurrentBranch();
    const prefix = `${branchPrefix}/`;
    if (branch.startsWith(prefix)) {
      return branch.slice(prefix.length);
    }
  } catch {
    // Not in a git repo or other error — treat as no task
  }
  return null;
}

/**
 * Launch Claude Code in the current directory with no task context.
 * Captures the conversation into lazy's storage after exit.
 */
async function pairBranchless(root: string): Promise<void> {
  console.log(`\nLaunching Claude Code in ${process.cwd()}...`);
  console.log(`(no task context — conversation will be captured for search)\n`);

  const beforeSnapshot = snapshotSessionFiles(root);

  // Launch Claude Code interactively in the current directory
  const proc = spawn(['claude'], {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await proc.exited;

  // Capture conversation from JSONL files
  const sessionId = await captureConversation(root, beforeSnapshot, 'Pairing');
  if (sessionId) {
    console.log(`\nConversation captured (session ${sessionId.substring(0, 8)}...)`);
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

export async function commandPair(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'unlock', takesValue: false },
    { name: 'no-summary', takesValue: false },
  ], 'pair');

  let taskId = parsed.positional[0];
  const unlock = parsed.flags.get('unlock') === true;
  const noSummary = parsed.flags.get('no-summary') === true;

  const root = requireLazyRoot();

  // If no task argument, try to detect from current branch
  if (!taskId) {
    const config = loadConfig(root);
    const detectedRef = detectTaskRefFromBranch(config.git.default_branch_prefix);

    if (detectedRef) {
      // On a lazy/* branch — use the ref as the task identifier
      taskId = detectedRef;
    } else if (unlock) {
      // --unlock without a task and not on a task branch
      console.error('Error: --unlock requires a task argument or a lazy/* branch.');
      process.exit(1);
    } else {
      // On main or non-task branch — launch branchless pairing
      await pairBranchless(root);
      return;
    }
  }

  const storage = await requireStorage();

  try {
    // Resolve task
    const task = await resolveTaskOrExit(storage, taskId);
    const taskShortId = shortId(task.id);
    const worktreePath = getWorktreePath(root, task);

    // Get session — task must have been started
    const sess = await storage.getSessionByTaskId(task.id);
    if (!sess) {
      console.error(`Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
      process.exit(1);
    }

    if (sess.ended_at) {
      console.error(`Session has ended (${sess.outcome ?? 'ended'}). Cannot pair on a completed task.`);
      process.exit(1);
    }

    // Check worktree exists
    if (!existsSync(worktreePath)) {
      console.error(`Worktree not found at ${worktreePath}. Session may have been cleaned up.`);
      process.exit(1);
    }

    // Handle --unlock: force-remove pairing lock, transition status, and exit
    if (unlock) {
      const removed = forceRemovePairingLock(worktreePath);
      if (removed) {
        console.log(`Pairing lock removed for task ${theme.taskId(displayId(task))}.`);
      } else {
        console.log(`No pairing lock found for task ${theme.taskId(displayId(task))}.`);
      }
      // If the task is stuck in 'pairing' state, transition it back to 'blocked'
      if (task.status === 'pairing') {
        await storage.updateTaskStatus(task.id, 'blocked', getActor());
        await storage.updateTaskMetadata(task.id, 'pairing_pid', '');
        await storage.updateTaskMetadata(task.id, 'pairing_started_at', '');
        console.log(`Task status restored to blocked.`);
      }
      return;
    }

    // Task must be blocked, conflict, or interrupted to pair
    if (!isBlockedStatus(task.status) && task.status !== 'interrupted') {
      if (task.status === 'working') {
        console.error(`Task ${displayId(task)} is currently working under the supervisor.`);
        console.error(`Wait for it to finish, or check status with: lazy status ${displayId(task)}`);
      } else if (task.status === 'pairing') {
        console.error(`Task ${displayId(task)} is already in a pairing session.`);
        console.error(`End the current pairing session first, or clear the lock with: lazy pair ${displayId(task)} --unlock`);
      } else {
        console.error(`Task ${displayId(task)} is in state '${task.status}'. Can only pair with blocked, conflict, or interrupted tasks.`);
      }
      process.exit(1);
    }

    // Check for existing pairing lock
    const existingPairingLock = checkPairingLock(worktreePath);
    if (existingPairingLock) {
      console.error(`Task ${displayId(task)} is already being paired on (PID ${existingPairingLock.pid}).`);
      console.error(`Started at: ${existingPairingLock.started_at}`);
      console.error(`\nIf this is stale, clear it with: lazy pair ${displayId(task)} --unlock`);
      process.exit(1);
    }

    // Pre-flight: check API token availability for post-session summarization.
    // The interactive Claude session itself may work via `claude` CLI's own auth,
    // but our summarization step calls the API directly and needs an explicit token.
    if (!noSummary && !hasAuthEnv()) {
      console.error('Error: No API token found (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY).');
      console.error('Pairing requires a token for post-session summarization.');
      console.error('Set one of these env vars, or use --no-summary to skip summarization.');
      process.exit(1);
    }

    // Task must have a claude session ID to resume (or we'll start fresh)
    const claudeSessionId = sess.agent_session_id;
    if (!claudeSessionId) {
      console.log('No existing Claude session to resume. Claude Code will start a fresh session.');
    }

    // Record HEAD before pairing starts
    const headBefore = getCurrentSha(worktreePath);

    // Acquire pairing lock
    acquirePairingLock(worktreePath);

    // Transition task to 'pairing' state — this locks the task against
    // other state-changing operations (accept, reject, unblock, close, start, resume)
    await storage.updateTaskStatus(task.id, 'pairing', getActor());

    // Store pairing metadata for reconciliation (stale pairing detection)
    await storage.updateTaskMetadata(task.id, 'pairing_pid', String(process.pid));
    await storage.updateTaskMetadata(task.id, 'pairing_started_at', new Date().toISOString());

    console.log(`\nPairing on task ${theme.taskId(taskShortId)}: ${task.goal}`);
    console.log(`  ${theme.label('Branch:')}    ${sess.git_branch}`);
    console.log(`  ${theme.label('Worktree:')}  ${worktreePath}`);
    if (claudeSessionId) {
      console.log(`  ${theme.label('Session:')}   ${claudeSessionId.substring(0, 16)}...`);
    }
    console.log(`\nLaunching Claude Code... (exit Claude Code to end pairing)\n`);

    let exitCode = 0;
    const pairingStartedAt = new Date().toISOString();

    // Bridge session files from sandbox into host ~/.claude/projects/ so
    // that `claude --resume` can find them without overriding CLAUDE_CONFIG_DIR
    // (which would also lose credentials and user preferences).
    const bridge = bridgeSessionFiles(worktreePath, claudeSessionId ?? undefined);

    if (claudeSessionId && !bridge.accessible) {
      bridge.cleanup();
      removePairingLock(worktreePath);
      console.error(`Could not make session ${claudeSessionId.substring(0, 8)}... accessible to Claude Code.`);
      console.error(`The session data in the sandbox could not be bridged to ~/.claude/projects/.`);
      process.exit(1);
    }

    try {
      // Build claude command
      const claudeArgs = ['claude'];
      if (claudeSessionId) {
        claudeArgs.push('--resume', claudeSessionId);
      }

      // Launch Claude Code interactively in the worktree
      const result = spawnSync(claudeArgs, {
        cwd: worktreePath,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: {
          ...process.env,
          LAZY_TASK: taskShortId,
        },
      });

      exitCode = result.exitCode;
    } finally {
      // Always transition back to blocked, clean up symlinks, and release lock.
      // The transition back to 'blocked' MUST happen even if Claude crashes.
      try {
        await storage.updateTaskStatus(task.id, 'blocked', getActor());
        // Clear pairing metadata
        await storage.updateTaskMetadata(task.id, 'pairing_pid', '');
        await storage.updateTaskMetadata(task.id, 'pairing_started_at', '');
      } catch {
        // Best effort — storage may be unavailable
        logger.warn(`Failed to transition task ${taskShortId} back to blocked after pairing`);
      }
      bridge.cleanup();
      removePairingLock(worktreePath);
    }

    // --- Post-pairing: capture what happened ---

    // Detect new commits since pairing started
    let newCommits: { sha: string; message: string }[] = [];
    try {
      const headAfter = getCurrentSha(worktreePath);
      if (headAfter !== headBefore) {
        newCommits = getNewCommits(headBefore, worktreePath);
      }
    } catch {
      // Best effort — worktree may be in a weird state
    }

    // Record new commits in storage
    for (const commit of newCommits) {
      try {
        await storage.createCommit(sess.id, commit.sha, commit.message);
      } catch {
        // May already be recorded
      }
    }

    // Build turn content summarizing the pairing session
    let turnContent = '';
    let summaryGenerated = false;

    // Read conversation transcript from the Claude session JSONL
    let transcript: string | null = null;
    if (claudeSessionId) {
      transcript = readSessionTranscript(worktreePath, claudeSessionId, pairingStartedAt);
    }

    // Build context for the summarizer
    const contextParts: string[] = [];

    if (transcript) {
      contextParts.push(`Conversation transcript:\n${transcript}`);
    }

    if (newCommits.length > 0) {
      const headAfter = getCurrentSha(worktreePath);
      const diffStat = getDiffStat(headBefore, headAfter, worktreePath);
      const commitDetails = newCommits
        .map(c => `${c.sha.substring(0, 7)}: ${c.message}`)
        .join('\n');
      contextParts.push(`Commits made (${newCommits.length}):\n${commitDetails}`);
      contextParts.push(`Files changed:\n${diffStat}`);
    }

    // Attempt AI summary if we have any context (conversation or commits)
    // and summarization is not explicitly disabled.
    if (contextParts.length > 0 && !noSummary) {
      try {
        const summaryPrompt = `Summarize this pairing session in 2-3 sentences. Focus on what was discussed, decided, and accomplished.

${contextParts.join('\n\n')}

Keep the summary concise and factual.`;

        console.log(`\n${theme.label('Summarizing pairing session...')}`);

        // Suppress logger.info output from runClaude internals (e.g. "Running Claude Code...")
        logger.configure({ consoleLevel: LogLevel.WARN });

        const sandboxPath = join(worktreePath, SANDBOX_DIR);
        const pairConfig = loadConfig(root);
        const binary = (pairConfig.runner.type === 'docker' || pairConfig.runner.type === 'podman') ? pairConfig.runner.type : 'docker';
        const response = await runClaude(summaryPrompt, {
          worktreePath,
          sandboxPath,
        }, false, false, 'haiku', binary);

        logger.configure({ consoleLevel: LogLevel.INFO });

        if (response.result && response.result.trim()) {
          turnContent = `[pairing session]\n\n${response.result.trim()}`;
          summaryGenerated = true;
          console.log(`${theme.label('Summary:')} ${response.result.trim()}\n`);
        }
      } catch (err) {
        logger.configure({ consoleLevel: LogLevel.INFO });
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(`  ${theme.label('Summary generation failed')} (will use commit list instead)`);
        logger.warn(`Failed to generate AI summary: ${errorMsg}`);
      }
    } else if (contextParts.length > 0 && noSummary) {
      console.log(`\n  Skipping AI summary (--no-summary). Using commit list.`);
    }

    // Fall back to basic description if no AI summary generated
    if (!turnContent) {
      const turnLines: string[] = ['[pairing session]'];
      if (newCommits.length > 0) {
        turnLines.push('');
        turnLines.push(`Commits made during pairing (${newCommits.length}):`);
        for (const c of newCommits) {
          turnLines.push(`  ${c.sha.substring(0, 7)} ${c.message}`);
        }
      } else {
        turnLines.push('No new commits were made during this pairing session.');
      }
      turnContent = turnLines.join('\n');
    }

    // Record the pairing turn
    const nextSeq = await storage.getNextTurnSequence(sess.id);
    let headAfter: string;
    try {
      headAfter = getCurrentSha(worktreePath);
    } catch {
      headAfter = headBefore;
    }
    await storage.createTurn({
      sessionId: sess.id,
      sequence: nextSeq,
      role: 'human',
      content: turnContent,
      startSha: headBefore,
      endSha: headAfter,
      actor: getActor(),
    });

    // Print summary
    console.log(`\nPairing session ended for task ${theme.taskId(taskShortId)}.`);
    if (newCommits.length > 0) {
      console.log(`  ${theme.label('Commits:')} ${newCommits.length} new commit${newCommits.length === 1 ? '' : 's'}`);
      for (const c of newCommits) {
        console.log(`    ${theme.commitSha(c.sha.substring(0, 7))} ${c.message}`);
      }
    }
    if (summaryGenerated) {
      console.log(`  ${theme.label('Summary:')} AI-generated summary included in turn`);
    }
    console.log(`  ${theme.label('Turn:')} recorded as turn ${nextSeq}`);

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } finally {
    await storage.close();
  }
}

export function pairUsage(): void {
  console.log(`Usage: lazy pair [task_id] [--unlock] [--no-summary]

Open an interactive Claude Code session, context-aware.

Three modes:
  1. lazy pair <task>           Pair on a specific task's worktree
  2. lazy pair                  On a lazy/* branch: detect the task, pair on it
  3. lazy pair                  On main or non-task branch: launch Claude Code
                                in the current directory (no task context)

In task mode (1 & 2), the task is locked during pairing — other commands
(start, unblock, accept, reject, resume) will refuse to operate until
pairing ends.

In branchless mode (3), Claude Code launches in the current directory with
no task context. The conversation is captured into lazy's storage so it's
searchable via lazy search.

Arguments:
  [task_id]    ID of the task to pair on (optional — detected from branch)

Options:
  --unlock       Force-remove a stale pairing lock (e.g., after a crash)
  --no-summary   Skip AI summarization of the pairing session

Examples:
  lazy pair abc123                   # Pair on a specific task
  lazy pair abc123 --unlock          # Clear a stale pairing lock
  lazy pair                          # Detect task from branch, or launch branchless
  lazy pair --no-summary             # Pair without AI summary`);
}
