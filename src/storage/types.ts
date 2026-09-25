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
  ReviewReport,
  Commit,
  Review,
  ReviewVerdict,
  Comment,
  CommentSource,
  CommentCreateOptions,
  CommentUpdate,
  Note,
  JournalEntry,
  ActorIdentityMigrationResult,
  FollowUpMigrationResult,
  FollowUpTriageStatus,
  RaisedItem,
  RaisedItemComment,
  RaisedItemStatus,
  RaisedItemResolveAction,
  RaisedItemInput,
  RaisedItemResolution,
  TurnOwner,
  TurnReport,
  TurnReportSection,
  TurnReportSectionKind,
  TurnReportInput,
  FileDecision,
  FileDecisionScope,
  FileDecisionInput,
  TaskPromptVersion,
  TaskStatus,
  TaskTarget,
  SessionOutcome,
  TurnRole,
  TurnType,
  InFlightTurn,
  InFlightTurnOutcome,
  InFlightTurnOwner,
  FeedbackDelivery,
  TokenUsage,
  Actor,
  ActorInput,
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
  ScratchFile,
  ScratchFileInput,
  ScratchSkipReason,
  SystemMessage,
  SystemMessageInput,
  SystemMessageKind,
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
  ReviewSession,
  ReviewSessionMessage,
  ReviewSessionMessageInput,
  ReviewSessionMessageUpdate,
  ReviewSessionStatus,
  ReviewSessionMessageRole,
  ReviewSessionMessageDelivery,
  ReviewSessionUpdate,
  ReviewDraftState,
  ReviewDraftPatch,
  TaskArtifact,
  TaskArtifactContent,
  TaskArtifactInput,
  TaskArtifactOrigin,
} from '../types';

// Re-export domain types that are used as-is
export type {
  Task,
  Session,
  Turn,
  MergeConflict,
  FileViolation,
  ReviewReport,
  Commit,
  Review,
  ReviewVerdict,
  Comment,
  CommentSource,
  CommentCreateOptions,
  CommentUpdate,
  Note,
  JournalEntry,
  ActorIdentityMigrationResult,
  FollowUpMigrationResult,
  FollowUpTriageStatus,
  RaisedItem,
  RaisedItemComment,
  RaisedItemStatus,
  RaisedItemResolveAction,
  RaisedItemInput,
  RaisedItemResolution,
  TurnOwner,
  TurnReport,
  TurnReportSection,
  TurnReportSectionKind,
  TurnReportInput,
  FileDecision,
  FileDecisionScope,
  FileDecisionInput,
  TaskPromptVersion,
  TaskStatus,
  TaskTarget,
  SessionOutcome,
  TurnRole,
  TurnType,
  InFlightTurn,
  InFlightTurnOutcome,
  InFlightTurnOwner,
  FeedbackDelivery,
  TokenUsage,
  Actor,
  ActorInput,
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
  ScratchFile,
  ScratchFileInput,
  ScratchSkipReason,
  SystemMessage,
  SystemMessageInput,
  SystemMessageKind,
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
  ReviewSession,
  ReviewSessionMessage,
  ReviewSessionMessageInput,
  ReviewSessionMessageUpdate,
  ReviewSessionStatus,
  ReviewSessionMessageRole,
  ReviewSessionMessageDelivery,
  ReviewSessionUpdate,
  ReviewDraftState,
  ReviewDraftPatch,
  TaskArtifact,
  TaskArtifactContent,
  TaskArtifactInput,
  TaskArtifactOrigin,
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
  /** WHICH person triggered it, when the daemon knew. See ActorRef in src/types. */
  actor_email?: string;
  /** Their display name at the time, when the write carried one. */
  actor_name?: string;
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
  interruptedOnly?: boolean;
  pairingOnly?: boolean;
  mergingOnly?: boolean;
  /** Tasks currently in `submitted` (PR/MR open on the forge). */
  submittedOnly?: boolean;
  withSessionsOnly?: boolean;
  nonTerminalOnly?: boolean;
}

/**
 * One task's identity, as returned by `Storage.listTaskCodes()`: the id and the
 * human-facing code, and deliberately nothing else. A caller that needs a task's
 * goal or status is asking a different question and wants `listTasks()`.
 */
export interface TaskCodeEntry {
  id: string;
  code: string | null;
}

/** Options for the cross-task raised-item listing — see src/raised/index.ts. */
export type {
  ListRaisedItemsOptions,
  ListRaisedItemsResult,
  ListedRaisedItem,
  RaisedItemListSort,
  RaisedItemStateFilter,
  RaisedItemBlockingFilter,
  RaisedItemTaskStatusFilter,
} from '../raised';

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
 * journal entries are a distinct entity from comments: comment text is pushed
 * into the agent's prompt, journal text never is (at most a count of new
 * entries is).
 */
export interface JournalFile {
  journal: JournalEntry[];
}

/**
 * Internal format for raised-items.json — everything an agent surfaces for
 * human eyes, blocking (gates accept) and non-blocking alike.
 */
export interface RaisedItemsFile {
  raised_items: RaisedItem[];
}

/**
 * Internal format for turn-reports.json (structured end-of-turn reports).
 * Latest-wins per session_id.
 */
export interface TurnReportsFile {
  turn_reports: TurnReport[];
}

/**
 * Internal format for file-decisions.json (protected/maintain keep justifications).
 */
export interface FileDecisionsFile {
  file_decisions: FileDecision[];
}

/**
 * Internal format for artifacts.json — the per-task artifact INDEX.
 *
 * Only metadata lives here. The bytes live one-per-file under the task's
 * `artifacts/` directory keyed by artifact id, so a 1 MB PNG never has to be
 * base64'd into a JSON document that every list call parses.
 */
export interface ArtifactsFile {
  artifacts: TaskArtifact[];
}

/**
 * Internal format for regions.json — the computed region cover.
 *
 * Replaced wholesale by every refresh. The human overlay is deliberately a
 * SEPARATE file (region-overlays.json) so a refresh cannot take a reviewer's
 * name or sign-off with it.
 */
export interface RegionCoverFile {
  cover: import('../regions').RegionCover;
}

/** Internal format for region-overlays.json — the human layer, keyed by unit id. */
export interface RegionOverlaysFile {
  overlays: import('../regions').RegionOverlay[];
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
 * Internal format for review-drafts.json — the reviewer's in-progress review
 * state for this task, keyed by reviewer (see ReviewDraftState.reviewer). One
 * file per task rather than one per reviewer: a review in progress is small,
 * and a single file keeps the write atomic like every other per-task record.
 */
export interface ReviewDraftsFile {
  review_drafts: ReviewDraftState[];
}

/**
 * Internal format for review-session.json — the task-scoped builder review
 * conversation (one session per task in v1).
 */
export interface ReviewSessionFile {
  review_session: ReviewSession;
}

/**
 * Internal format for memories.json — the current set of memory records,
 * keyed by name (tombstoned records stay in the array; see MemoryRecord).
 */
export interface MemoriesFile {
  memories: MemoryRecord[];
}

/**
 * Internal format for scratch.json — the project's builder scratch sandbox as
 * captured from the live `$LAZY_SCRATCH_DIR`, keyed by relative path.
 */
export interface ScratchFilesFile {
  scratch_files: ScratchFile[];
}

/**
 * Internal format for memory-history.json — the append-only, actor-attributed
 * write history. Never rewritten.
 */
export interface MemoryHistoryFile {
  events: MemoryEvent[];
}

/**
 * Internal format for system-messages.json — the project's inbox of proactive
 * system-to-human reports. Append-only: messages are never removed, dismissal
 * is a state change on the message.
 */
export interface SystemMessagesFile {
  system_messages: SystemMessage[];
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
  entity_type: 'task' | 'prompt' | 'turn' | 'commit' | 'comment' | 'followup' | 'raised' | 'conversation' | 'memory' | 'scratch';
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
  /**
   * When the entity last changed, epoch ms — the recency signal ranking sorts
   * by (newest first) within a type tier and match strength. Tasks and
   * prompts carry the task's own "last change" the way the `updated:` filter
   * reads it (completed_at ?? created_at); turns and commits their timestamp;
   * comments and raised items their created_at; conversations, memories and
   * scratch files their own last-write time.
   *
   * Absent when the record has no parseable timestamp, in which case the row
   * ranks by the stable order instead of a fabricated time.
   */
  entity_time?: number;
}

// --- Conversation types ---

export interface ConversationStats {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  subagentCount: number;
  totalTokens: number;
}

/**
 * Listing metadata for a stored conversation — everything a list/table needs,
 * and none of the transcript. Derived from the transcript file; never a second
 * source of truth. Listing surfaces (`lazy conversations list`, the web
 * `/conversations` page, `/api/conversations`) read this via
 * `listConversationSummaries()` so they do not parse every full file.
 */
export interface ConversationSummary {
  sessionId: string;
  startedAt: string | null;
  endedAt: string | null;
  importedAt: number;
  summary: string;
  gitBranch: string | null;
  stats: ConversationStats;
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
  /**
   * The primary's usage-limit headers from the response that triggered the
   * failover (its 429/529 is otherwise discarded unrecorded), with the key of
   * the credential it spent. Absent when the primary sent none.
   */
  fromUsageLimitHeaders?: Record<string, string> | null;
  fromCredential?: string | null;
  fromStatus?: number | null;
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
  /**
   * True when this block sits in the request's LAST assistant message — the
   * conversation tail, i.e. the response the agent has just acted on.
   *
   * Every request replays the whole conversation, so a `tool_use` block on the
   * wire is almost always history. The tail is the one place a NEW call can be,
   * which is what lets the durable per-task tool stats
   * (src/proxy/tool-stats.ts) count a call once without remembering every id
   * the conversation ever produced. Optional so records written before this
   * field existed read back cleanly (they read as "not the tail", which folds
   * to no double count).
   */
  tail?: boolean;
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
  /**
   * Tokens in the full result content — what this tool's output added to the
   * conversation, paired with `toolUseId` so it can be attributed to a named
   * tool (src/task/stats.ts).
   *
   * Counted with the project's offline BPE tier, which approximates Claude's
   * tokenizer; it is a context-size measurement, NOT a share of the model bill.
   * Null means not measured — the record predates this field, or the tokenizer
   * had not finished loading. Never 0 as a stand-in, which would read as "this
   * result was free". Optional so older records read back cleanly.
   */
  contentTokens?: number | null;
  /**
   * True when this block sits AFTER the request's last assistant message — the
   * trailing user turn, where the results of the calls just made arrive. See
   * {@link ProxyToolUseAudit.tail}; same reason, other half of the loop.
   */
  tail?: boolean;
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
  /**
   * Role hint from the `x-lazy-role` request header (builder|agent), if set.
   * Cursor traffic carries no such header — its hint comes from the URL prefix
   * the launch pinned (see src/proxy/cursor-route.ts).
   */
  role: string | null;
  /** Task id hint, from the `x-lazy-task-id` header or the cursor URL prefix. */
  taskId: string | null;
  /**
   * The person this request was billed to, when lazy resolved a session
   * placeholder token to its owner (per-user credentials, see
   * src/daemon/session-credentials.ts). Null on every request that carried a
   * real credential — which is every request on a single-user install.
   *
   * Optional so records written before per-user credentials existed still read
   * back cleanly.
   */
  userId?: string | null;
  /**
   * Resolved backend the request was forwarded to
   * (anthropic|ollama|proxy-upstream|cursor|unknown). `cursor` marks a record
   * from the verbatim cursor passthrough route: every Anthropic-wire field
   * below (model, tier, usage, requestShape, tool uses/results, enforcement)
   * is null or empty on purpose, because that wire format is not Anthropic's
   * and the extractor never sees it.
   */
  backend: string;
  /** Upstream base URL the request was forwarded to. */
  upstream: string;

  // --- Request ---
  method: string;
  /** Request path + query (e.g. /v1/messages?beta=true). */
  path: string;
  /**
   * Classified endpoint: messages | count_tokens (Anthropic wire) |
   * chat_completions | responses (OpenAI wire) | cursor | other.
   */
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
   * Allowlisted usage-limit response headers (rate-limit / utilization /
   * retry-after), lower-cased names → values. Null or absent when the response
   * carried none. See src/proxy/usage-limits.ts for the allowlist.
   */
  usageLimitHeaders?: Record<string, string> | null;
  /**
   * The non-secret key of the credential this request spent
   * (`user:<id>`, `credential:<label>`, `upstream:<origin>`). Absent on
   * records written before usage-limit capture existed.
   */
  credential?: string | null;

  /**
   * Policy denials applied to this response by the mechanistic rule engine
   * (§6.3 layer 1). Null when enforcement did not run or nothing was denied;
   * a non-empty array means the response was rewritten to block those calls.
   */
  enforcement?: ProxyEnforcementAudit[] | null;

  /**
   * Why the proxy refused a request carrying a lazy session placeholder token
   * (per-user credentials). Absent/null on every request that was forwarded.
   *
   * Kept separate from `status` on purpose: these 401s are lazy's own, decided
   * before the request ever left the machine, and `status` means "what the
   * UPSTREAM said" — src/proxy/auth-verdict.ts reads a 401 there as "Anthropic
   * rejected lazy's credential", which is a different problem with a different
   * fix.
   */
  authDenial?: 'unknown_session_token' | 'auth_kind_mismatch' | 'session_token_wrong_origin' | null;
}

// --- Durable per-task tool stats ---

/** One tool's running totals for a task. Monotonic: every field only grows. */
export interface ToolStatEntry {
  /** Tool name as the agent called it (Read, Bash, mcp__lazy__lazy_show, …). */
  name: string;
  /** Distinct calls to this tool over the task's whole life. */
  invocations: number;
  /** Results for this tool that came back flagged as errors. */
  errors: number;
  /** Tokens this tool's results added to the conversation, once per call. */
  resultTokens: number;
  /** Results for this tool that carried a token size. */
  resultsMeasured: number;
  /** Results that did not — counted, never assumed to be zero. */
  resultsUnmeasured: number;
  /** First and last time this tool was seen (unix ms). */
  firstSeen: number;
  lastSeen: number;
}

/**
 * A task's per-tool statistics, kept for the task's whole life.
 *
 * WHY THIS IS STORAGE AND THE AUDIT LOG IS NOT. The proxy audit trail is
 * bounded, disposable telemetry — a recent window that rotates away
 * (src/proxy/audit-log.ts), and it stays exactly that. These numbers are the
 * opposite: a small, monotonic per-task summary that must still be readable
 * long after the requests that produced it aged out, which is what makes it a
 * persistent domain object. The proxy folds each forwarded request into it as
 * it goes (src/proxy/tool-stats.ts); nothing recomputes it from the log.
 *
 * The `awaiting` / `recent*` fields are the dedupe bookkeeping that keeps the
 * fold honest across a daemon restart. All three are bounded by construction —
 * see TOOL_STATS_AWAITING_CAP / TOOL_STATS_RECENT_CAP.
 */
export interface TaskToolStatsRecord {
  /** Schema version, so a later shape change can be told apart from this one. */
  version: 1;
  /** Full task id these stats belong to. */
  task_id: string;
  /** When this record was last folded into (unix ms). */
  updated_at: number;
  /** Oldest / newest proxied request folded in (unix ms), or null if none. */
  first_ts: number | null;
  last_ts: number | null;
  /** Proxied requests folded in. */
  requests: number;
  /** Of those, how many carried usage the proxy could read. */
  requests_with_usage: number;
  /** Tokens the proxy observed for this task across those requests. */
  proxy_usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  /** One entry per tool name, unordered — the reader ranks them. */
  tools: ToolStatEntry[];
  /** Results whose `tool_use` was never observed, so the tool is unknown. */
  unattributed_results: number;
  /** Tokens in those results. Real tokens, deliberately in no row. */
  unattributed_result_tokens: number;
  /** Calls counted whose result has not arrived yet: tool_use id → tool name. */
  awaiting: Array<{ id: string; name: string }>;
  /** Ring of recently counted tool_use ids, oldest first. Double-count guard. */
  recent_use_ids: string[];
  /** Ring of recently filed tool_result ids, oldest first. Same guard. */
  recent_result_ids: string[];
}

/**
 * The latest usage-limit reading lazy has seen for ONE credential — the input
 * `[usage_pause]` decides on (src/daemon/usage-pause.ts).
 *
 * WHY THIS IS STORAGE AND THE AUDIT LOG IS NOT. The proxy audit trail is
 * bounded, disposable telemetry and rotates away. A paused credential sends no
 * traffic, so during a long (7-day) pause its last reading is exactly the
 * record that scrolls out — and a daemon restart then found "no reading" and
 * let turns start at 97%. Losing this costs the user money, so it is kept
 * here: one small record per credential, overwritten by the next reading.
 *
 * `headers` is the allowlisted usage-limit header set, never anything else
 * (src/proxy/usage-limits.ts). EMPTY `headers` records only that lazy spent
 * turns on this credential and never got a usable reading back — which is
 * what lets `lazy doctor` still say "armed, NO READING" after a restart.
 */
export interface StoredUsageLimitReading {
  /** The credential KEY (`user:<id>`, `credential:<label>`) — never the secret. */
  credential: string;
  /** When the request that produced this reading was received (unix ms). */
  ts: number;
  upstream: string;
  backend: string;
  status: number | null;
  taskId: string | null;
  model: string | null;
  headers: Record<string, string>;
  /**
   * The last time lazy billed traffic to this credential (unix ms), when that is
   * later than `ts`: a header-less spend AFTER the reading never replaces the
   * reading — it only moves this (src/storage/usage-limit-readings.ts).
   */
  spentAt?: number;
}

/** Options for querying audit records. */
export interface ListAuditRecordsOptions {
  /** Return at most this many records (most recent last). */
  limit?: number;
}

// --- Project settings overlay ---

/**
 * A project's daemon-owned operational settings: the deployment's overrides,
 * layered OVER the repository's `lazy.toml` (docs/design/lazy-teams.md §11).
 *
 * lazy.toml keeps stating the project's *default*; this record states the
 * override a control plane (Rails, MCP, an operator) chose for this deployment.
 * `lazy.toml` is NEVER written from here — that would put a browser checkbox
 * on the default branch of the user's repository, which is the option §11.2
 * evaluated and rejected.
 *
 * It lives in Storage rather than in a file inside the VM because the VM is
 * cattle (design §4): a setting written inside one evaporates on the next
 * rebuild, silently, and the project reverts to its lazy.toml default with
 * nobody told.
 *
 * Every field is optional and OMITTED means "no override — defer to
 * lazy.toml". A field is never written as an empty string to mean "unset";
 * clearing an override deletes the key.
 */
export interface ProjectSettings {
  /**
   * Overrides `[models] default` for task turns. See `resolveProjectModel`
   * (src/daemon/project-settings.ts) for the full precedence chain — this sits
   * BELOW a per-turn override and a task's own pinned model, and ABOVE
   * lazy.toml.
   */
  defaultModel?: string;
  /**
   * Overrides `[agent] agent_id` for newly created tasks. See
   * `resolveProjectAgent` (src/daemon/project-settings.ts) for precedence —
   * this sits below an explicit create-time choice and ABOVE lazy.toml.
   */
  defaultAgent?: string;
  /**
   * The project-wide command the Services card's "Start services" runs in a
   * task's shell (`bin/dev`, `npm run dev`). NOT an override of lazy.toml: the
   * store is its only home, and `[serve] start_services_cmd` in lazy.toml is
   * only a one-time import while this key is absent (src/serve/start-cmd.ts).
   * It rides in this record because this is the project's operational record,
   * but it is not a settings-FORM key: `setProjectSettings` carries it forward
   * rather than clearing it.
   */
  startServicesCmd?: string;
  /**
   * True when somebody CLEARED the Start services command. Distinct from "never
   * set": a cleared project resolves to no command at all — lazy.toml's
   * `[serve] start_services_cmd` is neither read as a fallback nor imported at
   * daemon start, so a clear sticks. Designating a command removes it.
   */
  startServicesCmdCleared?: boolean;
  /** ISO timestamp of the last write. Display only. */
  updatedAt?: string;
  /**
   * Actor role that last wrote these settings (`human`, `system`, …). The wire
   * carries a role, never a person — Rails records WHICH user asked on its own
   * side (see lazy-teams/CLAUDE.md, `TaskAction`).
   */
  updatedBy?: string;
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

/**
 * A daemon-owned builder session: the thing the daemon knows exists, can hand
 * back after a restart, and can point a terminal at.
 *
 * One row per interactive builder the daemon has launched. It is deliberately
 * NOT keyed to a task — a builder session is a person's standing conversation
 * with lazy, not a turn on anything. `builderId` is the same short id used
 * throughout the builder machinery (the `lazy-builder-<builderId>` container
 * name, the `builder-<builderId>` daemon MCP token, the `BuilderResumeIntent`
 * key) — this row and those pieces of state agree on it by construction, never
 * by re-deriving it from a container name string.
 */
export interface BuilderSession {
  /** Stable session id — never changes across a stop/resume cycle. */
  id: string;
  /** Absolute project root this session belongs to. */
  projectRoot: string;
  /**
   * The person this session is attributed to and billed to (§3.3 case 1 —
   * `docs/design/actor-identity-and-remote-clients.md`). Null only for a
   * single-person install with no git identity configured, which a
   * store-writing launch never reaches — kept nullable rather than required so
   * a future non-interactive kind that legitimately has no member can share
   * the type.
   */
  memberEmail: string | null;
  /**
   * What kind of session this is. Only `'interactive'` exists today (`lazy
   * builder`, `lazy pair`, `lazy chat` — see the design's §5.2). Headless
   * `claude -p` runs already exist (`launchBuilderHeadless`) but registering
   * them as a session kind is `web-builder-sessions`' remainder, not this
   * registry's.
   */
  kind: 'interactive';
  /**
   * `starting` — registered, container not confirmed up yet.
   * `running` — container is live and attachable.
   * `stopped` — container is gone (explicit stop, a daemon roll, an upgrade)
   *   but the session is RESUMABLE: `agentSessionId` names the Claude session
   *   to `--resume`.
   * `ended` — the member ended the session explicitly. Terminal; never resumed.
   */
  state: 'starting' | 'running' | 'stopped' | 'ended';
  /** The live container's name (`lazy-builder-<builderId>`), or null when not running. */
  containerName: string | null;
  /**
   * The short builder id the CURRENT (or most recent) container/MCP-token/
   * resume-intent are keyed by. Changes on every (re)launch — a stop+resume
   * always creates a fresh container under a fresh id, exactly like the
   * existing host `lazy builder` relaunch loop — while `id` above is the
   * durable session identity a client holds across that change.
   */
  builderId: string;
  /** Claude session id to `--resume`, once known. Null until the first stop. */
  agentSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  /** When the session was explicitly ended, or null while live/resumable. */
  endedAt: string | null;
}

/** Patch accepted by {@link Storage.updateBuilderSession}. */
export interface BuilderSessionUpdate {
  state?: BuilderSession['state'];
  containerName?: string | null;
  builderId?: string;
  agentSessionId?: string | null;
  endedAt?: string | null;
}
