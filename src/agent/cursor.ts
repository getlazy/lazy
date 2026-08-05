/**
 * CursorAgent — Agent implementation for Cursor CLI (`agent` binary).
 *
 * Cursor is a host-process-only agent (no Docker/container support).
 * Key differences from Claude Code:
 * - Binary is `agent`, not `cursor`
 * - No --append-system-prompt flag — system prompt is prepended to user prompt
 * - Prompt is a positional argument (at end of command), not a flag value
 * - Known hanging bug in --print mode — uses non-zero default watchdog timeout
 * - Session files are undocumented — discoverSessionFiles returns empty
 * - Auth via CURSOR_API_KEY env var or `agent login` session (host-only)
 */

import type { AgentResponse } from '../types';
import type { Agent } from './interface';
import { safeArgvPrompt } from './argv-safety';
import {
  classifyCommonFailureSignals,
  failureHaystack,
  type AgentFailure,
  type AgentFailureInput,
} from './failure-taxonomy';

export class CursorAgent implements Agent {
  readonly id = 'cursor';

  getAuthEnvVars(): Array<{ key: string; value: string }> {
    const apiKey = process.env.CURSOR_API_KEY;
    if (apiKey) {
      return [{ key: 'CURSOR_API_KEY', value: apiKey }];
    }
    // Cursor CLI can authenticate via `agent login` session on the host.
    // Return a no-op env var and let the CLI handle its own auth.
    return [{ key: 'CURSOR_API_KEY', value: '' }];
  }

  hasAuthEnv(): boolean {
    // Cursor CLI can use either CURSOR_API_KEY or its own login session.
    // Always return true — let the CLI fail with its own auth error if needed.
    return true;
  }

  buildExecArgs(opts: {
    prompt: string;
    systemPrompt?: string;
    modelId?: string;
    sessionId?: string;
    dangerouslySkipPermissions: boolean;
    effort?: string;
    /** Claude-Code-specific; not applicable to Cursor (gated out upstream). */
    extraArgs?: string[];
  }): string[] {
    // Cursor CLI uses 'agent' binary with --print for headless mode.
    // No --append-system-prompt — prepend system prompt to user prompt instead.
    // Prompt is a positional argument at the end of the command.
    let prompt = opts.prompt;
    if (opts.systemPrompt) {
      prompt = `<system>\n${opts.systemPrompt}\n</system>\n\n${prompt}`;
    }

    // Do NOT pass --worktree — lazy manages its own worktrees. Cursor's
    // --worktree would create worktrees at ~/.cursor/worktrees/ which conflicts.
    // --print mode does not auto-create worktrees, so omitting the flag is safe.
    const args = ['agent', '--print', '--output-format', 'json', '--trust'];

    if (opts.dangerouslySkipPermissions) {
      args.push('--force');
    }

    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }

    if (opts.modelId) {
      args.push('--model', opts.modelId);
    }

    // Prompt must be the last positional argument. A raw NUL anywhere in argv
    // is fatal to the spawn, so escape rather than let the turn crash-loop.
    args.push(safeArgvPrompt(prompt, 'prompt'));

    return args;
  }

  parseResponse(stdout: string, _opts?: { workingDir?: string }): AgentResponse {
    // Cursor emits same JSON structure as Claude Code in --output-format json mode:
    // { type: "result", subtype: "success", result: "...", session_id: "..." }
    let parsed: AgentResponse;
    try {
      parsed = JSON.parse(stdout) as AgentResponse;
    } catch (err) {
      throw new Error(`Failed to parse Cursor JSON output: ${err instanceof Error ? err.message : err}`);
    }

    if (!parsed.result || !parsed.session_id) {
      throw new Error('Cursor response missing required fields (result, session_id)');
    }

    return parsed;
  }

  isPromptTooLongError(errorMessage: string): boolean {
    return (
      errorMessage.includes('Prompt is too long') ||
      errorMessage.includes('prompt too long') ||
      errorMessage.includes('context length exceeded')
    );
  }

  isSessionNotFoundError(errorMessage: string): boolean {
    return (
      errorMessage.includes('No conversation found with session ID') ||
      errorMessage.includes('session not found') ||
      errorMessage.includes('invalid session')
    );
  }

  /**
   * Cursor-specific failure classification.
   *
   * Cursor authenticates via CURSOR_API_KEY or an `agent login` session, so a
   * missing/expired login is its distinctive fatal case. Everything else falls
   * through to the shared HTTP/network signals.
   */
  classifyFailure(input: AgentFailureInput): AgentFailure {
    const text = failureHaystack(input);

    if (
      text.includes('not logged in') ||
      text.includes('please run `agent login`') ||
      text.includes('please run agent login') ||
      text.includes('invalid cursor_api_key') ||
      text.includes('no api key')
    ) {
      return { class: 'fatal_auth', reason: 'Cursor CLI is not authenticated' };
    }

    if (text.includes('unknown option') || text.includes('unknown model')) {
      return { class: 'fatal_config', reason: 'Cursor rejected the invocation (model or flag)' };
    }

    return (
      classifyCommonFailureSignals(input) ?? {
        class: 'unknown',
        reason: 'unrecognized Cursor failure',
      }
    );
  }

  defaultWatchdogTimeoutMs(): number {
    // Cursor CLI has a known hanging bug in --print mode.
    // Default to 5 minutes of no output before killing the process.
    return 5 * 60 * 1000;
  }

  activityStream(): null {
    // No incremental event stream: `agent --print --output-format json` emits a
    // single blob at exit. The watchdog therefore keeps its byte-level
    // behavior for Cursor — any output is liveness, and the 5-minute default
    // above is what catches the --print hang. Do not "upgrade" this without a
    // format that actually streams; returning a stream the agent doesn't
    // produce would make every Cursor turn look silent.
    return null;
  }

  discoverSessionFiles(_opts: {
    sessionId?: string;
    configDir?: string;
  }): string[] {
    // Cursor session files are undocumented — return empty array for now.
    return [];
  }
}
