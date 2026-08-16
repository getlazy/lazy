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
  JournalEntry,
  FollowUp,
  TaskPromptVersion,
  TaskStatus,
  TaskTarget,
  SessionOutcome,
  TurnRole,
  TurnType,
  FeedbackDelivery,
  TokenUsage,
  Actor,
  TagEvent,
  TagAction,
  MemoryRecord,
  MemoryEvent,
  MemoryAction,
  MemoryType,
  MemoryWriteInput,
  MemoryCompact,
  MemoryCompactInput,
  MemoryCompactMethod,
  MemoryCompactCoverage,
  HunkApproval,
  HunkApprovalLineage,
  ReviewComment,
  ReviewCommentInput,
  ReviewCommentUpdate,
  ReviewCommentSide,
  ReviewCommentRole,
  ReviewCommentAskState,
  ReviewCommentIntent,
  ReviewCommentDeliveryState,
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
  JournalEntry,
  FollowUp,
  TaskPromptVersion,
  TaskStatus,
  TaskTarget,
  SessionOutcome,
  TurnRole,
  TurnType,
  FeedbackDelivery,
  TokenUsage,
  Actor,
  TagEvent,
  TagAction,
  MemoryRecord,
  MemoryEvent,
  MemoryAction,
  MemoryType,
  MemoryWriteInput,
  MemoryCompact,
  MemoryCompactInput,
  MemoryCompactMethod,
  MemoryCompactCoverage,
  HunkApproval,
  HunkApprovalLineage,
  ReviewComment,
  ReviewCommentInput,
  ReviewCommentUpdate,
  ReviewCommentSide,
  ReviewCommentRole,
  ReviewCommentAskState,
  ReviewCommentIntent,
  ReviewCommentDeliveryState,
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
 * Internal format for tag-history.json — the append-only audit trail of every
 * tag/untag event on a task. Never rewritten (untag appends, it does not erase).
 */
export interface TagHistoryFile {
  events: TagEvent[];
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
  queuedOnly?: boolean;
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
 * Internal format for journal.json.
 *
 * Deliberately NOT named to collide with the legacy notes.json migration —
 * journal entries are a distinct, prompt-immune entity from comments.
 */
export interface JournalFile {
  journal: JournalEntry[];
}

/**
 * Internal format for follow-ups.json (task-level orthogonal-work discoveries)
 */
export interface FollowUpsFile {
  follow_ups: FollowUp[];
}

/**
 * Internal format for hunk-approvals.json (per-task review approvals)
 */
export interface HunkApprovalsFile {
  approvals: HunkApproval[];
}

/**
 * Internal format for review-comments.json — anchored, threaded diff comments
 * made by a human reviewing a task's diff in the web review surface, plus the
 * agent's replies.
 */
export interface ReviewCommentsFile {
  review_comments: ReviewComment[];
}

/**
 * Internal format for memories.json — the current set of memory records,
 * keyed by name (tombstoned records stay in the array; see MemoryRecord).
 */
export interface MemoriesFile {
  memories: MemoryRecord[];
}

/**
 * Internal format for memory-history.json — the append-only, actor-attributed
 * write history. Never rewritten.
 */
export interface MemoryHistoryFile {
  events: MemoryEvent[];
}

/**
 * Internal format for memory-compact.json — the single DERIVED compact
 * representation of the live records. Overwritten on every recompact; absent
 * when no compact has been generated. Safe to delete by hand: injection falls
 * back to the full index.
 */
export interface MemoryCompactFile {
  compact: MemoryCompact;
}

/**
 * Search result entry
 */
export interface SearchResult {
  entity_type: 'task' | 'prompt' | 'turn' | 'commit' | 'comment' | 'followup' | 'conversation' | 'memory';
  entity_id: string;
  task_id: string;
  task_code: string | null;
  task_goal: string;
  content: string;
  match_context: string;
  /**
   * 0-based position of this entity within its task's own list, in the SAME
   * order `lazy show` and `lazy_show` page over: turns by sequence, commits and
   * comments and follow-ups by time. Pass it straight as `lazy_show`'s `offset`
   * (with `limit: 1` and that one section) to land on exactly this entity.
   *
   * Search excerpts are truncated by design — search locates, `show` reads — so
   * without this a hit meant paging through the section by hand.
   *
   * Absent for hits that have no position in a per-task list (task, prompt,
   * conversation, memory).
   */
  entity_index?: number;
  /**
   * The turn's own sequence number, as `lazy show` prints it (`Turn #12`) and
   * `lazy_show` reports it. Turn hits only.
   *
   * Deliberately separate from `entity_index`: sequence is the turn's identity
   * in rendered output, index is its offset for pagination. They coincide only
   * when a session's sequences happen to start at 0 and skip nothing.
   */
  turn_sequence?: number;
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

// --- Agent session log (raw Claude Code JSONL) ---

/**
 * The raw, byte-for-byte Claude Code session JSONL captured for a task before
 * its worktree is cleaned up. Unlike StoredConversation (a parsed, searchable
 * representation), this preserves the exact transcript so the session can be
 * rehydrated and resumed via `claude --resume <sessionId>`.
 */
export interface AgentSessionLog {
  /** Lazy task ID this session belongs to */
  taskId: string;
  /** Claude Code session UUID (the JSONL filename minus `.jsonl`) */
  sessionId: string;
  /** When the log was captured (unix ms) */
  capturedAt: number;
  /** Raw JSONL content, byte-for-byte */
  content: string;
}

// --- Proxy audit (Tier-1 passive audit plane) ---
//
// Records produced by the Anthropic-native passthrough proxy
// (`lazy proxy`, src/proxy/). One record per forwarded request. This is a real
// queryable interface — the metrics foundation a later model-economics / routing
// layer reads — NOT a debug log. See docs/spikes/model-passthrough.md §6.1.

/** Token usage extracted from an Anthropic `/v1/messages` response. */
export interface ProxyTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

/**
 * Smart-routing failover metadata — set only when the proxy rerouted a request
 * away from its primary upstream because the primary returned 429/529 or was
 * unreachable. Null on every request that ran on the primary as usual. This is
 * the durable record of which turns silently... no — *explicitly, by config* —
 * ran on a fallback target, so a human can always see it after the fact.
 */
export interface ProxyReroute {
  /** Primary upstream the request was originally sent to. */
  fromUpstream: string;
  /** Wire model originally requested (from the request body), if any. */
  fromModel: string | null;
  /** Upstream the request was ultimately forwarded to (the final target tried). */
  toUpstream: string;
  /** Model actually used on the final target — the fallback's model override, or `fromModel` if it did not override. */
  toModel: string | null;
  /** What triggered the first failover: an HTTP status ("429"/"529") or "unreachable". */
  trigger: string;
  /** Total targets attempted, primary included (2 = primary failed, one fallback used). */
  attempts: number;
}

/**
 * Coarse shape of a `/v1/messages` request — enough for request-level routing
 * decisions and audit triage without storing the full body.
 */
export interface ProxyRequestShape {
  hasSystem: boolean;
  systemLen: number;
  numMessages: number;
  messageRoles: string[];
  numTools: number;
  /** Tool names declared on the request (capped). */
  toolNames: string[];
  maxTokens: number | null;
  bodyBytes: number;
}

/**
 * A `tool_use` block carried in a request — the agent's *intended* action,
 * observed before Claude Code executes it. Security-relevant fields are pulled
 * out by tool kind; `inputPreview` is a bounded JSON snippet of the full input.
 */
export interface ProxyToolUseAudit {
  /** tool_use id, if present. */
  id: string | null;
  /** Tool name (e.g. Read, Write, Edit, Bash, WebFetch, mcp__claude_ai_*). */
  name: string;
  /** Read/Write/Edit file path, if extractable. */
  path: string | null;
  /** Bash command string, if this is a Bash call. */
  command: string | null;
  /** Network target (WebFetch/WebSearch url or query), if extractable. */
  target: string | null;
  /** True when this is an inherited claude.ai connector (`mcp__claude_ai_*`). */
  connector: boolean;
  /** Bounded JSON preview of the tool input. */
  inputPreview: string;
}

/**
 * A `tool_result` block carried in a request — the *result* of a prior action,
 * observed on the wire (the spike proved unguessable file contents cross here).
 */
export interface ProxyToolResultAudit {
  toolUseId: string | null;
  isError: boolean;
  /** Bounded preview of the result content. */
  contentPreview: string;
  /** Full content length before truncation. */
  contentLen: number;
}

/**
 * A policy denial the proxy applied to a response (§6.3 layer 1). Records which
 * `tool_use` was blocked, which mechanistic rule fired, and why — the security
 * audit trail for active enforcement.
 */
export interface ProxyEnforcementAudit {
  /** id of the denied tool_use block, if present. */
  toolUseId: string | null;
  /** Denied tool name (e.g. mcp__claude_ai_gmail_search). */
  name: string;
  /** Rule that fired (connector-deny-default | secret-path-read | path-glob-deny | egress-allowlist). */
  rule: string;
  /** Human-readable reason surfaced to the agent and the audit log. */
  reason: string;
}

/**
 * One audited request through the passthrough proxy. Captures resolved
 * model + backend, role, token usage, request shape, and extracted
 * tool_use/tool_result contents.
 */
export interface ProxyAuditRecord {
  /** Stable unique id for this record. */
  id: string;
  /** Per-process monotonic sequence (debugging / ordering within one proxy run). */
  seq: number;
  /** When the request was received (unix ms). */
  ts: number;

  // --- Routing / identity ---
  /** Role hint from the `x-lazy-role` request header (builder|agent), if set. */
  role: string | null;
  /** Task id hint from the `x-lazy-task-id` request header, if set. */
  taskId: string | null;
  /** Resolved backend the request was forwarded to (anthropic|ollama|proxy-upstream|unknown). */
  backend: string;
  /** Upstream base URL the request was forwarded to. */
  upstream: string;

  // --- Request ---
  method: string;
  /** Request path + query (e.g. /v1/messages?beta=true). */
  path: string;
  /** Classified endpoint: messages | count_tokens | other. */
  endpoint: string;
  /** Wire model from the request body, if any. */
  model: string | null;
  /** Coarse tier guess from the model name (opus|sonnet|haiku|other|none). */
  tier: string | null;
  /** Whether the request asked for a streaming response. */
  stream: boolean | null;
  /** Request shape (only for messages-family endpoints; null otherwise). */
  requestShape: ProxyRequestShape | null;
  /** Extracted tool_use blocks (intended actions). */
  toolUses: ProxyToolUseAudit[];
  /** Extracted tool_result blocks (action results). */
  toolResults: ProxyToolResultAudit[];

  // --- Response ---
  /** Upstream HTTP status, or null if the forward failed before a response. */
  status: number | null;
  /** Token usage extracted from the response (messages endpoint). */
  usage: ProxyTokenUsage | null;
  /** Stop reason from the response, if observed. */
  stopReason: string | null;
  /** Upstream/proxy error message if the forward failed. */
  error: string | null;
  /** Total proxy-side handling duration in ms. */
  durationMs: number | null;
  /**
   * Smart-routing failover metadata. Null when the request ran on the primary
   * upstream (the common case). Set when the proxy rerouted to a configured
   * fallback target after a 429/529/unreachable primary.
   */
  reroute: ProxyReroute | null;

  /**
   * Policy denials applied to this response by the mechanistic rule engine
   * (§6.3 layer 1). Null when enforcement did not run or nothing was denied;
   * a non-empty array means the response was rewritten to block those calls.
   */
  enforcement?: ProxyEnforcementAudit[] | null;
}

/** Options for querying audit records. */
export interface ListAuditRecordsOptions {
  /** Return at most this many records (most recent last). */
  limit?: number;
}

// --- Builder resume intent (durable upgrade↔builder handshake) ---

/**
 * The durable cross-gap handshake that lets a relaunched `lazy builder` know it
 * was stopped by an upgrade and should resume the same Claude session in the
 * same terminal.
 *
 * `lazy upgrade` writes one intent per builder it is about to stop; the host
 * builder wrapper consumes+clears it (see `takeBuilderResumeIntent`) after a
 * successful relaunch. It MUST be durable because the consumer (the builder
 * container) is dead and the daemon restarts during the gap the intent has to
 * survive — the transient event plane cannot carry it (see
 * docs/spikes/builder-upgrade-resume.md §3).
 */
export interface BuilderResumeIntent {
  /** Stable per-builder identifier (the `lazy-builder-<builderId>` run name). */
  builderId: string;
  /** Absolute project root the builder belongs to. Scopes intents per project. */
  projectRoot: string;
  /** Claude session UUID to resume, if known when the intent was written. */
  sessionId?: string;
  /** When the intent was created (ISO timestamp). */
  createdAt: string;
  /**
   * PID of the `lazy upgrade` process that wrote this intent, and the host it
   * ran on. The builder wrapper waits INDEFINITELY for the upgrade to finish
   * (a rebuild has no honest upper bound), so it needs a real signal — not a
   * timer — to distinguish "still building" from "the upgrade died". These two
   * fields are that signal: when the pid is gone and the daemon never came back
   * with the new version, the upgrade failed and the wrapper says so.
   *
   * `upgradeHost` guards the pid check: with a shared/remote store the intent
   * may be read on a different machine, where the pid means nothing. Both are
   * optional — an intent without them simply waits (the safe default).
   */
  upgradePid?: number;
  /** Hostname of the machine `upgradePid` is valid on. */
  upgradeHost?: string;
  /**
   * WHY the builder was stopped, which decides what the wrapper does next:
   *
   *  - `'upgrade'` (default when absent) — `lazy upgrade` wrote this BEFORE
   *    rebuilding, so the wrapper must WAIT for the daemon to come back with
   *    the new version before relaunching.
   *  - `'daemon-restart'` — the daemon that just started wrote this while
   *    reaping the previous generation's children. There is nothing to wait
   *    for: the new daemon is, by construction, already serving. Waiting would
   *    hang forever, because the restart the wait watches for has already
   *    happened by the time the builder sees the intent.
   */
  reason?: 'upgrade' | 'daemon-restart';
}
