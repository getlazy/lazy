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
import { ClaudeCodeActivityStream } from './activity-stream';
import { safeArgvPrompt } from './argv-safety';
import {
  classifyCommonFailureSignals,
  failureHaystack,
  type AgentFailure,
  type AgentFailureInput,
} from './failure-taxonomy';

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

/** Parse one JSON object, or null if the text isn't a single JSON object. */
function tryParseObject(text: string): Record<string, unknown> | null {
  if (!text || text[0] !== '{') return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Not a single JSON object — the caller falls back to line scanning.
    return null;
  }
}

/** Assert the fields every caller of parseResponse relies on. */
function requireResponseFields(obj: Record<string, unknown>): AgentResponse {
  if (!obj.result || !obj.session_id) {
    throw new Error('Claude Code response missing required fields (result, session_id)');
  }
  return obj as unknown as AgentResponse;
}

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
    extraArgs?: string[];
  }): string[] {
    // argv[2] is the prompt. A raw NUL here is fatal to the spawn, so escape
    // rather than let the turn crash-loop. See ./argv-safety.
    //
    // `stream-json` (not plain `json`) so the supervisor gets an incremental
    // activity signal instead of total silence until exit — see activityStream()
    // below and src/supervisor/watchdog.ts. `--verbose` is required by the CLI
    // for stream-json in `-p` mode; without it Claude Code refuses to start.
    // The final `{"type":"result",…}` line is byte-identical to what
    // `--output-format json` printed, so parseResponse handles both.
    const args = [
      'claude',
      '-p',
      safeArgvPrompt(opts.prompt, 'prompt'),
      '--output-format',
      'stream-json',
      '--verbose',
    ];

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
      args.push('--append-system-prompt', safeArgvPrompt(opts.systemPrompt, 'system prompt'));
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

    // Runner-supplied extras (e.g. host OS-sandbox `--settings <json>`). Appended
    // last so the sandbox layers on top of every other flag.
    if (opts.extraArgs?.length) {
      args.push(...opts.extraArgs);
    }

    return args;
  }

  /**
   * Parse Claude Code output into an AgentResponse.
   *
   * Accepts both shapes deliberately:
   *  - a single JSON object (`--output-format json`, and what the watchdog hands
   *    back when it has already isolated the result line), and
   *  - a newline-delimited stream (`--output-format stream-json`), from which
   *    the LAST `{"type":"result",…}` line is the response.
   *
   * Supporting both is not defensive padding: the watchdog passes the isolated
   * result line on the happy path, but push-back and maintain turns run through
   * `execWithWatchdog` without a parser and hand over raw stream stdout.
   */
  parseResponse(stdout: string, _opts?: { workingDir?: string }): AgentResponse {
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error('Failed to parse Claude Code output: empty stdout');
    }

    // Fast path: the whole thing is one JSON object — either the legacy
    // `--output-format json` blob or a result line the watchdog isolated. If it
    // is some other single stream line (a process killed before it finished),
    // requireResponseFields reports the missing fields, which is the accurate
    // diagnosis.
    const single = tryParseObject(trimmed);
    if (single) {
      return requireResponseFields(single);
    }

    // Stream path: scan backwards for the result line. Backwards because the
    // result is always last and the stream can be megabytes of tool output.
    const lines = trimmed.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const obj = tryParseObject(lines[i]!.trim());
      if (obj && obj.type === 'result') {
        return requireResponseFields(obj);
      }
    }

    throw new Error(
      'Failed to parse Claude Code output: no result found ' +
        `(${lines.length} line(s), ${stdout.length} bytes)`
    );
  }

  isPromptTooLongError(errorMessage: string): boolean {
    return errorMessage.includes('Prompt is too long');
  }

  isSessionNotFoundError(errorMessage: string): boolean {
    return errorMessage.includes('No conversation found with session ID');
  }

  /**
   * Claude-Code-specific failure classification.
   *
   * Claude Code surfaces model/provider errors as `API Error: <detail>` on
   * stdout JSON or stderr, and CLI misuse as commander-style messages. Only
   * the Claude-specific dialect is matched here; everything else falls through
   * to the shared HTTP/network signals.
   */
  classifyFailure(input: AgentFailureInput): AgentFailure {
    const text = failureHaystack(input);

    // lazy's own pre-flight auth error (see getAuthEnvVars above) — no
    // credential exists at all, so every launch will fail identically.
    if (text.includes('authentication required. set claude_code_oauth_token')) {
      return { class: 'fatal_auth', reason: 'no Claude Code credential configured' };
    }

    // CLI misuse: a bad model id or an unsupported flag fails the same way on
    // every attempt. Retrying re-runs the same argv.
    if (
      text.includes('unknown option') ||
      text.includes('unknown argument') ||
      text.includes('invalid model') ||
      text.includes('model not found') ||
      text.includes('did not match any of the known models')
    ) {
      return { class: 'fatal_config', reason: 'Claude Code rejected the invocation (model or flag)' };
    }

    return (
      classifyCommonFailureSignals(input) ?? {
        class: 'unknown',
        reason: 'unrecognized Claude Code failure',
      }
    );
  }

  defaultWatchdogTimeoutMs(): number {
    // 0 = "no agent-specific default"; the configured
    // `[agent] watchdog_output_timeout_ms` applies. Claude Code emits a rich
    // activity stream, so the supervisor measures silence between *forward
    // progress* events rather than between bytes — a long tool call is not a
    // hang, but a genuinely wedged one still trips the ceiling.
    return 0;
  }

  activityStream(): ClaudeCodeActivityStream {
    return new ClaudeCodeActivityStream();
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
