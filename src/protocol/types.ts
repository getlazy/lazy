/**
 * Supervisor protocol types.
 *
 * File-system based protocol between host (lazy CLI) and supervisor (lazy-agent)
 * running inside the container. All files live in <datadir>/tasks/<task-id>/protocol/
 * on the host, shared via Docker volume mount.
 *
 * Protocol flow:
 *   host writes command.json → supervisor reads, executes phases → supervisor writes response.json
 *   supervisor writes status.json at phase boundaries (checkpoint/heartbeat)
 */

import type { TokenUsage, MergeConflict, FileViolation } from '../types';

/**
 * Wire-protocol version between host CLI/daemon and supervisor.
 *
 * Bump when ANY of:
 *   - Start/Unblock/Sync (or other supervisor) command shape changes incompatibly
 *   - RPC method signatures between CLI/daemon/supervisor change
 *   - Supervisor↔daemon wire format changes
 *
 * The supervisor refuses commands whose `protocol_version` doesn't match this
 * constant. Lazy version (the package version) is allowed to drift between
 * client and supervisor as long as the protocol matches — different projects
 * on one machine may run different lazy versions concurrently.
 *
 * Integer only. Protocols either match or they don't; no semver, no ranges.
 */
export const PROTOCOL_VERSION = 1;

// --- Command (host → supervisor) ---

export type CommandType = 'start' | 'unblock' | 'ask' | 'sync' | 'stop';

export interface StartCommand {
  type: 'start';
  task_id: string;
  goal: string;
  prompt: string;
  protocol_version?: number;   // wire protocol version — supervisor rejects on mismatch (see PROTOCOL_VERSION)
  agent_id?: string;           // which agent to use (e.g., 'claude-code', 'cursor') — defaults to 'claude-code'
  system_prompt?: string;      // static system instructions (tool usage, commit guidelines) — passed as --append-system-prompt
  model_id?: string;
  effort?: string;             // reasoning effort level — passed as --effort (Claude Code only)
  parent_branch?: string;      // upstream branch for sync (pre-turn and/or post-turn)
  sync_before_work?: boolean;  // if true, sync upstream before work phase (default: false for start)
  sync_after_work?: boolean;   // if true, sync upstream after work phase
  remote_branch?: string;      // remote tracking ref to merge (e.g., "origin/lazy/abc12345") — sync-with-remote phase

  turn_started_at?: string;    // ISO timestamp — used for elapsed-time logging
  watchdog_output_timeout_ms?: number; // kill process if no output for this many ms (0 = disabled)
  graceful_exit_timeout_ms?: number;   // kill process this many ms after lazy_commit returns if it hasn't exited (0 = disabled)
  protected_patterns?: string[];      // glob patterns for file permission violation detection
  branch_point_sha?: string;          // SHA of the commit the task branched from — files not present here are task-created and exempt from permission violations
  post_turn_check?: string;           // command to run after agent work (output captured for review)
  post_turn_timeout?: number;          // timeout in seconds for post_turn_check (default: 300)
}

export interface UnblockCommand {
  type: 'unblock';
  task_id: string;
  goal: string;
  prompt: string;
  protocol_version?: number;   // wire protocol version — supervisor rejects on mismatch (see PROTOCOL_VERSION)
  agent_id?: string;           // which agent to use (e.g., 'claude-code', 'cursor') — defaults to 'claude-code'
  system_prompt?: string;      // static system instructions (tool usage, commit guidelines) — passed as --append-system-prompt
  model_id?: string;
  effort?: string;             // reasoning effort level — passed as --effort (Claude Code only)
  agent_session_id?: string;  // resume existing agent session
  parent_branch?: string;      // upstream branch for sync (pre-turn and/or post-turn)
  sync_before_work?: boolean;  // if true, sync upstream before work phase
  sync_after_work?: boolean;   // if true, sync upstream after work phase
  remote_branch?: string;      // remote tracking ref to merge (e.g., "origin/lazy/abc12345") — sync-with-remote phase

  /**
   * Agent permission mode for this turn. When 'plan', the agent runs read-only
   * (no writes, no commits) — used by `lazy review -i` for Q&A against the
   * agent's session. Omitted/undefined means the default (unconstrained) mode.
   */
  permission_mode?: 'plan' | 'default';

  turn_started_at?: string;    // ISO timestamp — used for elapsed-time logging
  watchdog_output_timeout_ms?: number; // kill process if no output for this many ms (0 = disabled)
  graceful_exit_timeout_ms?: number;   // kill process this many ms after lazy_commit returns if it hasn't exited (0 = disabled)
  protected_patterns?: string[];      // glob patterns for file permission violation detection
  branch_point_sha?: string;          // SHA of the commit the task branched from — files not present here are task-created and exempt from permission violations
  post_turn_check?: string;           // command to run after agent work (output captured for review)
  post_turn_timeout?: number;          // timeout in seconds for post_turn_check (default: 300)
}

/**
 * Ask command — a read-only "ask turn" against an existing agent session.
 *
 * Used by `lazy review -i` so a reviewer can ask questions of the agent while
 * walking a task's diff. Semantically distinct from Unblock:
 *   - Read-only: plan mode always, no writes, no commits.
 *   - No integration machinery: skips sync_with_remote, merge_and_fix,
 *     post_turn_check, post_turn_sync, violation detection. Only `work` +
 *     `writing_response` phases run.
 *   - Daemon-owned response: the daemon waits synchronously for response.json
 *     and returns the answer in the RPC result, so the CLI doesn't poll and
 *     can't race the reconciler.
 *
 * Always resumes an existing session — an ask without a prior session has no
 * meaning for review.
 */
export interface AskCommand {
  type: 'ask';
  task_id: string;
  goal: string;
  prompt: string;
  protocol_version?: number;   // wire protocol version — supervisor rejects on mismatch (see PROTOCOL_VERSION)
  agent_id?: string;
  system_prompt?: string;
  model_id?: string;
  effort?: string;
  agent_session_id?: string;  // always set by the daemon — asks always resume

  turn_started_at?: string;
  watchdog_output_timeout_ms?: number;
  // The remaining fields are added by `commonCommandFields` but are no-ops on
  // the ask path (read-only plan mode — no commits, no checks, no violation
  // detection). They are accepted so every command builder can share one
  // helper.
  protected_patterns?: string[];
  post_turn_check?: string;
  post_turn_timeout?: number;
}

/**
 * Sync command — merge upstream into task worktree without agent work.
 *
 * Semantically distinct from Start (fresh start) and Unblock (feedback + work).
 * Sync is a continuation of existing work: merge parent branch changes, resolve
 * conflicts if needed, then stop. No agent work phase runs.
 */
export interface SyncCommand {
  type: 'sync';
  task_id: string;
  protocol_version?: number;   // wire protocol version — supervisor rejects on mismatch (see PROTOCOL_VERSION)
  parent_branch: string;       // upstream branch to merge (for display/logging)
  /**
   * SHA of the upstream branch resolved on the host at the moment the sync
   * was dispatched. When present, the supervisor merges this exact commit
   * rather than re-resolving `parent_branch`. Pinning the merge target to
   * the same SHA the daemon saw prevents any ref-state drift between the
   * moment the daemon decides to sync and the moment the supervisor runs
   * the merge. Fixes the silent no-op sync regression (see fix-sync-no-merge).
   */
  upstream_sha?: string;
  agent_session_id?: string;   // existing agent session for conflict resolution
  model_id?: string;           // model for conflict resolution (if needed)
}

export interface StopCommand {
  type: 'stop';
  task_id: string;
  reason?: string;
}

export type Command = StartCommand | UnblockCommand | AskCommand | SyncCommand | StopCommand;

// --- Response (supervisor → host) ---

export type ResponseStatus = 'completed' | 'error';

export interface CompletedResponse {
  status: 'completed';
  result: string;
  session_id: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Merge conflicts captured before agent resolution (if any merges had conflicts) */
  merge_conflicts?: MergeConflict[];
  /** File permission violations detected after agent work */
  violations?: FileViolation[];
  /** Whether the agent was given a push-back chance for violations */
  pushed_back?: boolean;
  /** Exit code of the post-turn check command (undefined if no check, -1 if exec failed, -2 if timed out) */
  check_exit_code?: number;
  /** Captured stderr output from the post-turn check command (truncated to last 200 lines) */
  check_output?: string;
  /**
   * Wall-clock duration (ms) of the agent process itself — measured inside
   * the supervisor around the `work` phase. Used by LAZY_VERBOSE telemetry
   * to break ask-turn latency into agent vs supervisor vs daemon vs rpc.
   */
  agent_duration_ms?: number;
}

export interface ErrorResponse {
  status: 'error';
  error: string;
  phase: SupervisorPhase;
  /** Process exit code (when available from agent crash) */
  exit_code?: number;
  /** Last N lines of stderr */
  stderr?: string;
  /** Error message extracted from stdout JSON (Claude Code puts errors in stdout) */
  stdout_error?: string;
  /** How long the agent ran before crashing (ms) */
  duration_ms?: number;
  /**
   * Claude session id, when recoverable. Set by the supervisor on
   * GracefulExitTimeoutError so the human can `lazy unblock` after the kill
   * and pick up the conversation cleanly instead of orphaning it.
   */
  session_id?: string;
}

export type Response = CompletedResponse | ErrorResponse;

// --- Status (supervisor checkpoint/heartbeat) ---

export type SupervisorPhase =
  | 'idle'
  | 'reading_command'
  | 'sync_with_remote'
  | 'sync_with_remote_done'
  | 'merge_and_fix'
  | 'merge_and_fix_done'
  | 'work'
  | 'work_done'
  | 'permission_pushback'
  | 'permission_pushback_done'
  | 'post_turn_check'
  | 'post_turn_check_done'
  | 'post_turn_sync'
  | 'post_turn_sync_done'
  | 'retrying'
  | 'writing_response';

export interface RetryError {
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface SupervisorStatus {
  phase: SupervisorPhase;
  task_id: string;
  command_type: CommandType;
  started_at: string;
  updated_at: string;
  /** ISO timestamp when the current phase was entered — used by watch/show header for elapsed-in-phase display. */
  phase_started_at?: string;
  /** Currently running subprocess command (e.g., "cargo build") — rendered by watch/show header when set. */
  current_command?: string;
  /** ISO timestamp when the current subprocess command started — used for elapsed-in-command display. */
  current_command_started_at?: string;
  /** SHA of HEAD before this turn started (for deterministic turn diff) */
  pre_turn_sha?: string;
  /** SHA of HEAD after sync-with-remote phase completed (merged origin/<branch>) */
  post_remote_sync_sha?: string;
  /** SHA of HEAD after pre-turn sync-with-upstream phase completed */
  post_merge_sha?: string;
  /** SHA of the upstream branch at the time it was merged (for accurate diff scope) */
  upstream_merge_sha?: string;
  /** SHA of HEAD after work phase completed (before post-turn sync) */
  post_work_sha?: string;
  /** PID of the supervisor process */
  pid: number;
  /** Retry count (only present when phase is 'retrying') */
  retryCount?: number;
  /** Deduplicated error log (only present when phase is 'retrying') */
  errors?: RetryError[];
}
