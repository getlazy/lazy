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
} from '../helpers';
import { theme } from '../theme';
import { encodeProjectPath } from '../../import/claude-code-logs';
import { loadConfig } from '../../config/loader';
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/types';
import { logger } from '../../utils/logger';
import { spawnSync } from '../../utils/spawn';
import chatSystemPrompt from '../../prompts/chat-system-prompt.md' with { type: 'text' };

/**
 * Tools blocked during a read-only chat. These are Claude Code's built-in
 * write/exec tools; blocking them outright (rather than relying on plan mode,
 * which the human could exit) is the safety invariant — a chat must not be
 * able to mutate the repo or any lazy state. Read-only built-ins (Read, Grep,
 * LS) stay available so the agent can look up code while answering.
 */
const DISALLOWED_TOOLS = 'Bash Write Edit';

/**
 * Default reasoning effort for a chat. A retrospective Q&A is lightweight, so
 * we deliberately ignore the (often high/xhigh) task/builder defaults and start
 * at medium — plenty for "what did you do and why", and much faster/cheaper.
 * Override per-invocation with --effort.
 */
const DEFAULT_CHAT_EFFORT: EffortLevel = 'medium';

/**
 * `lazy chat <task>` — resume a finished task's Claude Code session for an
 * interactive, read-only conversation.
 *
 * Flow:
 *   1. Rehydrate: pull the raw session JSONL captured on close (see
 *      capture-agent-session) out of lazy storage and drop it where Claude
 *      Code looks for resumable sessions — ~/.claude/projects/<encoded-cwd>/.
 *   2. Chat: launch `claude --resume <sessionId>` interactively, locked to
 *      read-only (plan mode + disallowed write tools).
 *   3. Write back: the resumed session appends new turns to the JSONL; persist
 *      the updated file back into lazy storage so the chat continues next time.
 *
 * The task's worktree is gone (it's terminal), so we resume in the lazy project
 * root rather than the original worktree path. Resume keys off the session id,
 * not the cwd, so this is sufficient for a read-only retrospective chat.
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
    console.log(`  ${theme.label('Mode:')}     read-only (no edits, no commands, no state changes)`);
    console.log(`  ${theme.label('Effort:')}   ${effort}`);
    console.log(`\nLaunching Claude Code... (exit Claude Code to end the chat)\n`);

    // --- Chat: launch Claude Code interactively, locked read-only ---
    const claudeArgs = [
      'claude',
      '--resume', sessionId,
      // Plan mode starts the session read-only; disallowing the write tools
      // outright is the hard guarantee that no edit/command/state change can
      // happen even if the human exits plan mode.
      '--permission-mode', 'plan',
      '--disallowedTools', DISALLOWED_TOOLS,
      '--append-system-prompt', chatSystemPrompt,
      '--effort', effort,
    ];

    const config = await loadConfig(root);
    if (config.ollama.enabled && config.ollama.model) {
      claudeArgs.push('--model', config.ollama.model);
    }

    let exitCode = 0;
    try {
      const result = spawnSync(claudeArgs, {
        cwd,
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
  } finally {
    await storage.close();
  }
}

export function chatUsage(): void {
  console.log(`Usage: lazy chat <task>

Resume a finished task's agent session for an interactive, read-only chat.

Reopens the Claude Code session of an already-closed task (accepted, rejected,
closed, or abandoned) so you can ask the agent about what it did and why. The
session is locked to read-only — no edits, no commands, no state changes are
possible. New turns from the chat are saved back so the conversation persists.

Arguments:
  <task>    ID or code of the closed task to chat with

Options:
  --effort <level>  Claude Code reasoning effort (low, medium, high, xhigh, max).
                    Defaults to "medium" — a retrospective chat is lightweight.
                    Dial up for a deep dig, or down to low.

Examples:
  lazy chat abc123              # Chat with the agent that worked on task abc123
  lazy chat my-feature          # Chat by task code
  lazy chat abc123 --effort high  # Dial up reasoning for a deep dig`);
}
