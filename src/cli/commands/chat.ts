import { join } from 'path';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { getHome } from '../../utils/home';
import { pathExists } from '../../utils/fs';
import {
  requireLazyRoot,
  requireStorage,
  shortId,
  displayId,
  parseFlags,
  resolveTaskOrExit,
  getWorktreePath,
  rejectIfPairing,
  taskRef,
} from '../helpers';
import { theme } from '../theme';
import { encodeProjectPath } from '../../import/claude-code-logs';
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/types';
import { logger } from '../../utils/logger';
import { runInteractiveSupervisor } from '../../supervisor/interactive';
import { checkLock, acquireLock, removeLock } from '../../utils/lock';
import { bridgeSessionFiles } from './pair-bridge';
import { captureAgentSessionLog } from '../../import/capture-agent-session-log';
import type { Storage } from '../../storage';
import { isTerminalStatus, type Task, type Session } from '../../types';
import chatSystemPrompt from '../../prompts/chat-system-prompt.md' with { type: 'text' };
import chatLiveSystemPrompt from '../../prompts/chat-live-system-prompt.md' with { type: 'text' };

/**
 * Tools blocked during a read-only chat. These are Claude Code's built-in
 * write/exec tools; blocking them outright (rather than relying on the
 * reflective permission mode, which the human could exit) is the safety
 * invariant — a chat must not be able to mutate the repo or any lazy state.
 * Read-only built-ins (Read, Grep, LS) stay available so the agent can look up
 * code while answering.
 */
const DISALLOWED_TOOLS = 'Bash Write Edit';

/**
 * Default reasoning effort for a chat. A reflective Q&A is lightweight, so we
 * deliberately ignore the (often high/xhigh) task/builder defaults and start at
 * medium — plenty for "what did you do and why", and much faster/cheaper.
 * Override per-invocation with --effort.
 */
const DEFAULT_CHAT_EFFORT: EffortLevel = 'medium';

/**
 * `lazy chat <task>` — resume a task's Claude Code session for an interactive,
 * read-only ("reflective") conversation with the agent that did the work.
 *
 * Two modes, chosen from the task's own state — the human types one command
 * either way:
 *
 *  - **Live** (task `blocked`/`conflict`, session still open): resume the
 *    agent's live session in its worktree. The task is untouched by the chat:
 *    same status before and after, no commits, no worktree writes. See
 *    {@link chatLive}.
 *  - **Terminal** (session ended): rehydrate the raw session JSONL captured on
 *    close and resume it in the project root, since the worktree is gone. See
 *    {@link chatTerminal}.
 *
 * Both modes launch Claude Code locked read-only: the reflective permission
 * mode (`--permission-mode plan` under the hood) plus a hard `--disallowedTools`
 * list, so exiting the mode still cannot buy write access.
 */
export async function commandChat(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'effort', takesValue: true },
  ], 'chat');
  const taskId = parsed.positional[0];

  if (!taskId) {
    chatUsage();
    process.exit(1);
  }

  // --effort overrides the medium default. Validate before doing any work so
  // the human gets a fast, clear error rather than a claude launch failure.
  let effort: EffortLevel = DEFAULT_CHAT_EFFORT;
  const effortValue = parsed.flags.get('effort') as string | undefined;
  if (effortValue !== undefined) {
    if (!VALID_EFFORT_LEVELS.includes(effortValue as EffortLevel)) {
      console.error(`Invalid effort '${effortValue}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
      process.exit(1);
    }
    effort = effortValue as EffortLevel;
  }

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    const task = await resolveTaskOrExit(storage, taskId);

    // Mode selection is derived from task state, never guessed: a task that is
    // not finished and still has an open session has a live agent and a live
    // worktree, so we resume it in place. Everything else — finished tasks
    // included, whose session row may still look open after `lazy close` — is a
    // retrospective chat against the archived JSONL.
    const sess = await storage.getSessionByTaskId(task.id);
    if (sess && !sess.ended_at && !isTerminalStatus(task.status)) {
      await chatLive(root, storage, task, sess, effort);
    } else {
      await chatTerminal(root, storage, task, effort);
    }
  } finally {
    await storage.close();
  }
}

/**
 * Live chat: resume the paused agent's session in its own worktree.
 *
 * INVARIANT: a chat leaves the task exactly as it found it. Unlike `lazy pair`
 * — which flips the task to `pairing`, takes the pairing lock, and records
 * commits and a turn — chat changes no status and writes no turn. The only
 * durable effect is the session JSONL (now longer by the chat's turns) being
 * captured into storage, the same write-back the terminal mode does.
 *
 * It does, however, take the worktree lock (`.lazy-lock`) for its duration.
 * That lock is the one every turn-launching path already honours (start,
 * unblock, sync, resume, accept, auto-deliver, auto-resume), so a daemon-driven
 * turn cannot begin underneath an open chat and start rewriting the worktree
 * and the very session file we are talking into. The lock is released — and the
 * session captured — even if Claude Code exits non-zero.
 */
async function chatLive(
  root: string,
  storage: Storage,
  task: Task,
  sess: Session,
  effort: EffortLevel,
): Promise<void> {
  const taskShortId = shortId(task.id);

  // Chat is built on Claude Code's session machinery (host-side ~/.claude
  // session rehydration + `claude --resume`). Other agents have no equivalent
  // documented session surface yet — refuse honestly rather than resuming the
  // wrong agent's session with Claude.
  if (task.agent_id && task.agent_id !== 'claude-code') {
    console.error(`Task ${displayId(task)} runs on the "${task.agent_id}" agent — \`lazy chat\` only supports Claude Code tasks.`);
    console.error(`Use \`lazy ask ${displayId(task)} "<question>"\` (agent-aware) or \`lazy pair ${displayId(task)}\` instead.`);
    process.exit(1);
  }

  if (!sess.agent_session_id) {
    console.error(`Task ${displayId(task)} has no agent session to resume — the agent has not run a turn yet.`);
    console.error(`Start it with: lazy start ${displayId(task)}`);
    process.exit(1);
  }
  const sessionId = sess.agent_session_id;

  // Only a paused task can be chatted with. A `working` task is mid-turn: its
  // agent owns the session and the worktree, and a second `claude --resume` on
  // the same session would fight it. `conflict` is a blocked variant and is
  // just as chattable — the reviewer should not have to unblock to ask.
  if (task.status !== 'blocked' && task.status !== 'conflict') {
    if (task.status === 'working') {
      console.error(`Task ${displayId(task)} is currently working — its agent is mid-turn.`);
      console.error(`Wait for it to pause, then retry. Watch it with: lazy watch ${displayId(task)}`);
    } else if (task.status === 'pairing') {
      console.error(`Task ${displayId(task)} is in a pairing session. Exit the pairing session first.`);
    } else {
      console.error(`Task ${displayId(task)} is '${task.status}', not 'blocked' or 'conflict'.`);
      console.error('A chat only runs against a paused task — wait until the agent is paused for review.');
    }
    process.exit(1);
  }

  const worktreePath = getWorktreePath(root, task);
  if (!await pathExists(worktreePath)) {
    console.error(`Worktree missing for task ${displayId(task)} at ${worktreePath}.`);
    console.error(`Run 'lazy sync ${displayId(task)}' to recover it.`);
    process.exit(1);
  }

  // Pairing holds the worktree with write semantics; a read-only chat on top of
  // it would be talking into a session someone else is actively driving.
  rejectIfPairing(root, taskRef(task), displayId(task));

  const existingLock = await checkLock(worktreePath);
  if (existingLock) {
    console.error(`Task ${displayId(task)} is locked by another process (PID ${existingLock.pid}, ${existingLock.command}).`);
    console.error('A chat needs the task idle. Retry once that operation finishes.');
    process.exit(1);
  }
  await acquireLock(worktreePath, 'lazy chat');

  let exitCode = 0;
  // Set when we bail before ever launching Claude Code. We cannot process.exit()
  // inside the try below — that skips the finally blocks and would leave the
  // worktree lock behind for the next command to trip over.
  let bridgeFailed = false;
  try {
    // Docker runner: the session JSONL lives in the worktree sandbox, so it has
    // to be visible at ~/.claude/projects/ before `claude --resume` can find it.
    // Host runner: already there, and bridging is a no-op. Symlinks (not
    // copies) mean turns added during the chat land in the real file.
    const bridge = bridgeSessionFiles(worktreePath, sessionId);
    try {
      if (!bridge.accessible) {
        console.error(`Could not make session ${sessionId.substring(0, 8)}... accessible to Claude Code.`);
        console.error('');
        console.error('Bridging diagnostics:');
        for (const line of bridge.diagnostics) {
          console.error(`  ${line}`);
        }
        bridgeFailed = true;
        exitCode = 1;
      } else {
        console.log(`\nResuming agent session for task ${theme.taskId(taskShortId)}: ${task.goal}`);
        console.log(`  ${theme.label('Status:')}   ${task.status} (unchanged by this chat)`);
        console.log(`  ${theme.label('Worktree:')} ${worktreePath}`);
        console.log(`  ${theme.label('Session:')}  ${sessionId.substring(0, 16)}...`);
        console.log(`  ${theme.label('Mode:')}     reflective, read-only (no edits, no commands, no state changes)`);
        console.log(`  ${theme.label('Effort:')}   ${effort}`);
        console.log(`\nThe task is held while you chat — start/unblock/sync will refuse until you exit.`);
        console.log(`\nLaunching Claude Code... (exit Claude Code to end the chat)\n`);

        exitCode = await launchChatClaude({
          root,
          cwd: worktreePath,
          sessionId,
          effort,
          systemPrompt: chatLiveSystemPrompt,
          taskShortId,
        });
      }
    } finally {
      // Capture BEFORE removing the symlinks: the bridge is what makes the
      // (possibly extended) JSONL reachable at all on a container runner.
      // Skipped when we never launched — there is nothing new to capture.
      // captureAgentSessionLog never throws — a missing log must not mask the
      // chat's exit code or leave the worktree lock behind.
      if (!bridgeFailed) {
        await captureAgentSessionLog(storage, task.id, sessionId, worktreePath);
      }
      bridge.cleanup();
    }
  } finally {
    await removeLock(worktreePath);
  }

  if (!bridgeFailed) {
    console.log(`\nChat ended for task ${theme.taskId(taskShortId)}. Task left ${task.status}.`);
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

/**
 * Terminal chat: resume a finished task's archived session.
 *
 * Flow:
 *   1. Rehydrate: pull the raw session JSONL captured on close (see
 *      capture-agent-session-log) out of lazy storage and drop it where Claude
 *      Code looks for resumable sessions — ~/.claude/projects/<encoded-cwd>/.
 *   2. Chat: launch `claude --resume <sessionId>` interactively, locked
 *      read-only.
 *   3. Write back: the resumed session appends new turns to the JSONL; persist
 *      the updated file back into lazy storage so the chat continues next time.
 *
 * The task's worktree is gone (it's terminal), so we resume in the lazy project
 * root rather than the original worktree path. Resume keys off the session id,
 * not the cwd, so this is sufficient for a read-only retrospective chat.
 */
async function chatTerminal(
  root: string,
  storage: Storage,
  task: Task,
  effort: EffortLevel,
): Promise<void> {
  const taskShortId = shortId(task.id);

  // The raw session JSONL is captured into storage when a task is closed
  // (accept/reject/close/abandon). Its presence is the gate for chat: if
  // there's no captured log, there's nothing to resume.
  const log = await storage.getAgentSessionLog(task.id);
  if (!log) {
    console.error(`No captured agent session for task ${displayId(task)}.`);
    console.error('A session is archived when a task is closed (accept/reject/close/abandon),');
    console.error('and only if the agent ran at least one turn. Nothing to chat with here.');
    process.exit(1);
  }

  const sessionId = log.sessionId;

  // --- Rehydrate: place the JSONL where `claude --resume` will find it ---
  // We resume in the project root (the original worktree is gone). Claude
  // Code resolves resumable sessions from ~/.claude/projects/<encoded-cwd>/.
  const cwd = root;
  const projectDir = join(getHome(), '.claude', 'projects', encodeProjectPath(cwd));
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);

  await mkdir(projectDir, { recursive: true });
  await writeFile(jsonlPath, log.content, 'utf-8');
  logger.debug(`Rehydrated session ${sessionId} to ${jsonlPath}`);

  console.log(`\nResuming agent session for task ${theme.taskId(taskShortId)}: ${task.goal}`);
  console.log(`  ${theme.label('Status:')}   ${task.status}`);
  console.log(`  ${theme.label('Session:')}  ${sessionId.substring(0, 16)}...`);
  console.log(`  ${theme.label('Mode:')}     reflective, read-only (no edits, no commands, no state changes)`);
  console.log(`  ${theme.label('Effort:')}   ${effort}`);
  console.log(`\nLaunching Claude Code... (exit Claude Code to end the chat)\n`);

  let exitCode = 0;
  try {
    exitCode = await launchChatClaude({
      root,
      cwd,
      sessionId,
      effort,
      systemPrompt: chatSystemPrompt,
      taskShortId,
    });
  } finally {
    // --- Write back: persist the (possibly extended) JSONL into storage ---
    // Runs even if Claude exits non-zero — the human may still have added
    // turns we don't want to lose. A missing/unreadable file here is an
    // error worth surfacing, but it must not mask the chat's exit code.
    try {
      if (await pathExists(jsonlPath)) {
        const updated = await readFile(jsonlPath, 'utf-8');
        await storage.saveAgentSessionLog(task.id, sessionId, updated);
        logger.debug(`Wrote back session ${sessionId} for task ${taskShortId}`);
      } else {
        logger.warn(`Session JSONL ${jsonlPath} vanished during chat; nothing written back.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to write back agent session log for task ${taskShortId}: ${msg}`);
    }
  }

  console.log(`\nChat ended for task ${theme.taskId(taskShortId)}.`);

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

/**
 * Launch Claude Code interactively for a chat and wait for the human to exit.
 * Shared by both modes so the read-only lockdown and the builder-role target
 * resolution cannot drift between them. Returns Claude Code's exit code.
 */
async function launchChatClaude(opts: {
  root: string;
  cwd: string;
  sessionId: string;
  effort: EffortLevel;
  systemPrompt: string;
  taskShortId: string;
}): Promise<number> {
  // Claude Code runs UNDER the interactive supervisor, not directly. A daemon
  // restart moves the audit proxy to a new OS-assigned port and Claude Code
  // reads ANTHROPIC_BASE_URL once at startup, so an unsupervised chat keeps
  // talking to a dead address until every model call fails; it is also invisible
  // to `lazy upgrade`, which discovers children by container name. The
  // supervisor registers the session, resolves the launch env through
  // resolveInteractiveLaunch exactly as this call site used to, and stops-and-
  // resumes the chat across a restart. Same seam and same supervisor as
  // `lazy pair`. See src/supervisor/interactive.ts.
  //
  // The read-only lockdown travels as extraArgs so it lands on EVERY launch,
  // including a post-restart relaunch: the reflective permission mode starts the
  // session read-only, and disallowing the write tools outright is the hard
  // guarantee that no edit/command/state change can happen even if the human
  // leaves that mode.
  const { exitCode } = await runInteractiveSupervisor({
    kind: 'chat',
    root: opts.root,
    cwd: opts.cwd,
    taskId: opts.taskShortId,
    resumeSessionId: opts.sessionId,
    extraArgs: [
      '--permission-mode', 'plan',
      '--disallowedTools', DISALLOWED_TOOLS,
      '--append-system-prompt', opts.systemPrompt,
      '--effort', opts.effort,
    ],
    extraEnv: { LAZY_TASK: opts.taskShortId },
  });

  return exitCode;
}

export function chatUsage(): void {
  console.log(`Usage: lazy chat <task>

Interactive, read-only chat with a task's agent — ask it what it did and why.

The chat is "reflective": the agent reflects and answers, it does not act. No
edits, no commands, no commits, no task state changes are possible.

Works on any task whose agent has run at least once:

  Paused task (blocked/conflict)  Resumes the agent's live session in its
                                  worktree. The task is left exactly as it was
                                  — same status, untouched worktree. While the
                                  chat is open the task is held, so start,
                                  unblock and sync refuse until you exit.

  Finished task (accepted,        Rehydrates the session archived on close and
  rejected, closed, abandoned)    resumes it in the project root.

New turns from the chat are saved back so the conversation persists.

To ask a single question instead of holding a conversation, use 'lazy ask'.
To take over and actually change things, use 'lazy pair'.

Arguments:
  <task>    ID or code of the task to chat with

Options:
  --effort <level>  Claude Code reasoning effort (low, medium, high, xhigh, max).
                    Defaults to "medium" — a reflective chat is lightweight.
                    Dial up for a deep dig, or down to low.

Examples:
  lazy chat abc123                # Chat with the agent working on task abc123
  lazy chat my-feature            # Chat by task code
  lazy chat abc123 --effort high  # Dial up reasoning for a deep dig`);
}
