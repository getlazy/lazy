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

export class CursorAgent implements Agent {
  readonly id = 'cursor';

  getAuthEnv(): { key: string; value: string } {
    const apiKey = process.env.CURSOR_API_KEY;
    if (apiKey) {
      return { key: 'CURSOR_API_KEY', value: apiKey };
    }
    // Cursor CLI can authenticate via `agent login` session on the host.
    // Return a no-op env var and let the CLI handle its own auth.
    return { key: 'CURSOR_API_KEY', value: '' };
  }

  hasAuthEnv(): boolean {
    // Cursor CLI can use either CURSOR_API_KEY or its own login session.
    // Always return true — let the CLI fail with its own auth error if needed.
    return true;
  }

  resolveModelId(modelName: string): string {
    // Universal monikers return '' (empty) — omit --model and let Cursor use
    // its default (`auto`). This works on free plans which can only use `auto`.
    // Only pass --model when the user explicitly picks a Cursor-specific model.
    const monikers = new Set(['apprentice', 'journeyman', 'master']);
    if (monikers.has(modelName)) {
      return '';
    }

    const cursorModels: Record<string, string> = {
      'sonnet-4': 'sonnet-4',
      'sonnet-4-thinking': 'sonnet-4-thinking',
      'gpt-5': 'gpt-5',
    };
    const id = cursorModels[modelName];
    if (!id) {
      const validNames = [...monikers, ...Object.keys(cursorModels)].join(', ');
      throw new Error(`Unknown model: ${modelName}. Valid options: ${validNames}`);
    }
    return id;
  }

  availableModels(): { name: string; modelId: string; isDefault: boolean }[] {
    return [
      // Universal monikers — use Cursor's default model (no --model flag)
      { name: 'journeyman', modelId: '', isDefault: true },
      { name: 'master', modelId: '', isDefault: false },
      { name: 'apprentice', modelId: '', isDefault: false },
      // Cursor-specific names — pass --model explicitly
      { name: 'sonnet-4', modelId: 'sonnet-4', isDefault: false },
      { name: 'sonnet-4-thinking', modelId: 'sonnet-4-thinking', isDefault: false },
      { name: 'gpt-5', modelId: 'gpt-5', isDefault: false },
    ];
  }

  buildExecArgs(opts: {
    prompt: string;
    systemPrompt?: string;
    modelId?: string;
    sessionId?: string;
    dangerouslySkipPermissions: boolean;
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

    // Prompt must be the last positional argument
    args.push(prompt);

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

  defaultWatchdogTimeoutMs(): number {
    // Cursor CLI has a known hanging bug in --print mode.
    // Default to 5 minutes of no output before killing the process.
    return 5 * 60 * 1000;
  }

  discoverSessionFiles(_opts: {
    sessionId?: string;
    configDir?: string;
  }): string[] {
    // Cursor session files are undocumented — return empty array for now.
    return [];
  }
}
