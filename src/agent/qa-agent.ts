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
import { safeArgvPrompt } from './argv-safety';
import type { AgentFailure, AgentFailureInput } from './failure-taxonomy';

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
    effort?: string;
    /** Claude-Code-specific; not applicable to the QA agent (gated out upstream). */
    extraArgs?: string[];
  }): string[] {
    // The scenario file path comes from the QA_SCENARIO_FILE env var (read by the binary).
    // The supervisor sets cwd to the worktree path, so we pass '.' as the worktree arg.
    // QA_AGENT_SCRIPT is an absolute path resolved at import time via import.meta.dir.
    return ['bun', 'run', QA_AGENT_SCRIPT, '-p', safeArgvPrompt(opts.prompt, 'prompt'), '--worktree', '.'];
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

  /**
   * The qa-agent is LLM-free and local: it never hits an API, so there is no
   * auth, rate limit, or network condition to classify. A failure here means
   * the scenario or the script itself is broken — which no retry fixes, but
   * classifying it `fatal_config` would let a flaky test spawn block a task
   * permanently. `unknown` keeps the existing conservative retry behavior
   * (bounded in practice by the crash-loop detector, since qa-agent fails fast).
   */
  classifyFailure(_input: AgentFailureInput): AgentFailure {
    return { class: 'unknown', reason: 'qa-agent failure (no remote provider involved)' };
  }

  defaultWatchdogTimeoutMs(): number {
    // qa-agent should complete fast — 30 second timeout.
    return 30_000;
  }

  activityStream(): null {
    // Scripted and fast — it prints one JSON blob and exits. Byte-level
    // watchdogging is sufficient.
    return null;
  }

  discoverSessionFiles(_opts: {
    sessionId?: string;
    configDir?: string;
  }): string[] {
    // qa-agent doesn't persist session files.
    return [];
  }
}
