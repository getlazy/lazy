/**
 * QaAgent — Agent implementation for the deterministic qa-agent.
 *
 * A scriptable, LLM-free agent for end-to-end testing. It reads a scenario
 * file and executes canned actions instead of calling an LLM. The supervisor
 * treats it identically to Claude Code or Cursor.
 */

import { join } from 'path';
import type { AgentResponse } from '../types';
import type { Agent } from './interface';

// Resolve the absolute path to the qa-agent script.
// QA_AGENT_SCRIPT env var takes priority (set by QA test driver when running
// against an installed binary where the source tree isn't at import.meta.dir).
// Fallback: import.meta.dir resolution (works when running from source tree).
const QA_AGENT_SCRIPT = process.env.QA_AGENT_SCRIPT
  || join(import.meta.dir, '..', 'qa', 'agent.ts');

export class QaAgent implements Agent {
  readonly id = 'qa-agent';

  getAuthEnvVars(): Array<{ key: string; value: string }> {
    // qa-agent doesn't need auth — return a no-op env var.
    return [{ key: 'QA_AGENT_AUTH', value: 'none' }];
  }

  hasAuthEnv(): boolean {
    // Always true — no auth needed for a testing agent.
    return true;
  }

  buildExecArgs(opts: {
    prompt: string;
    systemPrompt?: string;
    modelId?: string;
    sessionId?: string;
    dangerouslySkipPermissions: boolean;
  }): string[] {
    // The scenario file path comes from the QA_SCENARIO_FILE env var (read by the binary).
    // The supervisor sets cwd to the worktree path, so we pass '.' as the worktree arg.
    // QA_AGENT_SCRIPT is an absolute path resolved at import time via import.meta.dir.
    return ['bun', 'run', QA_AGENT_SCRIPT, '-p', opts.prompt, '--worktree', '.'];
  }

  parseResponse(stdout: string, _opts?: { workingDir?: string }): AgentResponse {
    let parsed: AgentResponse;
    try {
      parsed = JSON.parse(stdout) as AgentResponse;
    } catch (err) {
      throw new Error(`Failed to parse qa-agent JSON output: ${err instanceof Error ? err.message : err}`);
    }

    if (!parsed.result || !parsed.session_id) {
      throw new Error('qa-agent response missing required fields (result, session_id)');
    }

    return parsed;
  }

  isPromptTooLongError(_errorMessage: string): boolean {
    return false;
  }

  isSessionNotFoundError(_errorMessage: string): boolean {
    return false;
  }

  defaultWatchdogTimeoutMs(): number {
    // qa-agent should complete fast — 30 second timeout.
    return 30_000;
  }

  discoverSessionFiles(_opts: {
    sessionId?: string;
    configDir?: string;
  }): string[] {
    // qa-agent doesn't persist session files.
    return [];
  }
}
