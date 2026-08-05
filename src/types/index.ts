import type { RunnerType } from '../config/types';

export type TaskStatus = 'working' | 'blocked' | 'pairing' | 'interrupted' | 'submitted' | 'merging' | 'conflict' | 'zombie' | 'complete' | 'abandoned' | 'backlog' | 'queued';

// Status classification functions live in src/task-state-machine.ts (single source of truth).
// Re-exported here for backward compatibility — consumers can import from either location.
export { TERMINAL_STATUSES, isTerminalStatus, isActiveStatus, isBlockedStatus } from '../task-state-machine';

export type TaskType = 'task' | 'fix' | 'spike' | 'refactor' | 'test' | 'audit' | 'migrate' | 'document' | 'tidy' | 'rework' | 'feature' | 'release';

export const DEFAULT_TASK_TYPE: TaskType = 'task';

export const VALID_TASK_TYPES: readonly TaskType[] = ['task', 'fix', 'spike', 'refactor', 'test', 'audit', 'migrate', 'document', 'tidy', 'rework', 'feature', 'release'] as const;

/**
 * Task priority — orders the concurrency queue when a slot frees (higher first;
 * ties break FIFO by created_at). Deliberately minimal (operational backpressure,
 * not a scheduler). `PRIORITY_RANK` gives the numeric ordering used by the pure
 * queue-ordering function in src/daemon/concurrency.ts.
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export const DEFAULT_TASK_PRIORITY: TaskPriority = 'normal';

export const VALID_TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent'] as const;

/** Higher number = drained first. */
export const PRIORITY_RANK: Record<TaskPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

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

/**
 * Who performed an action: human (CLI), builder (MCP, project-wide), agent (MCP,
 * scoped to its own task — e.g. a task agent accepting one of its own subtasks),
 * or system (reconciler/auto-resume) / supervisor (turn machinery).
 *
 * `builder` and `agent` are the same CHANNEL (MCP) told apart by scope: the
 * builder drives the project with no task of its own, an agent acts from inside
 * one. See MCP_ACTOR / mcpActor in src/constants.ts and src/mcp/tools.ts.
 */
export type Actor = 'human' | 'builder' | 'agent' | 'system' | 'supervisor';


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
  /** Queue priority — orders queued tasks for the drain sweep. Defaults to 'normal'. */
  priority: TaskPriority;
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
  /**
   * Per-task runner override. null = inherit the global `[runner] type` from
   * lazy.toml. When set, this task runs on the chosen runner (host vs
   * docker/podman) regardless of the global default. Mirrors {@link Task.model}.
   * Resolved at every launch as `task.runner_type ?? config.runner.type` and
   * stamped onto the {@link Session.runner_type} that actually ran.
   */
  runner_type: RunnerType | null;
  metadata: Record<string, string> | null;
  /**
   * Current tags on this task (normalized: lowercase, alphanumeric + hyphens).
   * Lightweight, non-hierarchical grouping — a task can carry multiple tags and
   * belong to multiple efforts at once. This is the current-state view; the
   * append-only audit trail of every tag/untag lives separately (see
   * {@link TagEvent} / getTagHistory), never rewritten. Empty array (never null)
   * for tasks without tags; normalized to [] on read for backward compatibility.
   */
  tags: string[];
  /**
   * Upstream sync counter. 0 = up to date, >0 = needs sync.
   * Incremented when a sync signal arrives (parent changed, explicit request).
   * Reset to 0 when sync launches. If new signals arrive during merge, the
   * counter goes >0 again, signaling that another sync is needed after completion.
   */
  pending_sync: number;
}

/** Whether a tag-history event added or removed a tag. */
export type TagAction = 'tag' | 'untag';

/**
 * A single append-only tag-history event. Records that a tag was added or
 * removed, when, and by whom (using the actor taxonomy — human via CLI,
 * builder via MCP). The history is never rewritten: untagging appends an
 * 'untag' event, it does not erase the earlier 'tag' event.
 */
export interface TagEvent {
  tag: string;
  action: TagAction;
  timestamp: number;
  /** Who performed the tag/untag: human (CLI) or builder (MCP). */
  actor?: Actor;
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
  /**
   * The runner that actually launched this session, stamped at launch time
   * (`task.runner_type ?? config.runner.type`). This is the source of truth
   * for monitoring (reconcile/stop/close/shutdown): docker vs host discover
   * runs differently (container names vs PID files), so monitoring must use the
   * runner the session ran on, not the current global config. null for legacy
   * sessions or no-override sessions → callers fall back to global config.
   */
  runner_type: RunnerType | null;
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
  /**
   * Delivery state of the human/builder feedback this turn carries.
   *
   * INVARIANT (CLAUDE.md — never lose human feedback): a turn whose feedback was
   * persisted but never acted on must be re-delivered verbatim when the task
   * resumes. This marker is the ONLY reliable record of that — "is there an
   * agent turn after it?" is not a valid proxy, because a crash records an agent
   * *error* turn that never consumed anything.
   *
   * - absent  — this turn carries no redeliverable feedback (system resume
   *             notices, supervisor sync/nudge turns, stop reasons).
   * - pending — feedback is persisted but no agent response has consumed it.
   * - consumed — an agent response completed after this feedback was delivered.
   */
  feedback_delivery?: FeedbackDelivery;
}

/**
 * Delivery state of feedback carried by a turn. See `Turn.feedback_delivery`.
 */
export type FeedbackDelivery = 'pending' | 'consumed';

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
 * The classification of a shared-memory record. Mirrors the categories the
 * Claude Code harness memory feature uses, so imported harness memories keep
 * their meaning:
 *   - user      — who the human is (role, expertise, preferences)
 *   - feedback  — guidance the human has given on how to work
 *   - project   — ongoing work, goals, constraints not derivable from the code
 *   - reference — pointers to external resources (URLs, dashboards, tickets)
 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export const VALID_MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/**
 * One lazy-owned shared-memory record: a small, named piece of cross-task
 * curated knowledge, stored in lazy's own storage (NOT in the Claude Code
 * harness memory directory, which lives inside a per-builder overlay, is never
 * shared between builders, and is garbage-collected with that overlay).
 *
 * Distinct from the task journal: the journal is a raw, per-task, prompt-immune
 * record of what happened on one task; memory is curated, cross-task knowledge
 * that IS injected (as a compact index) into builder and agent launches.
 *
 * INVARIANT (security boundary): task agents are READ-ONLY on memory. Records
 * are injected into every future builder and agent prompt, so an agent-writable
 * store would be a prompt-injection channel into every future session. The gate
 * is enforced server-side in the MCP layer (see `lazy_memory_save`), not by
 * prompt guidance.
 */
export interface MemoryRecord {
  /** Kebab-case slug — the record's stable identity. Unique per project. */
  name: string;
  /** One-line summary. This is what the auto-injected index renders. */
  description: string;
  type: MemoryType;
  /** Full body (markdown). */
  body: string;
  created_at: number;
  updated_at: number;
  /** Actor that first created this record. */
  created_by: Actor;
  /** Actor of the most recent write. */
  updated_by: Actor;
  /** Write count: 1 on create, incremented on every update. */
  revision: number;
  /**
   * Tombstone. Set by `lazy memory rm`; the record stops being listed, recalled
   * and injected, but its write history is preserved (history is never
   * rewritten). A later save under the same name revives it as a new revision.
   */
  deleted_at?: number;
  deleted_by?: Actor;
}

export type MemoryAction = 'create' | 'update' | 'delete';

/**
 * One entry in the append-only, actor-attributed memory write history —
 * the same shape of audit trail as tag history: who wrote or removed what,
 * when. History is NEVER rewritten: an update appends, a delete appends, and
 * neither erases the earlier events.
 */
export interface MemoryEvent {
  id: string;
  /** Record name this event applies to. */
  name: string;
  action: MemoryAction;
  actor: Actor;
  timestamp: number;
  /** Revision the record carried after this write. */
  revision: number;
  /** Content as written. Absent for 'delete' events (nothing was written). */
  description?: string;
  type?: MemoryType;
  body?: string;
}

/** The caller-supplied fields of a memory write. */
export interface MemoryWriteInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/**
 * How a memory compact's text was produced.
 *   - 'llm'        — summarized by a model (`lazy memory compact`)
 *   - 'mechanical' — grouped and tightened by code, no model involved. Also the
 *                    graceful-degradation result when no model is reachable.
 */
export type MemoryCompactMethod = 'llm' | 'mechanical';

/**
 * One record a compact covered, at the revision it covered. This is the
 * watermark that makes "new since the compact" well-defined: a live record
 * whose name is absent here, or present at a DIFFERENT revision, is newer than
 * the compact and is injected as its own live index line, superseding whatever
 * the compact says about it.
 *
 * Revisions rather than timestamps: revisions are monotonic per record and
 * immune to clock skew, and a delete→revive cycle bumps the revision too.
 */
export interface MemoryCompactCoverage {
  name: string;
  revision: number;
}

/**
 * A DERIVED, compact representation of the project's live memory records, used
 * in place of the full one-line-per-record index when assembling the injected
 * memory context.
 *
 * INVARIANT: a compact is derived state, never a source of truth. The records
 * are NEVER modified by compaction (no description rewrites, no truncation),
 * and a recompact is always generated from the live records — never from a
 * previous compact — so repeated compaction cannot compound lossy compression.
 * Deleting the compact is always safe: injection falls back to the full index.
 *
 * INVARIANT: every covered record's NAME must survive into `content`. Names are
 * how bodies are recalled on demand (`lazy_memory_recall <name>`), so a compact
 * that summarized a record without naming it would orphan it. The generator
 * enforces this (see src/memory/compact.ts).
 */
export interface MemoryCompact {
  /** The compact text (markdown) that gets injected. */
  content: string;
  generated_at: number;
  generated_by: Actor;
  method: MemoryCompactMethod;
  /** Model that produced the text. Absent for mechanical compaction. */
  model?: string;
  /** The watermark: which records, at which revisions, this compact covered. */
  covered: MemoryCompactCoverage[];
}

/** The caller-supplied fields of a compact write. */
export interface MemoryCompactInput {
  content: string;
  method: MemoryCompactMethod;
  model?: string;
  covered: MemoryCompactCoverage[];
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
