/**
 * In-container half of `lazy pair <task>` — `lazy-agent pair`.
 *
 * The host runs `docker exec -it <task container> lazy-agent pair …` and this is
 * what that exec runs. It is the pairing counterpart of `lazy-agent builder`:
 * wire this session's MCP tools, then hand the terminal to the agent's own
 * interactive CLI and get out of the way.
 *
 * WHY THE AGENT IS NOT EXEC'D DIRECTLY
 * ------------------------------------
 * `docker exec -it <c> claude` would give the human a session with NO lazy_*
 * tools. `~/.claude.json` (and `~/.cursor/mcp.json`) live on the container's own
 * ephemeral filesystem, beside the mounted home rather than in it, so a freshly
 * launched container has no MCP entry at all — the same failure that once cost
 * `lazy ask` its tools. `prepareTurnMcp` is the enforced place that gets written,
 * and it fails LOUDLY: a paired session with no lazy tools is broken, not
 * degraded, exactly as a supervised turn would be.
 *
 * WHY A PIDFILE
 * -------------
 * Docker does not forward signals to an exec'd process, so when the interactive
 * supervisor on the host stops the session (daemon restart, `lazy upgrade`), it
 * kills only its local `docker exec` client — this process would survive and
 * keep holding the session the relaunch is about to `--resume`. So the pid is
 * published where the host can read it (the sandbox dir is the same directory on
 * both sides of the mount) and the host reaches in with `kill`. SIGTERM here is
 * forwarded to the agent and never escalated to SIGKILL: the session's unsaved
 * state is the thing being protected.
 */

import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { prepareTurnMcp } from './mcp-setup';
import { createRunnerFromType } from '../runner';
import { getAgent } from '../agent/registry';
import { SANDBOX_DIR } from '../utils/sandbox';
import { spawn } from '../utils/spawn';
import { logger } from '../utils/logger';
import {
  activateTaskClaudeConfig,
  persistTaskSessionClaudeConfig,
} from '../task/claude-home';
import type { RunnerType } from '../config/types';
import chatLiveSystemPrompt from '../prompts/chat-live-system-prompt.md' with { type: 'text' };

/**
 * Where this process publishes its pid for the host's reach-in stop.
 *
 * Inside the sandbox dir because that is the one directory visible at the SAME
 * path on both sides of the mount, and because `.lazy-task-sandbox/` is already
 * gitignored and pathspec-excluded from every dirtiness check — a paired session
 * cannot dirty the task's diff by existing.
 */
export function pairPidFilePath(worktreePath: string): string {
  return join(worktreePath, SANDBOX_DIR, 'pair-session.pid');
}

/**
 * The argv that runs INSIDE the container — the launch contract with the
 * `lazy-agent pair` this file implements, kept next to the flags it produces.
 *
 * Two launchers build it: the CLI's `docker exec` (buildPairExecArgs in
 * src/cli/commands/pair-container.ts) and the daemon's web-shell ExecStream
 * (src/server/shell-pair.ts). One builder, so Pair/Chat over WebSocket cannot
 * drift from `lazy pair`.
 */
export function pairInContainerCmd(opts: {
  taskId: string;
  worktreePath: string;
  harness: string;
  runnerType: string;
  sessionId?: string | null;
  modelId?: string | null;
  autonomous?: boolean;
  chat?: boolean;
  memberSession?: boolean;
}): string[] {
  const cmd = [
    'lazy-agent', 'pair',
    '--task-id', opts.taskId,
    '--worktree', opts.worktreePath,
    '--agent', opts.harness,
    '--runner', opts.runnerType,
  ];
  if (opts.sessionId) cmd.push('--resume', opts.sessionId);
  if (opts.modelId) cmd.push('--model', opts.modelId);
  if (opts.autonomous) cmd.push('--autonomous');
  if (opts.chat) cmd.push('--chat');
  if (opts.memberSession) cmd.push('--member-session');
  return cmd;
}

export interface InContainerPairOptions {
  /** Full task UUID — scopes the MCP tools and the turn identity. */
  taskId: string;
  /** Worktree path (identical inside and outside the container). */
  worktreePath: string;
  /**
   * Which agent BINARY to hand the terminal to — a harness, not a profile
   * name. The host resolves the task's profile before spawning this.
   */
  harness: string;
  /** Runner type, so the MCP config names the right server command. */
  runnerType: RunnerType;
  /** Session to resume, if the task has one. */
  sessionId?: string | null;
  /**
   * Model to pin — the TASK's persisted model, the one its turns run on. Absent
   * means the agent's default; pi refuses that (see requirePiModel).
   */
  modelId?: string | null;
  /** Run without permission prompts (same trust decision as a supervised turn). */
  autonomous?: boolean;
  /**
   * Reflective chat: read-only MCP, no pairing takeover. Does not change the
   * task's persisted agent/model/effort. Claude Code gets the same lockdown
   * `lazy chat` uses (`--permission-mode plan` + disallowed write tools).
   */
  chat?: boolean;
  /**
   * A member's session in their own terminal container on a shared daemon
   * (src/daemon/member-container.ts). Its home config is one lazy built for
   * that container — no hooks, no MCP servers — so this:
   *   - registers NO lazy_* tools (the container holds no daemon MCP config);
   *   - neither copies the task sandbox's `.claude.json` into $HOME nor
   *     writes $HOME back to it — the sandbox is turn-writable, and nothing a
   *     turn wrote may reach a process holding the member's credential;
   *   - starts Claude Code with {@link MEMBER_SESSION_CLAUDE_ARGS}, so the
   *     worktree's own `.claude/settings.json` / `settings.local.json`
   *     (hooks included) and any MCP server lazy did not write are ignored.
   */
  memberSession?: boolean;
}

/**
 * Claude Code options a member session starts with, from `claude --help`
 * (Claude Code 2.1.280):
 *   --setting-sources <sources>  "Comma-separated list of setting sources to
 *                                load (user, project, local)" — `user` only:
 *                                the lazy-built home's settings, never the
 *                                worktree's `.claude/settings.json` or
 *                                `settings.local.json`, where a turn could
 *                                plant a hook.
 *   --strict-mcp-config          "Only use MCP servers from --mcp-config,
 *                                ignoring all other MCP configurations" — with
 *                                no --mcp-config, no MCP server at all (not the
 *                                home's, not a worktree `.mcp.json`).
 */
export const MEMBER_SESSION_CLAUDE_ARGS = ['--setting-sources', 'user', '--strict-mcp-config'] as const;

/**
 * Prepare MCP and run the interactive agent. Resolves with the agent's exit
 * code; the caller (`lazy-agent pair`) exits with it.
 */
export async function runInContainerPair(opts: InContainerPairOptions): Promise<number> {
  const agent = getAgent(opts.harness);
  const argv = agent.buildInteractiveArgs({
    sessionId: opts.sessionId ?? null,
    modelId: opts.modelId ?? null,
    dangerouslySkipPermissions: opts.chat ? false : opts.autonomous === true,
  });
  if (!argv) {
    // Unreachable through `lazy pair`, which refuses on supportsPairing() long
    // before a container is touched. Named rather than crashed on, because the
    // only way here is a new agent that gated true without implementing this.
    throw new Error(
      `Agent '${opts.harness}' has no interactive mode (buildInteractiveArgs returned null), ` +
      `so there is nothing to pair with. This is an agent-implementation bug: an agent whose ` +
      `supportsPairing() returns true must implement buildInteractiveArgs().`,
    );
  }
  if (opts.chat && opts.harness === 'claude-code') {
    // Same lockdown as `lazy chat`: reflective permission mode plus a hard
    // write-tool denylist. Headless asks omit --permission-mode plan (it
    // stalls on ExitPlanMode); an interactive chat wants it.
    argv.push(
      '--permission-mode', 'plan',
      '--disallowedTools', 'Bash Write Edit',
      '--append-system-prompt', chatLiveSystemPrompt,
    );
  }

  if (opts.memberSession) {
    if (opts.harness !== 'claude-code') {
      // The host refuses this before any container is touched
      // (src/server/shell-pair.ts); restated so the flags below can never be
      // silently dropped for an agent that does not understand them.
      throw new Error(`A member session runs Claude Code only, not '${opts.harness}'.`);
    }
    argv.push(...MEMBER_SESSION_CLAUDE_ARGS);
  } else {
    // Seed onboarding/theme state and align $HOME/.claude.json with the sandbox
    // copy. Containers launched after the mount lands read the bind-mounted file;
    // older containers still running get a one-shot copy onto the ephemeral path.
    await activateTaskClaudeConfig(opts.worktreePath);

    // Throws McpToolsUnavailableError when the tools cannot be registered. Let it
    // out: the human is at the terminal and sees the message, which is strictly
    // better than a session that silently has no lazy_* tools.
    await prepareTurnMcp(
      createRunnerFromType(opts.runnerType),
      opts.taskId,
      opts.worktreePath,
      // The model the session was launched with: pi's models.json declares that
      // one model and nothing else, so it must be the same value as `--model`.
      { harness: opts.harness, readOnly: opts.chat === true, model: opts.modelId ?? undefined },
    );
  }

  const pidFile = pairPidFilePath(opts.worktreePath);
  await writeFile(pidFile, `${process.pid}\n`);

  let child: ReturnType<typeof spawn> | null = null;
  // Forward and do not escalate — see the header. Ctrl-C is NOT handled here:
  // it reaches the agent from the tty on its own, and this process must not die
  // of it (that would drop the terminal back to the host mid-session).
  const onSigterm = () => { try { child?.kill('SIGTERM'); } catch { /* already gone */ } };
  const onSigint = () => { /* delivered to the agent by the tty */ };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  try {
    child = spawn(argv, {
      cwd: opts.worktreePath,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      // Interactive: the session ends when the human ends it.
      timeout: 0,
    });
    return await child.exited;
  } finally {
    if (!opts.memberSession) {
      await persistTaskSessionClaudeConfig(opts.worktreePath, (message) => logger.warn(message));
    }
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    try {
      await unlink(pidFile);
    } catch {
      // Already gone (the container died, or the host removed it). A stale
      // pidfile is harmless — the host's stop reads it, signals a pid that no
      // longer exists, and moves on — so this is not worth failing an exit over.
    }
  }
}

