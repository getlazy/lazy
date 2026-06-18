import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getHome } from '../../utils/home';
import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, resolveTaskOrExit, getWorktreePath } from '../helpers';
import { bridgeSessionFiles, summarizeSandboxSessions, type SandboxSessionSummary } from './pair-bridge';
import { isBlockedStatus } from '../../types';
import { theme } from '../theme';
import { isTTY, promptLine } from '../editor';
import { getCurrentBranch, getCurrentSha, getNewCommits, getDiffStat } from '../../git/operations';
import {
  acquirePairingLock,
  removePairingLock,
  checkPairingLock,
  forceRemovePairingLock,
} from '../../utils/pairing-lock';
import { runClaude } from '../../capture/claude';
import { loadConfig } from '../../config/loader';
import { resolveRoleTarget, preflightRoleTarget, targetEnvVars, anthropicEnvVarsFromProcess } from '../../utils/role-target';
import { createDriver } from '../../remote';
import { isOfflineMode } from '../../utils/offline';
import { logger, LogLevel } from '../../utils/logger';
import { encodeProjectPath } from '../../import/claude-code-logs';
import { snapshotSessionFiles, captureConversation } from '../../import/capture-session';
import { getActor } from '../../constants';
import { spawn } from '../../utils/spawn';

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
    join(getHome(), '.claude', 'projects', encodedPath, `${sessionId}.jsonl`),
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

function formatAge(ageMs: number | null): string {
  if (ageMs == null) return 'unknown age';
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  return `${w}w ago`;
}

function previewText(s: string, max = 80): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + '…';
}

function printCandidateList(staleId: string, summaries: SandboxSessionSummary[]): void {
  console.error('');
  console.error(
    `The stored session ID (${staleId.substring(0, 8)}...) doesn't match any file in the sandbox.`,
  );
  console.error('Multiple other sessions are present:');
  console.error('');
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    console.error(`  [${i + 1}] ${s.id.substring(0, 8)}...  (${formatAge(s.ageMs)})`);
    if (s.lastHumanText) {
      console.error(`      Last human: "${previewText(s.lastHumanText)}"`);
    } else {
      console.error('      (no human messages found)');
    }
  }
  console.error('');
}

/**
 * Multi-candidate stale-session recovery. Lists each candidate with its age
 * and last-human-message preview so the user can recognize the right one,
 * then prompts for selection. Returns the chosen session ID, or null if the
 * user aborted or we can't prompt (non-TTY).
 */
async function pickFromStaleSessions(
  worktreePath: string,
  staleId: string,
  candidates: string[],
): Promise<string | null> {
  const summaries = await summarizeSandboxSessions(worktreePath, candidates);
  printCandidateList(staleId, summaries);

  if (!isTTY()) {
    console.error('Cannot prompt for selection in non-interactive mode.');
    console.error('Re-run `lazy pair` in an interactive terminal to pick one of the sessions above.');
    return null;
  }

  const answer = (await promptLine(`Pick a session [1-${summaries.length}], or empty to abort`)).trim();
  if (!answer) return null;

  const idx = Number.parseInt(answer, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= summaries.length) {
    console.error(`Invalid selection: "${answer}". Aborting.`);
    return null;
  }
  return summaries[idx].id;
}

/**
 * Try to detect a task from the current git branch.
 * Returns the task ref (code or short ID) if the branch matches the
 * configured branch prefix pattern (e.g. `lazy/<ref>`), or null if
 * on a non-task branch.
 */
async function detectTaskRefFromBranch(branchPrefix: string): Promise<string | null> {
  try {
    const branch = await getCurrentBranch();
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
async function pairBranchless(root: string, resumeSessionId?: string, autonomous?: boolean): Promise<void> {
  console.log(`\nLaunching Claude Code in ${process.cwd()}...`);
  console.log(`(no task context — conversation will be captured for search)\n`);

  const beforeSnapshot = await snapshotSessionFiles(root);

  // Build claude command
  const claudeArgs = ['claude'];
  if (resumeSessionId) {
    claudeArgs.push('--resume', resumeSessionId);
  }
  if (autonomous) {
    claudeArgs.push('--dangerously-skip-permissions');
  }
  // Resolve the builder-role target (pair is an interactive builder session).
  // A local backend (ollama/proxy) forces its model and base-URL env; preflight
  // fails hard if it is unreachable rather than silently using anthropic.
  const config = await loadConfig(root);
  const pairTarget = resolveRoleTarget('builder', config);
  await preflightRoleTarget('builder', pairTarget);
  if (pairTarget.model) {
    claudeArgs.push('--model', pairTarget.model);
  }
  const pairEnvVars = targetEnvVars(pairTarget, anthropicEnvVarsFromProcess());

  // Launch Claude Code interactively in the current directory
  const proc = spawn(claudeArgs, {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    timeout: 0, // Long-running: interactive session runs until the user exits
    env: { ...process.env, ...Object.fromEntries(pairEnvVars.map(v => [v.key, v.value])) },
  });

  const exitCode = await proc.exited;

  // Capture conversation from JSONL files via the daemon.
  // Returns null if no conversation found or if capture failed (daemon unavailable).
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
    { name: 'resume', takesValue: true },
    { name: 'autonomous', takesValue: false },
    { name: 'yes', takesValue: false },
  ], 'pair');

  let taskId = parsed.positional[0];
  const unlock = parsed.flags.get('unlock') === true;
  const noSummary = parsed.flags.get('no-summary') === true;
  const resumeSessionId = parsed.flags.get('resume') as string | undefined;
  const autonomous = parsed.flags.get('autonomous') === true;
  const yes = parsed.flags.get('yes') === true;

  const root = requireLazyRoot();

  // Autonomous mode warnings and confirmation
  // Show these BEFORE other checks so users see the warnings even if something fails later
  if (autonomous) {
    console.log('');
    console.log('⚠ Autonomous mode: Claude Code will run without permission prompts.');
    console.log('⚠ WARNING: Pairing runs Claude Code directly on the host.');
    console.log('  The agent has unrestricted access to your system.');
    console.log('  Only proceed on an isolated/disposable machine.');
    console.log('');

    // Require confirmation
    if (isTTY()) {
      const response = await promptLine("Type 'yes' to proceed");
      if (response !== 'yes') {
        console.log('Aborted.');
        process.exit(0);
      }
    } else {
      if (!yes) {
        console.error('Error: --autonomous requires --yes flag in non-interactive mode.');
        process.exit(1);
      }
    }

    console.log('');
  }

  // If no task argument, try to detect from current branch
  if (!taskId) {
    const config = await loadConfig(root);
    const detectedRef = await detectTaskRefFromBranch(config.git.default_branch_prefix);

    if (detectedRef) {
      // On a lazy/* branch — use the ref as the task identifier
      taskId = detectedRef;

      // Validate: --resume is not allowed with task-based pairing
      if (resumeSessionId) {
        console.error('Error: --resume is only valid in branchless mode (no task argument).');
        console.error('Task-based pairing resumes sessions automatically.');
        process.exit(1);
      }
    } else if (unlock) {
      // --unlock without a task and not on a task branch
      console.error('Error: --unlock requires a task argument or a lazy/* branch.');
      process.exit(1);
    } else {
      // On main or non-task branch — launch branchless pairing
      await pairBranchless(root, resumeSessionId, autonomous);
      return;
    }
  } else {
    // Task ID was explicitly provided — validate that --resume is not used
    if (resumeSessionId) {
      console.error('Error: --resume is only valid in branchless mode (no task argument).');
      console.error('Task-based pairing resumes sessions automatically.');
      process.exit(1);
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

    // Credential enforcement is no longer done here. The daemon is the single
    // enforcement point: `lazy pair` auto-starts the daemon (ensureDaemon),
    // which refuses to start without a Claude Code OAuth token / Anthropic API
    // key. A missing credential therefore surfaces as an actionable daemon
    // error before we ever reach this point — clients pass through, they don't
    // re-enforce. (Summarization runs in the same environment the daemon gate
    // already validated, so it has the credential it needs.)

    // Task must have a claude session ID to resume (or we'll start fresh)
    let claudeSessionId = sess.agent_session_id;
    if (!claudeSessionId) {
      console.log('No existing Claude session to resume. Claude Code will start a fresh session.');
    }

    // Record HEAD before pairing starts
    const headBefore = await getCurrentSha(worktreePath);

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
    let bridge = bridgeSessionFiles(worktreePath, claudeSessionId ?? undefined);

    // Stale-session fallback: the stored session ID doesn't correspond to any
    // JSONL in the sandbox, but the sandbox does contain sessions. This happens
    // when Claude Code rotated the session ID (auto-compact, --resume fallback)
    // or when the user switched computers so the DB and sandbox are out of sync.
    if (
      claudeSessionId &&
      !bridge.accessible &&
      bridge.availableSandboxSessions.length === 1
    ) {
      const recoveredId = bridge.availableSandboxSessions[0];
      console.warn('');
      console.warn(
        `Warning: stored session ID ${claudeSessionId.substring(0, 8)}... is stale; ` +
        `resuming the sandbox's only session ${recoveredId.substring(0, 8)}... instead.`
      );
      console.warn('Updating the DB so subsequent operations use the recovered session.');
      console.warn('');
      // Durable DB update BEFORE we launch Claude Code — a crash during pair
      // must not lose this reconciliation (otherwise the next pair drifts again).
      await storage.updateSessionClaudeId(sess.id, recoveredId);
      bridge.cleanup();
      claudeSessionId = recoveredId;
      bridge = bridgeSessionFiles(worktreePath, recoveredId);
    }

    // Multi-candidate stale recovery: prompt the user to pick by showing
    // recognition cues (age + last human message). We refuse to auto-pick.
    if (
      claudeSessionId &&
      !bridge.accessible &&
      bridge.availableSandboxSessions.length > 1
    ) {
      const candidates = bridge.availableSandboxSessions;
      bridge.cleanup();
      const recoveredId = await pickFromStaleSessions(worktreePath, claudeSessionId, candidates);
      if (recoveredId) {
        // Durable DB update BEFORE Claude Code launches — a crash must not
        // lose this reconciliation (otherwise the next pair drifts again).
        await storage.updateSessionClaudeId(sess.id, recoveredId);
        claudeSessionId = recoveredId;
        bridge = bridgeSessionFiles(worktreePath, recoveredId);
      } else {
        // User-initiated abort (empty input, invalid input, or non-TTY).
        // Per "principle of least surprise": don't dump bridge diagnostics on
        // top of the picker output the user just walked away from. Roll back
        // pairing state and exit with a single line.
        removePairingLock(worktreePath);
        try {
          await storage.updateTaskStatus(task.id, 'blocked', getActor());
          await storage.updateTaskMetadata(task.id, 'pairing_pid', '');
          await storage.updateTaskMetadata(task.id, 'pairing_started_at', '');
        } catch {
          // Best effort — the reconciler will clean this up eventually
        }
        console.error('Aborted; no session selected.');
        process.exit(1);
      }
    }

    if (claudeSessionId && !bridge.accessible) {
      bridge.cleanup();
      removePairingLock(worktreePath);
      // Roll back the pairing state transition since we never actually paired.
      try {
        await storage.updateTaskStatus(task.id, 'blocked', getActor());
        await storage.updateTaskMetadata(task.id, 'pairing_pid', '');
        await storage.updateTaskMetadata(task.id, 'pairing_started_at', '');
      } catch {
        // Best effort — the reconciler will clean this up eventually
      }
      console.error(`Could not make session ${claudeSessionId.substring(0, 8)}... accessible to Claude Code.`);
      console.error('');
      console.error('Bridging diagnostics:');
      for (const line of bridge.diagnostics) {
        console.error(`  ${line}`);
      }
      if (bridge.availableSandboxSessions.length === 0) {
        console.error('');
        console.error('No session JSONL files were found in the sandbox. The agent may never have');
        console.error('written a session for this task, or the sandbox was cleared.');
      }
      process.exit(1);
    }

    try {
      // Build claude command
      const claudeArgs = ['claude'];
      if (claudeSessionId) {
        claudeArgs.push('--resume', claudeSessionId);
      }
      if (autonomous) {
        claudeArgs.push('--dangerously-skip-permissions');
      }
      // Resolve the builder-role target (pair is an interactive builder session).
      const config = await loadConfig(root);
      const pairTarget = resolveRoleTarget('builder', config);
      await preflightRoleTarget('builder', pairTarget);
      if (pairTarget.model) {
        claudeArgs.push('--model', pairTarget.model);
      }
      const pairEnvVars = targetEnvVars(pairTarget, anthropicEnvVarsFromProcess());

      // Launch Claude Code interactively in the worktree. Use ASYNC spawn +
      // await (not spawnSync): inherited stdio still gives a normal interactive
      // terminal, but the event loop keeps running for the duration of the
      // session. That matters because `lazy pair` auto-starts the daemon as a
      // CHILD process (via ensureDaemon); spawnSync would freeze the event loop
      // for the whole session, so if that daemon child dies (e.g. another
      // terminal runs `lazy upgrade`), the runtime can never reap it and it
      // becomes a zombie that holds the storage lock. Keeping the loop alive
      // lets the runtime reap exited children. (pairBranchless does the same.)
      const proc = spawn(claudeArgs, {
        cwd: worktreePath,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        timeout: 0, // Long-running: interactive session runs until the user exits
        env: {
          ...process.env,
          ...Object.fromEntries(pairEnvVars.map(v => [v.key, v.value])),
          LAZY_TASK: taskShortId,
        },
      });

      exitCode = await proc.exited;
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

    // Best-effort push of the task branch so commits from the pairing session
    // reach the remote immediately, rather than waiting for the next sync tick.
    // Failures here MUST NOT block commit recording or turn creation below.
    if (sess.git_branch) {
      try {
        const offline = await isOfflineMode(join(root, '.lazy'));
        if (!offline) {
          const config = await loadConfig(root);
          const driver = createDriver(config);
          await driver.pushBranch(sess.git_branch);
        }
      } catch (err) {
        logger.warn(`Failed to push branch ${sess.git_branch} after pairing (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
    }

    // Detect new commits since pairing started
    let newCommits: { sha: string; message: string }[] = [];
    try {
      const headAfter = await getCurrentSha(worktreePath);
      if (headAfter !== headBefore) {
        newCommits = await getNewCommits(headBefore, worktreePath);
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
      const headAfter = await getCurrentSha(worktreePath);
      const diffStat = await getDiffStat(headBefore, headAfter, worktreePath);
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
        const pairConfig = await loadConfig(root);
        const binary = (pairConfig.runner.type === 'docker' || pairConfig.runner.type === 'podman') ? pairConfig.runner.type : 'docker';
        const response = await runClaude(summaryPrompt, {
          worktreePath,
          sandboxPath,
        }, false, false, 'claude-haiku-4-5-20251001', binary);

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
      headAfter = await getCurrentSha(worktreePath);
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
  console.log(`Usage: lazy pair [task_id] [--unlock] [--no-summary] [--resume <session_id>] [--autonomous] [--yes]

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
  --unlock               Force-remove a stale pairing lock (e.g., after a crash)
  --no-summary           Skip AI summarization of the pairing session
  --resume <session_id>  Resume a previous Claude Code session (branchless mode only)
  --autonomous           Run without permission prompts (adds --dangerously-skip-permissions)
  --yes                  Auto-confirm prompts (required with --autonomous in non-TTY mode)

Examples:
  lazy pair abc123                   # Pair on a specific task
  lazy pair abc123 --unlock          # Clear a stale pairing lock
  lazy pair                          # Detect task from branch, or launch branchless
  lazy pair --no-summary             # Pair without AI summary
  lazy pair --resume abc123def       # Resume previous branchless session
  lazy pair --autonomous             # Run without permission prompts`);
}
