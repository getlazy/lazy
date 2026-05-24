/**
 * ClaudeCodeAgent — Agent implementation for Claude Code CLI.
 *
 * Extracted from src/capture/claude.ts. All Claude-specific execution logic
 * (auth, models, CLI args, response parsing, error matching) lives here.
 */

import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { getHome } from '../utils/home';
import type { AgentResponse } from '../types';
import type { Agent } from './interface';

/**
 * Tools disallowed for the agent in ask/plan mode (read-only Q&A turns).
 *
 * Why hard-coded: these are Claude Code's built-in write-capable tool names —
 * they don't drift per-project. Read-only built-ins (Read, Grep, LS) stay
 * available so the agent can look up code while answering.
 *
 * Why not `--permission-mode plan`: plan mode triggers Claude Code's interactive
 * `ExitPlanMode` prompt when the model attempts a write tool. `claude -p` is
 * non-interactive, so the prompt has no human to answer and the agent stalls.
 * Using `--disallowedTools` blocks writes outright with no interactive step.
 */
const DISALLOWED_TOOLS_IN_PLAN_MODE = 'Bash Write Edit';

export class ClaudeCodeAgent implements Agent {
  readonly id = 'claude-code';

  getAuthEnvVars(): Array<{ key: string; value: string }> {
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauthToken) {
      return [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: oauthToken }];
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      return [{ key: 'ANTHROPIC_API_KEY', value: apiKey }];
    }
    throw new Error(
      'Authentication required. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) or ANTHROPIC_API_KEY.'
    );
  }

  hasAuthEnv(): boolean {
    return !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
  }

  buildExecArgs(opts: {
    prompt: string;
    systemPrompt?: string;
    modelId?: string;
    sessionId?: string;
    dangerouslySkipPermissions: boolean;
    effort?: string;
    permissionMode?: 'plan' | 'default';
  }): string[] {
    const args = ['claude', '-p', opts.prompt, '--output-format', 'json'];

    // For plan/ask mode, block write tools via --disallowedTools instead of
    // --permission-mode plan. Plan mode triggers an interactive ExitPlanMode
    // prompt that `claude -p` cannot answer, causing stalls.
    if (opts.permissionMode === 'plan') {
      args.push('--disallowedTools', DISALLOWED_TOOLS_IN_PLAN_MODE);
      if (opts.dangerouslySkipPermissions) {
        args.push('--dangerously-skip-permissions');
      }
    } else if (opts.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }

    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }

    if (opts.modelId) {
      args.push('--model', opts.modelId);
    }

    if (opts.effort) {
      args.push('--effort', opts.effort);
    }

    return args;
  }

  parseResponse(stdout: string, _opts?: { workingDir?: string }): AgentResponse {
    let parsed: AgentResponse;
    try {
      parsed = JSON.parse(stdout) as AgentResponse;
    } catch (err) {
      throw new Error(`Failed to parse Claude Code JSON output: ${err instanceof Error ? err.message : err}`);
    }

    if (!parsed.result || !parsed.session_id) {
      throw new Error('Claude Code response missing required fields (result, session_id)');
    }

    return parsed;
  }

  isPromptTooLongError(errorMessage: string): boolean {
    return errorMessage.includes('Prompt is too long');
  }

  isSessionNotFoundError(errorMessage: string): boolean {
    return errorMessage.includes('No conversation found with session ID');
  }

  defaultWatchdogTimeoutMs(): number {
    return 0; // Claude Code doesn't hang — watchdog disabled by default
  }

  discoverSessionFiles(opts: {
    sessionId?: string;
    configDir?: string;
  }): string[] {
    // Claude Code stores session files in ~/.claude/projects/<project-hash>/<session-id>.jsonl
    const configDir = opts.configDir ?? join(getHome(), '.claude');
    const projectsDir = join(configDir, 'projects');

    if (!existsSync(projectsDir)) {
      return [];
    }

    const results: string[] = [];

    try {
      const projectDirs = readdirSync(projectsDir, { withFileTypes: true });
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue;
        const projectPath = join(projectsDir, projectDir.name);
        try {
          const files = readdirSync(projectPath);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            if (opts.sessionId) {
              // Filter to files matching the session ID
              if (file === `${opts.sessionId}.jsonl`) {
                results.push(join(projectPath, file));
              }
            } else {
              results.push(join(projectPath, file));
            }
          }
        } catch {
          // Skip inaccessible project directories
        }
      }
    } catch {
      // Projects directory not readable
    }

    return results;
  }
}
