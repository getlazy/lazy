/**
 * Agent and AgentPackaging interfaces — the core abstraction for multi-agent support.
 *
 * Agent: lean execution contract (auth, models, CLI args, parsing, errors, sessions).
 * AgentPackaging: deployment/infrastructure (Dockerfile, npm package, binary, tool checks).
 *
 * Each agent handles its own limitations internally. Callers never branch on agent
 * capabilities — they pass what they have and the agent does the right thing.
 */

import type { ModelMoniker, AgentResponse } from '../types';

export type { ModelMoniker, AgentResponse };

/**
 * Core agent contract — execution, parsing, and model resolution.
 *
 * Each agent handles its own limitations internally (e.g., Cursor prepends
 * system prompt to user prompt in buildExecArgs because it lacks
 * --append-system-prompt). Callers do NOT branch on agent capabilities.
 */
export interface Agent {
  readonly id: string;

  /**
   * Get auth environment variables for this agent.
   * Throws if required credentials are not available.
   */
  getAuthEnv(): { key: string; value: string };

  /**
   * Check if auth credentials are available (non-throwing).
   */
  hasAuthEnv(): boolean;

  /**
   * Resolve a model name to the agent's concrete model ID.
   *
   * Accepts universal monikers ('apprentice', 'journeyman', 'master') and
   * agent-specific names. Throws if the name is not recognized — never
   * silently passes through unknown strings.
   */
  resolveModelId(modelName: string): string;

  /**
   * List available model names for this agent. Includes both universal
   * monikers and any agent-specific aliases. Used by CLI help text and
   * `lazy models` to show the user what's valid.
   *
   * Returns entries like:
   *   { name: 'master', modelId: 'claude-opus-4-6', isDefault: false }
   *   { name: 'journeyman', modelId: 'claude-sonnet-4-5-20250929', isDefault: true }
   */
  availableModels(): { name: string; modelId: string; isDefault: boolean }[];

  /**
   * Build the CLI command to run the agent in headless mode.
   * Returns the full argv array.
   *
   * Each agent handles its own quirks internally:
   * - Cursor: prepends system prompt to user prompt (no --append-system-prompt)
   * - Codex: uses `codex exec` subcommand with --config developer_instructions
   * - Claude: uses --append-system-prompt natively
   */
  buildExecArgs(opts: {
    prompt: string;
    systemPrompt?: string;
    modelId?: string;
    sessionId?: string;
    dangerouslySkipPermissions: boolean;
  }): string[];

  /**
   * Parse the agent's stdout output into an AgentResponse.
   *
   * For agents that don't include session ID in stdout (Codex plain-text mode),
   * this method reads session files from disk to recover the session ID.
   * The workingDir parameter tells the agent where to look.
   */
  parseResponse(stdout: string, opts?: { workingDir?: string }): AgentResponse;

  /**
   * Check if an error message indicates the prompt is too long.
   */
  isPromptTooLongError(errorMessage: string): boolean;

  /**
   * Check if an error message indicates the session ID is invalid.
   */
  isSessionNotFoundError(errorMessage: string): boolean;

  /**
   * Default watchdog output timeout in ms. 0 = disabled.
   * Used when the user hasn't set an explicit value in lazy.toml.
   * Agents that are known to hang (e.g., Cursor) return a non-zero default.
   */
  defaultWatchdogTimeoutMs(): number;

  /**
   * Discover session log files for conversation capture.
   * Returns file paths that can be parsed for conversation history.
   *
   * Used by `lazy pair` and builder for conversation capture.
   * Returns empty array for agents that don't persist readable session files.
   */
  discoverSessionFiles(opts: {
    sessionId?: string;
    configDir?: string;
  }): string[];
}

/**
 * Packaging and deployment concerns — separate from core execution.
 * A new agent implementor doesn't need to know about Docker to get started.
 */
export interface AgentPackaging {
  readonly agentId: string;

  /** Agent-specific config directory name (e.g., '.claude', '.codex'). */
  configDirName(): string;

  /** NPM package for Dockerfile installation, or empty if installed differently. */
  npmPackage(): string;

  /** CLI binary name (e.g., 'claude', 'agent', 'codex'). */
  binaryName(): string;

  /** Install command for the Dockerfile (some agents use curl, not npm). */
  dockerInstallCommand(): string;

  /** Generate a complete default Dockerfile for this agent. */
  generateDockerfile(): string;

  /** Tool checks the supervisor runs before starting work. */
  supervisorToolChecks(): { cmd: string; name: string; hint: string }[];

  /** Health checks for `lazy doctor`. */
  diagnose(): { state: 'ok' | 'fail'; what: string; reason?: string }[];
}
