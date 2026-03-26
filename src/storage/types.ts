/**
 * Storage layer types
 *
 * These types define the internal storage format for the file-based storage.
 * They may differ slightly from the domain types (e.g., arrays wrapped in objects).
 */

import type {
  Task,
  Session,
  Turn,
  MergeConflict,
  FileViolation,
  Commit,
  Review,
  ReviewVerdict,
  Comment,
  CommentSource,
  Note,
  TaskPromptVersion,
  TaskStatus,
  SessionOutcome,
  TurnRole,
  TokenUsage,
  ModelName,
  Actor,
} from '../types';

// Re-export domain types that are used as-is
export type {
  Task,
  Session,
  Turn,
  MergeConflict,
  FileViolation,
  Commit,
  Review,
  ReviewVerdict,
  Comment,
  CommentSource,
  Note,
  TaskPromptVersion,
  TaskStatus,
  SessionOutcome,
  TurnRole,
  TokenUsage,
  ModelName,
  Actor,
};

/**
 * Status change entry - records a task status transition.
 * Stored per-task in status-changelog.json.
 */
export interface StatusChange {
  status: string;
  timestamp: number;
  /** Who triggered this status change: human (CLI) or builder (MCP). */
  actor?: Actor;
}

/**
 * Internal format for status-changelog.json
 */
export interface StatusChangelogFile {
  changes: StatusChange[];
}

/**
 * Worktree snapshot - captures uncommitted changes at a point in time
 */
export interface WorktreeSnapshot {
  id: string;
  session_id: string;
  turn_sequence: number;
  uncommitted_diff: string;
  git_status: string;
  timestamp: number;
}

/**
 * Task tree node for hierarchical display
 */
export interface TaskTreeNode {
  task: Task;
  session: Session | null;
  children: TaskTreeNode[];
  depth: number;
}

/**
 * Options for filtering task lists
 */
export interface ListTasksOptions {
  rootsOnly?: boolean;
  blockedOnly?: boolean;
  backlogOnly?: boolean;
  workingOnly?: boolean;
  interruptedOnly?: boolean;
  pairingOnly?: boolean;
  mergingOnly?: boolean;
  withSessionsOnly?: boolean;
  nonTerminalOnly?: boolean;
}

/**
 * Storage version metadata
 */
export interface StorageVersion {
  schema_version: number;
  migrated_at?: string;
  migrated_from?: string;
}

// --- File storage internal formats ---

/**
 * Internal format for turns.json
 */
export interface TurnsFile {
  turns: Turn[];
}

/**
 * Internal format for commits.json
 */
export interface CommitsFile {
  commits: Commit[];
}

/**
 * Internal format for prompt-history.json
 */
export interface PromptHistoryFile {
  versions: TaskPromptVersion[];
}

/**
 * Internal format for snapshots.json
 */
export interface SnapshotsFile {
  snapshots: WorktreeSnapshot[];
}

/**
 * Internal format for reviews.json
 */
export interface ReviewsFile {
  reviews: Review[];
}

/**
 * Internal format for comments.json (formerly notes.json)
 */
export interface CommentsFile {
  comments: Comment[];
}

/** @deprecated Use CommentsFile instead */
export type NotesFile = CommentsFile;

/**
 * Search result entry
 */
export interface SearchResult {
  entity_type: 'task' | 'prompt' | 'turn' | 'commit' | 'comment' | 'conversation';
  entity_id: string;
  task_id: string;
  task_code: string | null;
  task_goal: string;
  content: string;
  match_context: string;
}

// --- Conversation types ---

export interface ConversationStats {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  subagentCount: number;
  totalTokens: number;
}

export interface StoredConversation {
  /** Claude Code session UUID */
  sessionId: string;
  /** Encoded project directory name from Claude Code */
  projectPath: string;
  /** Working directory during the session */
  cwd: string | null;
  /** Claude Code version */
  version: string | null;
  /** Git branch during the session */
  gitBranch: string | null;
  /** When the conversation started (ISO timestamp) */
  startedAt: string | null;
  /** When the conversation ended (ISO timestamp) */
  endedAt: string | null;
  /** When this conversation was imported (unix ms) */
  importedAt: number;
  /** Summary extracted from first user message */
  summary: string;
  /** Stats about the conversation */
  stats: ConversationStats;
  /** Token usage breakdown */
  totalUsage: TokenUsage;
  /** Main conversation messages */
  messages: StoredMessage[];
  /** Subagent conversations */
  subagents: StoredSubagent[];
}

export interface StoredMessage {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  role: 'user' | 'assistant';
  text: string;
  model: string | null;
  usage: TokenUsage | null;
}

export interface StoredSubagent {
  agentId: string;
  messages: StoredMessage[];
}
