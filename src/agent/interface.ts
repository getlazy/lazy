/**
 * Agent and AgentPackaging interfaces — the core abstraction for multi-agent support.
 *
 * Agent: lean execution contract (auth, models, CLI args, parsing, errors, sessions).
 * AgentPackaging: deployment/infrastructure (Dockerfile, npm package, binary, tool checks).
 *
 * Each agent handles its own limitations internally. Callers never branch on agent
 * capabilities — they pass what they have and the agent does the right thing.
 */

import type { AgentResponse } from '../types';
import type { AgentFailure, AgentFailureInput } from './failure-taxonomy';
import type { AgentActivityStream } from './activity-stream';

export type { AgentResponse };
export type { AgentActivityStream, AgentActivityEvent, AgentActivityKind } from './activity-stream';
export type { AgentFailure, AgentFailureInput, AgentFailureClass } from './failure-taxonomy';

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
   * Returns an array to support agents that need multiple env vars (e.g., Ollama).
   * Throws if required credentials are not available.
   */
  getAuthEnvVars(): Array<{ key: string; value: string }>;

  /**
   * Check if auth credentials are available (non-throwing).
   */
  hasAuthEnv(): boolean;

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
    /** Reasoning effort level passed as `--effort` (Claude Code only). */
    effort?: string;
    /**
     * Permission mode for this invocation. When 'plan', the agent runs
     * read-only (plan-only, no writes). Used by `lazy review -i` for Q&A.
     * Agents that don't support plan mode should ignore this.
     */
    permissionMode?: 'plan' | 'default';
    /**
     * Extra CLI args appended after all other flags. Used to thread the host
     * runner's OS-sandbox settings (`--settings <json>`) into the launch.
     * See src/runner/host-sandbox.ts.
     */
    extraArgs?: string[];
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
   * Map a failed launch to the shared failure taxonomy.
   *
   * This is the ONLY place agent-specific error text is interpreted for retry
   * purposes — the supervisor branches on the returned class, never on strings.
   * Implementations should match their own dialect first and fall back to
   * `classifyCommonFailureSignals` for the shared HTTP/network signals.
   *
   * Return `unknown` rather than guessing: the supervisor retries `unknown`
   * conservatively instead of stopping, so a wrong `fatal_*` is the more
   * expensive mistake.
   */
  classifyFailure(input: AgentFailureInput): AgentFailure;

  /**
   * Default watchdog output timeout in ms. 0 = disabled.
   * Used when the user hasn't set an explicit value in lazy.toml.
   * Agents that are known to hang (e.g., Cursor) return a non-zero default.
   */
  defaultWatchdogTimeoutMs(): number;

  /**
   * The model this agent runs when nothing more specific was chosen, or `null`
   * for "no opinion — let lazy's configured default decide".
   *
   * `null`, NOT `''`: "I have no default" is a different answer from "my
   * default is a model name", and the type says so — an empty string is a
   * sentinel the compiler cannot police, and it reads as a real (broken) value
   * at every call site. `resolveAgentModel` rejects one rather than treating it
   * as either answer. Same reason {@link activityStream} returns `null` instead
   * of an inert stream.
   *
   * Otherwise the same shape as {@link defaultWatchdogTimeoutMs}: an agent
   * declaring a fact about itself, not a caller branch. Cursor returns `auto`
   * because letting Cursor pick the model is its own sensible default, and
   * lazy's `[models] default` is an Anthropic model name that means nothing to
   * it.
   *
   * PRECEDENCE — decided once in `resolveAgentModel` (src/agent/agent-model.ts):
   *   1. an explicit `--model` override (`overrideModel`)
   *   2. the authoritative model of a local backend ([models.roles.agent] with
   *      backend ollama/proxy) — a pinned local model is never stomped
   *   3. a soft per-task model (sticky model, `task.model`) on the anthropic backend
   *   4. this agent-declared default
   *   5. `[models] default`
   *
   * A future per-agent config key slots in between (3) and (4): it would
   * override this declaration while still yielding to an explicit per-task
   * choice. Do NOT return a model here merely to restate lazy's global default
   * — an agent with no opinion returns `null` so config keeps deciding.
   */
  defaultModel(): string | null;

  /**
   * Parser for this agent's incremental stdout, or `null` if it has none.
   *
   * Returning a stream is a capability declaration, not a caller branch: the
   * supervisor's watchdog asks once and adapts its own behavior. With a stream
   * it can tell forward progress from a keep-alive and can see the agent's
   * final result the moment it is emitted — which is what lets it arm a kill
   * timer only AFTER the summary is safely captured. Without one it falls back
   * to treating any byte of output as liveness, which is all Cursor supports.
   *
   * An agent that returns a stream MUST build exec args that actually produce
   * that stream (e.g. `--output-format stream-json`).
   *
   * @see src/agent/activity-stream.ts
   */
  activityStream(): AgentActivityStream | null;

  /**
   * Whether `lazy pair` may hand a human an interactive session on this
   * agent's CLI, in the task's worktree, on the HOST.
   *
   * This is a refusal gate, not a caller branch in the sense the note above
   * forbids — same shape as AgentPackaging.supportsContainerRunner(). An agent
   * cannot "do the right thing internally" here, because the right thing is to
   * not run at all: the decision has to be made before a lock is taken, a
   * status is moved, or a process is launched.
   *
   * Returning false is the safe default for a new agent. Say true only once
   * BOTH hold:
   *
   *   1. A session the agent wrote INSIDE a task container is not silently
   *      resumed on the host. Chat history is written by the agent, so
   *      resuming it host-side turns agent-authored text into input for a
   *      session running as the human with their credentials. Claude Code
   *      qualifies only because lazy bridges those files explicitly and
   *      narrowly (symlinks, additive, removed on exit — see pair-bridge.ts).
   *   2. Pairing is actually useful — the human gets the agent's prior
   *      conversation, not an empty session with no memory of the work.
   *
   * @see src/cli/commands/pair.ts
   */
  supportsPairing(): boolean;

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

  /**
   * Whether this agent can run under container runners (docker/podman).
   *
   * Gates the runner/agent compatibility checks in src/runner/index.ts and
   * src/daemon/task-launcher.ts, and controls whether the container image is
   * augmented with this agent's install (see getDockerfileContent in
   * src/capture/claude.ts). An agent returning true MUST provide a working
   * dockerInstallCommand().
   */
  supportsContainerRunner(): boolean;

  /** Install command for the Dockerfile (some agents use curl, not npm). */
  dockerInstallCommand(): string;

  /** Generate a complete default Dockerfile for this agent. */
  generateDockerfile(): string;

  /** Tool checks the supervisor runs before starting work. */
  supervisorToolChecks(): { cmd: string; name: string; hint: string }[];

  /** Health checks for `lazy doctor`. */
  diagnose(): { state: 'ok' | 'fail'; what: string; reason?: string }[];
}
