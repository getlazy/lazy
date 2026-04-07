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

// --- Command (host → supervisor) ---

export type CommandType = 'start' | 'unblock' | 'sync' | 'stop';

export interface StartCommand {
  type: 'start';
  task_id: string;
  goal: string;
  prompt: string;
  agent_id?: string;           // which agent to use (e.g., 'claude-code', 'cursor') — defaults to 'claude-code'
  system_prompt?: string;      // static system instructions (tool usage, commit guidelines) — passed as --append-system-prompt
  model_id?: string;
  parent_branch?: string;      // upstream branch for sync (pre-turn and/or post-turn)
  sync_before_work?: boolean;  // if true, sync upstream before work phase (default: false for start)
  sync_after_work?: boolean;   // if true, sync upstream after work phase
  remote_branch?: string;      // remote tracking ref to merge (e.g., "origin/lazy/abc12345") — sync-with-remote phase

  turn_started_at?: string;    // ISO timestamp — used for elapsed-time logging
  watchdog_output_timeout_ms?: number; // kill process if no output for this many ms (0 = disabled)
  protected_patterns?: string[];      // glob patterns for file permission violation detection
  post_turn_check?: string;           // command to run after agent work (output captured for review)
  post_turn_timeout?: number;          // timeout in seconds for post_turn_check (default: 300)
}

export interface UnblockCommand {
  type: 'unblock';
  task_id: string;
  goal: string;
  prompt: string;
  agent_id?: string;           // which agent to use (e.g., 'claude-code', 'cursor') — defaults to 'claude-code'
  system_prompt?: string;      // static system instructions (tool usage, commit guidelines) — passed as --append-system-prompt
  model_id?: string;
  agent_session_id?: string;  // resume existing agent session
  parent_branch?: string;      // upstream branch for sync (pre-turn and/or post-turn)
  sync_before_work?: boolean;  // if true, sync upstream before work phase
  sync_after_work?: boolean;   // if true, sync upstream after work phase
  remote_branch?: string;      // remote tracking ref to merge (e.g., "origin/lazy/abc12345") — sync-with-remote phase

  turn_started_at?: string;    // ISO timestamp — used for elapsed-time logging
  watchdog_output_timeout_ms?: number; // kill process if no output for this many ms (0 = disabled)
  protected_patterns?: string[];      // glob patterns for file permission violation detection
  post_turn_check?: string;           // command to run after agent work (output captured for review)
  post_turn_timeout?: number;          // timeout in seconds for post_turn_check (default: 300)
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
  parent_branch: string;       // upstream branch to merge
  agent_session_id?: string;   // existing agent session for conflict resolution
  model_id?: string;           // model for conflict resolution (if needed)
}

export interface StopCommand {
  type: 'stop';
  task_id: string;
  reason?: string;
}

export type Command = StartCommand | UnblockCommand | SyncCommand | StopCommand;

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
