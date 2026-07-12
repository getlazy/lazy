export type TaskStatus = 'working' | 'blocked' | 'pairing' | 'interrupted' | 'submitted' | 'merging' | 'conflict' | 'zombie' | 'complete' | 'abandoned' | 'backlog';

// Status classification functions live in src/task-state-machine.ts (single source of truth).
// Re-exported here for backward compatibility — consumers can import from either location.
export { TERMINAL_STATUSES, isTerminalStatus, isActiveStatus, isBlockedStatus } from '../task-state-machine';

export type TaskType = 'task' | 'fix' | 'spike' | 'refactor' | 'test' | 'audit' | 'migrate' | 'document' | 'tidy' | 'rework' | 'feature' | 'release';

export const DEFAULT_TASK_TYPE: TaskType = 'task';

export const VALID_TASK_TYPES: readonly TaskType[] = ['task', 'fix', 'spike', 'refactor', 'test', 'audit', 'migrate', 'document', 'tidy', 'rework', 'feature', 'release'] as const;

/**
 * A task's integration target — the single source of truth for "where do I
 * sync against / accept into". Modeled as a discriminated union so illegal
 * states are unrepresentable: a task is EITHER stacked on another task
 * (branch derived from the parent) OR integrates into a named branch. It can
 * never be both, neither, or carry a contradictory pair.
 *
 * This replaces the old `(parent_task_id?, remote_target_branch?)` pair, which
 * encoded one concept across two independent nullable fields and let illegal
 * combinations (both set, both empty, a `lazy/...` ref in the branch slot)
 * slip through by convention rather than by type.
 *
 * Construct via the smart constructors in `src/task-target.ts`
 * (`taskTarget` / `branchTarget`) — `branchTarget` rejects `lazy/...` refs and
 * empty strings at the construction boundary.
 */
export type TaskTarget =
  | { kind: 'task'; parentTaskId: string }   // stacked on another task; branch derived from parent
  | { kind: 'branch'; branch: string };      // top-level; integrates into a named branch

export type SessionOutcome = 'accepted' | 'rejected';
export type CommitStatus = 'pending_review' | 'approved' | 'rejected' | 'superseded';
export type ReviewVerdict = 'approve' | 'reject' | 'request_changes';
export type TurnRole = 'human' | 'agent';

/** Who performed an action: human (CLI), builder (MCP), or system (reconciler/auto-resume). */
export type Actor = 'human' | 'builder' | 'system' | 'supervisor';


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
  /**
   * Canonical integration target. Replaces the old
   * `(parent_task_id, metadata.remote_target_branch)` pair — see {@link TaskTarget}.
   * The legacy two-field shape is normalized into this union at the storage
   * boundary on read and serialized back from it on write.
   */
  target: TaskTarget;
  branched_from_sha: string | null;
  close_reason: string | null;
  model: string | null;
  agent_id: string;
  metadata: Record<string, string> | null;
  /**
   * Upstream sync counter. 0 = up to date, >0 = needs sync.
   * Incremented when a sync signal arrives (parent changed, explicit request).
   * Reset to 0 when sync launches. If new signals arrive during merge, the
   * counter goes >0 again, signaling that another sync is needed after completion.
   */
  pending_sync: number;
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
  /**
   * Whether the user explicitly stopped this session via `lazy stop` / `lazy_stop`.
   * When true, the reconciler will not auto-resume the interrupted task — a manual
   * `lazy resume` / `lazy unblock` is required. Cleared by resetConsecutiveInterruptions
   * (i.e. on manual resume/unblock or successful turn).
   */
  user_stopped: boolean;
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
  model?: string;
  /** Full prompt sent to agent (only for human turns that trigger agent work) */
  prompt?: string;
  /** Who created this turn: human (CLI) or builder (MCP). Only meaningful for role='human' turns. */
  actor?: Actor;
  /** File permission violations detected in this turn */
  violations?: FileViolation[];
  /** Exit code of the post-turn check command (undefined if no check configured) */
  check_exit_code?: number;
  /** Captured output from the post-turn check command */
  check_output?: string;
  /** Whether this turn was auto-triggered (CI failure, comment, upstream sync, crash) vs human-triggered */
  auto_triggered?: boolean;
  /**
   * Category of work this turn represents. Default (missing) is 'work' —
   * a substantive agent turn that advances the task's narrative. 'ask' is
   * a read-only Q&A exchange (e.g. from `lazy review -i`) that doesn't
   * advance the task and should be skipped by "latest summary" lookups.
   *
   * New values can be added without a migration: storage treats missing as
   * 'work', and unknown values fall through to work-like defaults.
   */
  turn_type?: TurnType;
}

/**
 * Category of a turn. Extend with new variants (e.g. 'comment', 'hook') as
 * new turn flavors appear — storage and UI code should branch on this
 * rather than adding more boolean flags.
 */
export type TurnType = 'work' | 'ask' | 'nudge' | 'sync';

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

/** Where a comment originated. Used to prevent echo (re-exporting imported comments). */
export type CommentSource = 'local' | 'remote';

export interface Comment {
  id: string;
  task_id: string;
  content: string;
  created_at: number;
  /** Who left this comment: human (CLI) or builder (MCP). */
  actor?: Actor;
  /** Where this comment originated: 'local' (created in lazy) or 'remote' (synced from PR/MR). */
  source?: CommentSource;
}

/** @deprecated Use Comment instead */
export type Note = Comment;

/**
 * A task journal entry — an append-only, free-form note about *managing* a task
 * rather than *doing* it: orchestration metadata ("blocked on X landing"),
 * decision rationale ("chose K=3 because…"), or an agent memory ("stubbed Z,
 * revisit next run").
 *
 * INVARIANT: a journal entry is **prompt-immune** — it must NEVER be injected
 * into the agent/LLM prompt. This is why the journal is a separate entity from
 * {@link Comment} (which DOES enter the prompt as guidance) rather than a flag
 * on it: with no shared code path, there is structurally no way for a journal
 * entry to leak into a prompt. Do not add one.
 *
 * Entries are created and read, never edited or deleted through normal flows.
 */
export interface JournalEntry {
  id: string;
  task_id: string;
  content: string;
  created_at: number;
  /** Who wrote this entry: human (CLI), builder/agent (MCP), or system. */
  actor?: Actor;
}

/**
 * A passive, task-level follow-up note recording genuinely ORTHOGONAL work an
 * agent discovered while working a task — a different concern the task did not
 * need in order to be correct and mergeable.
 *
 * INVARIANT: Follow-ups are task-level (they survive auto-turns/auto-resumes,
 * unlike turn-level proposals) AND non-triggering (recording one fires NO
 * auto-turn, auto-resume, or auto-react). That non-triggering property is what
 * distinguishes them from comments: comments feed the comment auto-react loop,
 * which would spuriously kick the agent into a new turn. Follow-ups are read
 * and triaged by the human/builder at review time — never acted on
 * automatically. See CLAUDE.md (passive notes; never lose human feedback).
 */
export interface FollowUp {
  id: string;
  task_id: string;
  content: string;
  created_at: number;
  /**
   * The session (agent run) that surfaced this follow-up, if known. Records
   * which run discovered it; null when recorded outside a session context.
   */
  session_id?: string | null;
}

/**
 * Persistent record that a reviewer has marked a hunk as reviewed in
 * `lazy review -i`. Keyed by a content hash (see `src/utils/hunk-hash.ts`)
 * so a hunk's approval survives re-parses of the diff and is invalidated
 * the moment the hunk's content changes.
 */
export interface HunkApproval {
  id: string;
  task_id: string;
  hunk_hash: string;
  approved_by?: Actor;
  approved_at: number;
  /**
   * For sub-hunks created via split: the file path of the parent (un-split)
   * hunk as it appears in the freshly-parsed diff. Anchors the approval by
   * location, not by parent hash, so unrelated edits to the surrounding
   * diff don't flip the parent's identity and orphan its children.
   */
  parent_file?: string;
  /** Parent hunk's `lines` field (e.g. "10-20" or "summary"). */
  parent_lines?: string;
  /**
   * Deterministic recipe to replay the splits that produced the approved
   * sub-hunk from its parent. A string of '0'/'1' digits — each digit picks
   * the first or second half from `splitHunk()`. Empty/absent for whole-
   * hunk approvals where the leaf hash alone identifies the target.
   */
  split_path?: string;
}

/**
 * Optional split-lineage metadata persisted alongside an approval. Present
 * only when approving a sub-hunk produced by `splitHunk()`. The `hunk_hash`
 * itself (already on `HunkApproval`) is the content tripwire; the lineage
 * fields here let the next session re-perform the split and locate the same
 * sub-hunk before checking the hash.
 */
export interface HunkApprovalLineage {
  parent_file: string;
  parent_lines: string;
  split_path: string;
}

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
