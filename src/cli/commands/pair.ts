/**
 * `lazy pair` — join a task's agent session interactively.
 *
 * WHERE THE SESSION RUNS
 * ----------------------
 * In the task's CONTAINER, the same place its supervised turns run. Pairing used
 * to launch the agent as a host process against the task worktree, which made it
 * the escape hatch for everything that did not work in a container and put an
 * agent with the human's own privileges on the human's own machine. The session's
 * agent home directory is now the sandbox mount the task's own turns already
 * write, so resume needs no bridging and no copying, and `--autonomous` is the
 * same trust decision as any supervised turn.
 *
 * Host execution still exists for branchless mode (no task, no worktree, no
 * container) and as an explicit `--host` opt-in on claude-code tasks. Both
 * require `--host` and say plainly what that means. There is deliberately NO
 * automatic fallback: if the container path fails, that is a container bug to
 * fix, not something pairing quietly routes around by running on the host instead.
 */

import { join } from 'path';
import { shortId, displayId, getWorktreePath } from '../../task/identity';
import { recordSessionCommits } from '../../task/session-commits';
import { existsSync, readFileSync } from 'fs';
import { getHome } from '../../utils/home';
import { SANDBOX_DIR } from '../../utils/sandbox';
import { ensureTaskClaudeConfig } from '../../task/claude-home';
import { requireLazyRoot, requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import {
  bridgeSessionFiles,
  listSandboxSessionIds,
  summarizeSandboxSessions,
  type BridgeResult,
  type SandboxSessionSummary,
} from './pair-bridge';
import { createContainerPairLauncher, stopOrphanedContainerPair } from './pair-container';
import { createRunnerFromType } from '../../runner';
import { hostRunnerRemovedMessage, isHostRunnerType } from '../../runner/host-runner-gate';
import { isBlockedStatus } from '../../types';
import { theme } from '../../render/theme';
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
import { pairSessionModel } from '../../task/launch-identity-view';
import { readProjectSettings, resolveProjectModel } from '../../daemon/project-settings';
import { runInteractiveSupervisor } from '../../supervisor/interactive';
import { createDriver } from '../../remote';
import { autoPushEnabled } from '../../remote/auto-push';
import { isOfflineMode } from '../../utils/offline';
import { logger, LogLevel } from '../../utils/logger';
import { encodeProjectPath } from '../../import/claude-code-logs';
import {
  snapshotSessionFiles,
  captureConversation,
  snapshotPiTaskSessionFiles,
  capturePiTaskConversations,
  type SessionSnapshot,
} from '../../import/capture-session';
import type { ParsedConversation } from '../../import/claude-code-logs';
import { markMachineOneshotPrompt } from '../../import/machine-oneshot';
import { getActor } from '../../constants';
import { getAgent } from '../../agent/registry';
import { profileForAgentName, DEFAULT_AGENT_PROFILE_NAME } from '../../config/agent-profiles';
import { parkTaskPaused } from '../../utils/paused-status';
import { boundCloneLogin, commandTaskTerminalBound } from './bound-session';
import { findLazyRoot } from '../../project-paths';
import { admitInteractiveOrExit } from '../usage-pause-preflight';

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

/**
 * Build a transcript in the same "Human:/Assistant:" shape
 * {@link readSessionTranscript} produces for Claude, from the pi conversations
 * capture already parsed — filtered to entries from this pairing session and
 * capped at MAX_TRANSCRIPT_CHARS. Returns null when nothing was said since
 * `sinceTimestamp`.
 *
 * Takes conversations rather than a session id on purpose. The id lazy has
 * stored is the id it LAUNCHED with, which may name a file this pairing never
 * touched; and one pairing can write more than one session file (a daemon
 * restart relaunches the agent), in which case summarizing only the newest
 * would drop everything said before the restart. Capture already knows exactly
 * which files this pairing owns, so it is the honest source.
 */
export function piPairingTranscript(
  conversations: ParsedConversation[],
  sinceTimestamp?: string,
): string | null {
  const lines = conversations.flatMap((c) => c.messages)
    // Same cutoff rule as the Claude reader: drop entries from before pairing
    // started, keep any without a timestamp (a message lazy cannot date is
    // more likely to be part of this session than provably not).
    .filter((m) => !(sinceTimestamp && m.timestamp && m.timestamp < sinceTimestamp))
    .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.text}`);
  if (lines.length === 0) return null;

  let result = lines.join('\n\n');
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
  // [usage_pause]: a branchless session runs on the builder role's credential;
  // a paused one refuses it before anything launches.
  await admitInteractiveOrExit('pair');

  console.log(`\nLaunching Claude Code in ${process.cwd()}...`);
  console.log(`(no task context — conversation will be captured for search)\n`);

  const beforeSnapshot = await snapshotSessionFiles(root);

  // Claude Code runs UNDER a supervisor, not directly: a daemon restart moves
  // the audit proxy to a new OS-assigned port and Claude Code never re-reads
  // ANTHROPIC_BASE_URL, so an unsupervised session silently keeps talking to a
  // dead address. The supervisor resolves the launch env (role target,
  // credentials, proxy) through resolveInteractiveLaunch exactly as this call
  // site used to, stops the session cleanly when the daemon generation changes,
  // and resumes it against the new one. See src/supervisor/interactive.ts.
  const { exitCode } = await runInteractiveSupervisor({
    kind: 'pair',
    root,
    cwd: process.cwd(),
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(autonomous ? { autonomous } : {}),
  });

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
  // A clone bound to Lazy Teams pairs with the task's session ON THE SERVER,
  // through Teams — nothing is launched on this machine (design doc §5.1).
  const boundRoot = findLazyRoot();
  if (boundRoot && await boundCloneLogin(boundRoot)) {
    await commandTaskTerminalBound('pair', boundRoot, args);
    return;
  }

  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'unlock', takesValue: false },
    { name: 'no-summary', takesValue: false },
    { name: 'resume', takesValue: true },
    { name: 'autonomous', takesValue: false },
    { name: 'yes', takesValue: false },
    { name: 'host', takesValue: false },
  ], 'pair');

  let taskId = parsed.positional[0];
  const unlock = parsed.flags.get('unlock') === true;
  const noSummary = parsed.flags.get('no-summary') === true;
  const resumeSessionId = parsed.flags.get('resume') as string | undefined;
  const autonomous = parsed.flags.get('autonomous') === true;
  const yes = parsed.flags.get('yes') === true;
  const hostRequested = parsed.flags.get('host') === true;

  const root = requireLazyRoot();

  // The autonomous warning is about HOST execution, so it belongs on the host
  // path only. In the container, permission prompts off is the same trust
  // decision the task's own supervised turns already make — warning about it
  // here would be theater, and would train people to type 'yes' at prompts.
  if (autonomous && hostRequested) {
    console.log('');
    console.log('⚠ Autonomous mode: the agent will run without permission prompts.');
    console.log('⚠ WARNING: --host runs the agent directly on your machine.');
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
        console.error('Error: --autonomous --host requires --yes in non-interactive mode.');
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
      // On main or non-task branch — branchless pairing. There is no task, no
      // worktree and no container here, so this genuinely runs on the host: it
      // is opt-in and labeled rather than the thing `lazy pair` does when it
      // cannot find a task.
      if (!hostRequested) {
        console.error('Not on a task branch, so there is no task container to pair in.');
        console.error('');
        console.error('Branchless pairing launches the agent directly on your machine, with none');
        console.error("of a task container's isolation. It is opt-in:");
        console.error('');
        console.error('  lazy pair --host                  # pair here, on the host');
        console.error('  lazy pair <task>                  # pair in that task\'s container');
        process.exit(1);
      }
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

    // Handle --unlock: stop an orphaned in-container session, force-remove the
    // pairing lock, transition status, and exit.
    if (unlock) {
      // Order matters: signal the abandoned agent BEFORE the lock goes away, so
      // a `lazy pair` racing this command cannot acquire the lock and start a
      // second session against the one we are about to kill.
      //
      // Clearing the lock alone was the old behaviour, and it left the actual
      // problem in place: the in-container agent that died without cleanup is
      // still running, still holding the session the next pair wants to resume.
      const stopped = await stopOrphanedContainerPair(task.id, worktreePath);
      if (stopped) {
        console.log(`Signalled the in-container pairing session for task ${theme.taskId(displayId(task))}.`);
      }
      const removed = forceRemovePairingLock(worktreePath);
      if (removed) {
        console.log(`Pairing lock removed for task ${theme.taskId(displayId(task))}.`);
      } else {
        console.log(`No pairing lock found for task ${theme.taskId(displayId(task))}.`);
      }
      // If the task is stuck in 'pairing' state, transition it back to 'blocked'
      if (task.status === 'pairing') {
        await parkTaskPaused(storage, task.id, getActor());
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

    // [usage_pause]: a pairing session spends the task's credential like a
    // turn, so a paused credential refuses it — before the status moves, the
    // lock is taken or anything launches. Judged once for the session: PEEKED
    // here, so the refusal comes early, and admitted (the one-shot override
    // taken, if that is what lets it through) only after pair's own refusals
    // below, so an override is never spent on a pair that is refused anyway.
    await admitInteractiveOrExit('pair', task.id, { peek: true });

    // Pairing is opt-in per agent. Refuse here — before the status moves to
    // `pairing`, before a lock is taken, and before any process launches.
    //
    // Cursor's gate was `false` for a security reason that pairing-in-the-
    // container removed: its chat lived in the worktree sandbox, lazy would not
    // copy agent-written history onto the host, and a HOST `cursor-agent` could
    // not read it there — so the session a human got had no memory of the work.
    // The session now runs against that same sandbox, so nothing is copied and
    // the history is simply there. See src/agent/cursor.ts.
    const pairConfigEarly = await loadConfig(root);
    // `task.agent_id` names a PROFILE; pairing needs the HARNESS behind it,
    // because every question below — does it pair, which binary gets the
    // terminal, whose sessions are on disk — is about the binary.
    const taskAgentId = task.agent_id || DEFAULT_AGENT_PROFILE_NAME;
    const taskHarness = profileForAgentName(
      pairConfigEarly, taskAgentId, `task ${displayId(task)}`,
    ).harness;
    // What to CALL the task's agent when talking to the human. The profile is
    // what they chose, so it leads; the harness only appears when a custom
    // profile makes the two differ, where naming just one would leave the
    // message unactionable ("runs 'local-ollama-pi'" does not say pi).
    const taskAgentDesc = taskHarness === taskAgentId ? taskAgentId : `${taskAgentId} (${taskHarness})`;
    const taskAgent = getAgent(taskHarness);
    if (!taskAgent.supportsPairing()) {
      console.error(`Cannot pair on a ${taskAgentDesc} task — that agent does not support pairing.`);
      console.error('');
      console.error('What works instead:');
      console.error(`  lazy show ${displayId(task)}              # the task's turns, safe to read`);
      console.error(`  lazy unblock ${displayId(task)} -m "..."  # steer the agent with feedback`);
      console.error(`  lazy chat ${displayId(task)}              # read-only conversation about the work`);
      process.exit(1);
    }

    // Where the session runs: the task's container, unless the human passed
    // --host for an explicit claude-code-only opt-in to host execution.
    // Same resolution order the daemon's ensureTaskContainer uses, so pairing
    // never disagrees with the container it is about to join about which runner
    // this task is on.
    const taskRunnerType = sess.runner_type ?? task.runner_type ?? pairConfigEarly.runner.type;
    if (isHostRunnerType(taskRunnerType)) {
      console.error(hostRunnerRemovedMessage('task runner'));
      console.error('');
      console.error('Give the task a container runner, then pair in it:');
      console.error(`  lazy edit ${displayId(task)} --runner docker`);
      console.error(`  lazy pair ${displayId(task)}`);
      process.exit(1);
    }
    const taskRunner = createRunnerFromType(taskRunnerType);
    const useHost = hostRequested;

    // Host pairing is a claude-code capability, and only ever was: the host
    // launcher builds its argv with interactiveClaudeArgs, which is hardcoded to
    // `claude` (src/supervisor/interactive.ts). It has no agent parameter to
    // pass a task's agent through. So --host on a cursor task would print
    // "Agent: cursor", then launch Claude Code against that task's worktree —
    // the wrong agent, silently, which is exactly the class of thing pairing is
    // not allowed to do.
    //
    // Refuse before host pairing proceeds, so a non-claude-code task is never
    // silently launched as Claude Code on the host.
    if (useHost && taskHarness !== 'claude-code') {
      console.error(`Host pairing supports claude-code only — task ${displayId(task)} runs '${taskAgentDesc}'.`);
      console.error('');
      console.error('`lazy pair --host` launches Claude Code on your machine regardless of the');
      console.error("task's agent, so it would open the wrong agent against this task's work.");
      console.error('');
      console.error('What works instead:');
      if (taskRunner.usesSandbox()) {
        console.error(`  lazy pair ${displayId(task)}                 # pair in the task's container, where ${taskHarness} runs`);
      } else {
        console.error(`  lazy start ${displayId(task)} --runner docker  # give the task a container to pair in`);
      }
      console.error(`  lazy chat ${displayId(task)}                 # read-only conversation about the work`);
      process.exit(1);
    }
    if (useHost) {
      console.log('');
      console.log(`⚠ --host: the agent runs on your machine, not in task ${taskShortId}'s container.`);
      console.log('  It has your privileges and your filesystem. Pairing without --host runs the');
      console.log("  session inside the task's container, where its own turns already run.");
      console.log('');
    }
    // Claude Code and pi both write session JSONL lazy can read back, so those
    // two get transcript capture and the AI summary. Stale-session recovery
    // stays Claude-only: pi's --session-id is exact-id create-or-resume, so a
    // stored id that names no file simply starts a fresh session under that id
    // rather than erroring. Cursor's chat format is undocumented and Codex's
    // rollouts have no converter yet; that reduced capture is said out loud
    // below, never silently skipped. Keyed on the HARNESS: what writes those
    // files is the binary, not the profile that selected it — every pi profile
    // (anthropic, ollama, openai, openrouter) writes the same session format.
    const claudeSessions = taskHarness === 'claude-code';
    const piSessions = taskHarness === 'pi';

    // Credential enforcement is not done here — it happens at the launch seam
    // (src/credentials/interactive-auth.ts), which both SOURCES the credential from the
    // daemon and fails loud if it gets none.
    //
    // This comment used to claim the daemon gate alone was sufficient: `lazy
    // pair` auto-starts the daemon (ensureDaemon), which refuses to start
    // without a credential, so "clients pass through, they don't re-enforce."
    // The gate is real, but it proved a different thing than the one that
    // mattered. It proves the DAEMON's environment has a credential; pair then
    // read its OWN shell for one, which is a separate environment that is
    // routinely empty. The gate passed and pair still launched Claude Code with
    // nothing — the `/login` bug. Now that both come from the daemon, "the gate
    // proved it" is finally true of the credential pair actually uses.

    // Session to resume, if the task has one (otherwise the agent starts fresh)
    let claudeSessionId = sess.agent_session_id;
    if (!claudeSessionId) {
      console.log(`No existing ${taskHarness} session to resume — a fresh session will start.`);
    }

    // [usage_pause]: every refusal of pair's own is behind us — admit the session.
    await admitInteractiveOrExit('pair', task.id);

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
    console.log(`  ${theme.label('Agent:')}     ${taskAgentDesc}`);
    console.log(`  ${theme.label('Runs in:')}   ${useHost ? 'your host' : `the task's ${taskRunnerType} container`}`);
    if (claudeSessionId) {
      console.log(`  ${theme.label('Session:')}   ${claudeSessionId.substring(0, 16)}...`);
    }
    console.log(`\nLaunching ${taskHarness}... (exit it to end pairing)\n`);

    let exitCode = 0;
    const pairingStartedAt = new Date().toISOString();

    // Making the stored session reachable by the agent.
    //
    // HOST path only: bridge session files from the sandbox into the host's
    // ~/.claude/projects/ so `claude --resume` finds them without overriding
    // CLAUDE_CONFIG_DIR (which would also lose credentials and preferences).
    //
    // CONTAINER path: nothing to bridge. The agent's HOME inside the container
    // IS the sandbox, so it reads exactly the files the task's own turns wrote —
    // that is the whole point of moving pairing in there. All that is left is to
    // check the ID lazy stored still names a file that exists.
    let bridge: BridgeResult | null = null;
    let sessionAccessible = true;
    let otherSessions: string[] = [];
    if (useHost) {
      bridge = bridgeSessionFiles(worktreePath, claudeSessionId ?? undefined);
      sessionAccessible = bridge.accessible;
      otherSessions = bridge.availableSandboxSessions;
    } else if (claudeSessions && claudeSessionId) {
      const sandboxSessions = listSandboxSessionIds(worktreePath);
      sessionAccessible = sandboxSessions.includes(claudeSessionId);
      otherSessions = sandboxSessions.filter(id => id !== claudeSessionId);
    }
    // Re-point the bridge at a recovered session and report whether the agent
    // can now reach it. Container-side there is nothing to re-point: the file
    // came from the sandbox listing, which is the agent's own home.
    const rebridge = (sessionId: string): boolean => {
      if (!useHost) return true;
      bridge = bridgeSessionFiles(worktreePath, sessionId);
      return bridge.accessible;
    };

    // Stale-session fallback: the stored session ID doesn't correspond to any
    // JSONL in the sandbox, but the sandbox does contain sessions. This happens
    // when Claude Code rotated the session ID (auto-compact, --resume fallback)
    // or when the user switched computers so the DB and sandbox are out of sync.
    if (claudeSessionId && !sessionAccessible && otherSessions.length === 1) {
      const recoveredId = otherSessions[0];
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
      bridge?.cleanup();
      claudeSessionId = recoveredId;
      sessionAccessible = rebridge(recoveredId);
    }

    // Multi-candidate stale recovery: prompt the user to pick by showing
    // recognition cues (age + last human message). We refuse to auto-pick.
    if (claudeSessionId && !sessionAccessible && otherSessions.length > 1) {
      const candidates = otherSessions;
      bridge?.cleanup();
      const recoveredId = await pickFromStaleSessions(worktreePath, claudeSessionId, candidates);
      if (recoveredId) {
        // Durable DB update BEFORE Claude Code launches — a crash must not
        // lose this reconciliation (otherwise the next pair drifts again).
        await storage.updateSessionClaudeId(sess.id, recoveredId);
        claudeSessionId = recoveredId;
        sessionAccessible = rebridge(recoveredId);
      } else {
        // User-initiated abort (empty input, invalid input, or non-TTY).
        // Per "principle of least surprise": don't dump bridge diagnostics on
        // top of the picker output the user just walked away from. Roll back
        // pairing state and exit with a single line.
        removePairingLock(worktreePath);
        try {
          await parkTaskPaused(storage, task.id, getActor());
          await storage.updateTaskMetadata(task.id, 'pairing_pid', '');
          await storage.updateTaskMetadata(task.id, 'pairing_started_at', '');
        } catch {
          // Best effort — the reconciler will clean this up eventually
        }
        console.error('Aborted; no session selected.');
        process.exit(1);
      }
    }

    if (claudeSessionId && !sessionAccessible) {
      if (bridge) {
        // Host path: bridging is the thing that failed, and its diagnostics are
        // the only way to tell WHY, so this stays a hard stop with the trace.
        bridge.cleanup();
        removePairingLock(worktreePath);
        // Roll back the pairing state transition since we never actually paired.
        try {
          await parkTaskPaused(storage, task.id, getActor());
          await storage.updateTaskMetadata(task.id, 'pairing_pid', '');
          await storage.updateTaskMetadata(task.id, 'pairing_started_at', '');
        } catch {
          // Best effort — the reconciler will clean this up eventually
        }
        console.error(`Could not make session ${claudeSessionId.substring(0, 8)}... accessible to the agent.`);
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
      // Container path: nothing failed — the stored ID simply names no file in
      // the sandbox and there is no other session to recover. Resuming it would
      // make the agent exit immediately with "session not found", so start fresh
      // and say so rather than trading a working session for an error.
      console.warn('');
      console.warn(`Warning: session ${claudeSessionId.substring(0, 8)}... is not in the task sandbox,`);
      console.warn('and no other session is either. Starting a fresh session instead.');
      console.warn('');
      claudeSessionId = null;
    }

    if (!useHost) {
      // Host-visible seed so the container bind-mount (or pair's in-container
      // copy) skips Claude Code's first-run wizard before docker exec runs.
      await ensureTaskClaudeConfig(join(worktreePath, SANDBOX_DIR));
    }

    // Snapshot pi session files BEFORE the session so the post-pairing capture
    // can tell which files this pairing touched (pi appends resumed turns to
    // the task's existing session file, so "modified" matters, not just "new").
    const piSnapshotBefore: SessionSnapshot | null = piSessions
      ? await snapshotPiTaskSessionFiles(worktreePath)
      : null;

    try {
      // Claude Code runs UNDER a supervisor, not directly. The supervisor
      // resolves the launch env (role target, credentials, proxy address)
      // through resolveInteractiveLaunch exactly as this call site used to,
      // registers the session so `lazy upgrade` can SEE it, and stops-and-
      // resumes it when the daemon generation changes — an unsupervised session
      // keeps talking to the restarted daemon's dead proxy port forever, because
      // Claude Code reads ANTHROPIC_BASE_URL once at startup. See
      // src/supervisor/interactive.ts.
      //
      // It spawns Claude Code with ASYNC spawn + await (not spawnSync):
      // inherited stdio still gives a normal interactive terminal, but the event
      // loop keeps running for the duration of the session. That matters because
      // `lazy pair` auto-starts the daemon as a CHILD process (via ensureDaemon);
      // spawnSync would freeze the event loop for the whole session, so if that
      // daemon child dies (e.g. another terminal runs `lazy upgrade`), the
      // runtime can never reap it and it becomes a zombie that holds the storage
      // lock. Keeping the loop alive lets the runtime reap exited children.
      //
      // WHERE it spawns the agent is the launcher's decision, not the
      // supervisor's. Without one it launches on the host (branchless mode and
      // --host); the container launcher instead runs
      // `docker exec -it <task container> lazy-agent pair …`, so the session
      // lands in the same place the task's supervised turns run and reads the
      // same agent home directory. See src/cli/commands/pair-container.ts.
      // The task's model, on BOTH surfaces: host pairing resumes the same
      // session as the container path, so it must run what the task's turns run.
      const sessionModel = pairSessionModel({
        task,
        config: pairConfigEarly,
        projectModel: resolveProjectModel(await readProjectSettings(storage), pairConfigEarly),
      });
      const launcher = useHost
        ? undefined
        : createContainerPairLauncher({
            root,
            taskId: task.id,
            worktreePath,
            harness: taskHarness,
            profile: taskAgentId,
            model: sessionModel,
            runnerType: taskRunnerType,
            containerName: taskRunner.runNameForTask(taskShortId),
            binary: taskRunnerType === 'podman' ? 'podman' : 'docker',
            tty: isTTY(),
            claudeSessions,
            extraEnv: { LAZY_TASK: taskShortId },
          });

      ({ exitCode } = await runInteractiveSupervisor({
        kind: 'pair',
        root,
        cwd: worktreePath,
        taskId: taskShortId,
        ...(claudeSessionId ? { resumeSessionId: claudeSessionId } : {}),
        ...(autonomous ? { autonomous } : {}),
        ...(launcher ? { launcher } : { model: sessionModel }),
        extraEnv: { LAZY_TASK: taskShortId },
      }));
    } finally {
      // Always transition back to blocked, clean up symlinks, and release lock.
      // The transition back to 'blocked' MUST happen even if Claude crashes.
      try {
        await parkTaskPaused(storage, task.id, getActor());
        // Clear pairing metadata
        await storage.updateTaskMetadata(task.id, 'pairing_pid', '');
        await storage.updateTaskMetadata(task.id, 'pairing_started_at', '');
      } catch {
        // Best effort — storage may be unavailable
        logger.warn(`Failed to transition task ${taskShortId} back to blocked after pairing`);
      }
      bridge?.cleanup();
      removePairingLock(worktreePath);
    }

    // --- Post-pairing: capture what happened ---

    // Best-effort push of the task branch so commits from the pairing session
    // reach the remote immediately, rather than waiting for the next sync tick.
    // Failures here MUST NOT block commit recording or turn creation below.
    if (sess.git_branch) {
      try {
        const config = await loadConfig(root);
        const offline = await isOfflineMode(join(root, '.lazy'), config.remote.offline);
        // Nobody asked for this push — it stands in for the next sync tick — so
        // it is one of the automatic pushes `<driver>_auto_push = false` covers.
        if (!offline && autoPushEnabled(config)) {
          const driver = createDriver(config);
          await driver.pushBranch(sess.git_branch);
        }
      } catch (err) {
        logger.warn(`Failed to push branch ${sess.git_branch} after pairing (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
    }

    // What the pairing SESSION produced, for the summary and the turn. This
    // window is `headBefore..HEAD` — the narrative question ("what did we just
    // do together") is genuinely about the session, not about the branch.
    // First-parent: a merge made during the session belongs to this task as
    // the merge commit, not as the merged-in branch's history.
    let newCommits: { sha: string; message: string }[] = [];
    try {
      const headAfter = await getCurrentSha(worktreePath);
      if (headAfter !== headBefore) {
        newCommits = await getNewCommits(headBefore, worktreePath, { firstParent: true });
      }
    } catch {
      // Best effort — worktree may be in a weird state
    }

    // RECORDING is a different question, and it is not this command's to
    // answer: pairing is the fourth path that writes commit records, and it
    // goes through the one resolver like the reconciler's three. That fixes
    // the stored ORDER (the resolver writes oldest-first; a raw `git log`
    // hands back newest-first, and records stored in reverse history order
    // were half the mechanism of the over-recording incident), and it anchors
    // at the branch point rather than at this session's head, so a commit an
    // earlier turn failed to record is picked up here too.
    try {
      await recordSessionCommits(storage, sess, worktreePath, taskShortId);
    } catch (err) {
      logger.warn(`Could not record commits after pairing (non-fatal): ${err instanceof Error ? err.message : err}`);
    }

    // Build turn content summarizing the pairing session
    let turnContent = '';
    let summaryGenerated = false;

    // Read the conversation transcript from the agent's session JSONL.
    //
    // Claude Code and pi both write session files lazy can parse (pi's via
    // src/import/pi-session-logs.ts); Cursor stores its chat in an
    // undocumented format and Codex's rollouts have no converter yet — see
    // discoverSessionFiles in src/agent/cursor.ts and src/agent/codex.ts.
    // For those, commits are still recorded and a turn is still written; what
    // is missing is the conversation and the summary built from it. Degrading
    // is fine, doing it silently is not.
    let transcript: string | null = null;
    if (claudeSessions) {
      // A fresh Claude session — no stored id, or a stale one deliberately
      // dropped above — has no transcript to read yet. That is not "capture is
      // unavailable", so it must never reach the note in the final branch.
      if (claudeSessionId) {
        transcript = readSessionTranscript(worktreePath, claudeSessionId, pairingStartedAt);
      }
    } else if (piSessions) {
      // Persist every pi session this pairing touched into lazy's conversation
      // store (searchable via `lazy search`), then read the transcript for the
      // summary. Capture errors are surfaced, never swallowed — the transcript
      // read below is independent, so a store failure still leaves a summary.
      const piCapture = await capturePiTaskConversations(worktreePath, piSnapshotBefore ?? new Map(), storage);
      for (const { sessionId: failedId, error } of piCapture.errors) {
        // Loud, once: a conversation that was not stored is lost history, and
        // the human is the only one who can retrieve it. The session file is
        // still in the task sandbox, and the summary below is built from the
        // parsed conversation, not from the store, so it survives this.
        logger.error(
          `Failed to save this pairing's conversation (session ${failedId.substring(0, 8)}): ${error.message}. `
          + "The session file is still in the task's sandbox; the summary below is unaffected.",
        );
      }
      transcript = piPairingTranscript(piCapture.conversations, pairingStartedAt);
    } else {
      console.log('');
      console.log(`Note: transcript capture is not available for ${taskHarness} — lazy cannot read its`);
      console.log('session files. Commits from this session are recorded; the conversation is not.');
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
        // Marked as a machine one-shot for the same reason as the accept
        // fidelity summary and `lazy report`: this is lazy talking to itself,
        // not a conversation anyone will read back. Its output already lands on
        // the task as a turn, so capturing the session too is pure noise in
        // `lazy builder list`. It goes through runClaude rather than the
        // one-shot path (src/oneshot), so the marker has to be applied here.
        const summaryPrompt = markMachineOneshotPrompt(
          `Summarize this pairing session in 2-3 sentences. Focus on what was discussed, decided, and accomplished.

${contextParts.join('\n\n')}

Keep the summary concise and factual.`);

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
  console.log(`Usage: lazy pair [task_id] [--unlock] [--no-summary] [--resume <session_id>] [--autonomous] [--yes] [--host]

Open an interactive agent session, context-aware.

Three modes:
  1. lazy pair <task>           Pair on a specific task
  2. lazy pair                  On a lazy/* branch: detect the task, pair on it
  3. lazy pair --host           On main or a non-task branch: launch the agent
                                in the current directory (no task context)

In task mode the session runs INSIDE the task's container, where the task's
own turns run: it reads the same agent home directory the agent already
wrote, so resume needs no copying onto your machine, and --autonomous is the
same trust decision as an ordinary supervised turn.

In task mode the TASK'S OWN agent is launched (a Cursor task pairs with
cursor-agent, never Claude Code). Claude Code and pi sessions are fully
captured (transcript, conversation store, AI summary). Cursor and Codex
pair with reduced capture: commits are recorded, but lazy cannot read
their session files, so the transcript and summary are skipped.

In task mode (1 & 2), the task is locked during pairing — other commands
(start, unblock, accept, reject, resume) will refuse to operate until
pairing ends.

In branchless mode (3) there is no task and no container, so the agent runs
on your machine: --host is required. The conversation is captured into
lazy's storage so it's searchable via lazy search.

Arguments:
  [task_id]    ID of the task to pair on (optional — detected from branch)

Options:
  --unlock               Recover a crashed session: stop the in-container agent
                         if one is still running, clear the lock, restore status
  --no-summary           Skip AI summarization of the pairing session
  --resume <session_id>  Resume a previous session (branchless mode only)
  --autonomous           Run the agent without permission prompts. In the task's container
                         this is the same posture as a supervised turn and needs no
                         confirmation; with --host it runs unconfined as you, and is
                         confirmed separately.
  --yes                  Auto-confirm prompts (required with --autonomous --host in
                         non-TTY mode)
  --host                 Run the agent on your machine instead of in the task's container.
                         Required for branchless mode; on a task it is an explicit
                         claude-code-only opt-in. Never a silent fallback.

Examples:
  lazy pair abc123                   # Pair in that task's container
  lazy pair abc123 --unlock          # Clear a stale pairing lock
  lazy pair                          # Detect task from branch and pair in its container
  lazy pair --no-summary             # Pair without AI summary
  lazy pair --host --resume abc123   # Resume a previous branchless session, on the host
  lazy pair abc123 --autonomous      # Run without permission prompts, in the container`);
}
