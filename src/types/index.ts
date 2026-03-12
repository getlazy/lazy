export type TaskStatus = 'working' | 'blocked' | 'pairing' | 'interrupted' | 'merging' | 'conflict' | 'zombie' | 'complete' | 'abandoned' | 'closed' | 'backlog';

// Status classification functions live in src/task-state-machine.ts (single source of truth).
// Re-exported here for backward compatibility — consumers can import from either location.
export { TERMINAL_STATUSES, isTerminalStatus, isActiveStatus, isBlockedStatus } from '../task-state-machine';

export type TaskType = 'task' | 'fix' | 'spike' | 'refactor' | 'test' | 'audit' | 'migrate' | 'document' | 'tidy' | 'rework' | 'feature' | 'release';

export const DEFAULT_TASK_TYPE: TaskType = 'task';

export const VALID_TASK_TYPES: readonly TaskType[] = ['task', 'fix', 'spike', 'refactor', 'test', 'audit', 'migrate', 'document', 'tidy', 'rework', 'feature', 'release'] as const;

export type SessionOutcome = 'accepted' | 'rejected';
export type CommitStatus = 'pending_review' | 'approved' | 'rejected' | 'superseded';
export type ReviewVerdict = 'approve' | 'reject' | 'request_changes';
export type TurnRole = 'human' | 'agent';

/** Who performed an action: human (CLI), builder (MCP), or system (reconciler/auto-resume). */
export type Actor = 'human' | 'builder' | 'system';

/** Universal model monikers — agent-agnostic capability tiers. */
export type ModelMoniker = 'apprentice' | 'journeyman' | 'master';

/** All accepted model names: universal monikers + legacy Claude-specific aliases. */
export type ModelName = ModelMoniker | 'sonnet' | 'opus' | 'haiku';

/** Ordered list of all valid model names for validation and help text. */
export const VALID_MODEL_NAMES: readonly ModelName[] = [
  'apprentice', 'journeyman', 'master',
  'sonnet', 'opus', 'haiku',
] as const;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface Task {
  id: string;
  code: string | null;
  goal: string;
  prompt: string;
  type: TaskType;
  status: TaskStatus;
  created_at: number;
  completed_at: number | null;
  parent_task_id: string | null;
  branched_from_sha: string | null;
  close_reason: string | null;
  model: ModelName | null;
  agent_id: string;
  metadata: Record<string, string> | null;
}

export interface Session {
  id: string;
  task_id: string;
  agent_id: string;
  started_at: number;
  ended_at: number | null;
  outcome: SessionOutcome | null;
  git_branch: string;
  git_start_sha: string;
  agent_session_id: string | null;
  last_interaction_at: number | null;
  total_duration_ms: number;
  total_usage: TokenUsage | null;
  container_name: string | null;
  /** Human-readable reason for the last interruption */
  interrupt_reason: string | null;
  /** Container exit code from the last interruption */
  interrupt_exit_code: number | null;
  /** Timestamp of the last interruption */
  interrupt_at: number | null;
  /** Last N lines of container logs from the interruption */
  interrupt_logs: string | null;
  /** Number of consecutive interruptions without a successful turn completion */
  consecutive_interruptions: number;
  /** Whether the current working session was auto-resumed by the reconciler */
  auto_resumed: boolean;
  /** SHA of the upstream branch at the time of last merge (for accurate diff scope) */
  upstream_merge_sha: string | null;
}

export interface MergeConflict {
  /** File path relative to the worktree root */
  path: string;
  /** Full file content with conflict markers (<<<<<<< / ======= / >>>>>>>) */
  content: string;
  /** The ref being merged in (e.g., "main", "origin/lazy/abc12345") */
  merge_source: string;
}

export interface FileViolation {
  /** Relative path to the violated file */
  file: string;
  /** SHA to revert to if rejected */
  base_sha: string;
  /** Review status */
  status: 'pending' | 'approved' | 'rejected';
}

export interface Turn {
  id: string;
  session_id: string;
  sequence: number;
  role: TurnRole;
  content: string;
  timestamp: number;
  usage: TokenUsage | null;
  /** SHA of HEAD at the very start of the turn (before pre-turn sync) */
  start_sha: string | null;
  /** SHA where agent work begins (after pre-turn sync, or same as start_sha if no sync) */
  start_sha_work: string | null;
  /** SHA where agent work ends (before post-turn sync) */
  end_sha_work: string | null;
  /** SHA of HEAD at the very end of the turn (after post-turn sync, or same as end_sha_work if no sync) */
  end_sha: string | null;
  /** Merge conflicts present at the start of this turn (before agent resolution) */
  merge_conflicts?: MergeConflict[];
  /** Model used for this turn (sticky: next turn inherits if no explicit override) */
  model?: ModelName;
  /** Full prompt sent to agent (only for human turns that trigger agent work) */
  prompt?: string;
  /** Who created this turn: human (CLI) or builder (MCP). Only meaningful for role='human' turns. */
  actor?: Actor;
  /** File permission violations detected in this turn */
  violations?: FileViolation[];
}

export interface Commit {
  id: string;
  session_id: string;
  sha: string;
  message: string;
  status: CommitStatus;
  timestamp: number;
}

export interface Review {
  id: string;
  commit_id: string;
  verdict: ReviewVerdict;
  rationale: string;
  reviewer: string;
  timestamp: number;
}

export interface TaskPromptVersion {
  id: string;
  task_id: string;
  version: number;
  content: string;
  created_at: number;
  session_id: string | null;
}

export interface Comment {
  id: string;
  task_id: string;
  content: string;
  created_at: number;
  /** Who left this comment: human (CLI) or builder (MCP). */
  actor?: Actor;
}

/** @deprecated Use Comment instead */
export type Note = Comment;

export interface AgentResponse {
  result: string;
  session_id: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}
