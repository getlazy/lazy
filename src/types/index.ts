import type { RunnerType } from '../config/types';
import type { ReviewReport } from './review-report';

export type TaskStatus = 'working' | 'blocked' | 'pairing' | 'interrupted' | 'submitted' | 'merging' | 'conflict' | 'zombie' | 'complete' | 'abandoned' | 'backlog';

// Status classification functions live in src/task-state-machine.ts (single source of truth).
// Re-exported here for backward compatibility — consumers can import from either location.
export { TERMINAL_STATUSES, isTerminalStatus, isActiveStatus, isBlockedStatus } from '../task-state-machine';

// The structured remedy carried by a refused accept — shared by the daemon
// (which composes it) and the review UI (which renders it).
export { parseAcceptRemedy, acceptRemedyOf } from './accept-remedy';
export type { AcceptRemedy, AcceptRefusalReason, AcceptRemedyUiAction } from './accept-remedy';

export type TaskType = 'task' | 'fix' | 'spike' | 'refactor' | 'test' | 'audit' | 'migrate' | 'document' | 'tidy' | 'rework' | 'feature' | 'release' | 'cluster';

export const DEFAULT_TASK_TYPE: TaskType = 'task';

export const VALID_TASK_TYPES: readonly TaskType[] = ['task', 'fix', 'spike', 'refactor', 'test', 'audit', 'migrate', 'document', 'tidy', 'rework', 'feature', 'release', 'cluster'] as const;

/**
 * The type's name before 2026-09-20, still on disk in every task created under
 * it until something writes that task. `FileStorage.readTask` maps it to
 * `cluster` on the way in, which is why nothing downstream of storage ever
 * compares against it; the first mutator then persists the new name, because
 * every mutator re-serialises what `readTask` returned. See
 * src/storage/file-storage.ts.
 */
export const LEGACY_CLUSTER_TASK_TYPE = 'loop';

/**
 * The refusal for an unrecognised `--type`, spelled ONCE for all five surfaces
 * that validate one: `lazy create`, `lazy edit`, their daemon handlers, and the
 * MCP create handler.
 *
 * It exists because of the retired name. Every other surface of the
 * `loop` → `cluster` rename tells the reader what happened — `/loops`
 * redirects, `[loop]` and `[agent.by_type] loop` are honoured with a named
 * remedy, a stored `type: "loop"` is aliased — while this one printed
 * `Invalid type 'loop'` and a bare list of thirteen names. `cluster` is in that
 * list, so it was recoverable, but only by inference, and the old spelling is
 * the one most people have in their fingers. Naming the rename costs a clause.
 */
export function invalidTaskTypeMessage(value: string): string {
  const renamed = value === LEGACY_CLUSTER_TASK_TYPE
    ? ` The \`${LEGACY_CLUSTER_TASK_TYPE}\` task type was renamed \`cluster\` — use that.`
    : '';
  return `Invalid type '${value}'.${renamed} Must be one of: ${VALID_TASK_TYPES.join(', ')}`;
}

/**
 * A `cluster` task drives its own subtasks — brief them, schedule them, review
 * what comes back, accept or send back — rather than doing the work itself.
 * Its agent (the DRIVER) decides how many children run at once and which, by
 * its own reading of file overlap, dependency and the operator's brief.
 *
 * One rule in the daemon keys off this type: a quiescent cluster is restarted
 * when a child is added to it (see src/daemon/cluster-restart.ts) — the one
 * deliberate exception to "a lazy comment never starts a turn".
 *
 * There is deliberately NO concurrency rule. The type was called `loop` and the
 * daemon refused to start a second child while one ran; ten days of running
 * them showed the serialisation cost far more than the sibling merges it
 * avoided, so the refusal was removed (engineer, 2026-09-20). Agent tasks are
 * uncapped by design, and nothing here reintroduces a cap or a queue.
 *
 * The behavioural contract the agent follows is
 * src/prompts/cluster-constraints.md.
 */
export function isClusterTask(task: Pick<Task, 'type'>): boolean {
  return task.type === 'cluster';
}

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

/**
 * An actor plus WHICH person it was, when that is known.
 *
 * {@link Actor} answers "what KIND of actor" (which channel); it cannot answer
 * "which human". On a multi-user front end (lazy-teams) every web-initiated RPC
 * carries a user-kind actor token, so the daemon DOES know the person — and
 * that has to be persisted, not just audited outside the store, or a store
 * export cannot answer who did what.
 *
 * The person is named as GIT names people — an `(email, name)` pair — so an
 * exported store names somebody you can reach rather than an id that meant
 * something only inside the control plane that minted it. There is no users
 * table to resolve against: the name travels on the row, as the name at the
 * time of the act, exactly as a git commit carries it.
 *
 * Both halves are optional forever: system, builder, supervisor and plain-CLI
 * actors may have no person behind them, and rows written before this existed
 * have none either.
 *
 * The daemon is the ONLY writer of the person — it comes from the caller's
 * token or from the daemon's own resolved git identity (see applyCallerActor in
 * src/daemon/rpc-handlers.ts), never from a request field a client could set.
 */
export interface ActorRef {
  role: Actor;
  /** Which PERSON, as git names them. Stable across installs. */
  email?: string;
  /** Their display name at the time of the act — git's `user.name`. */
  name?: string;
}

/**
 * What an actor-attributed write accepts: a bare role (every pre-existing call
 * site, and every single-user path) or a role+person pair.
 */
export type ActorInput = Actor | ActorRef;

/**
 * The person a turn belongs to — whoever asked for it.
 *
 * Same `(email, name)` pair every attributed row carries, named separately
 * because it is a fact about the TURN rather than about one write: every row
 * the agent produces during that turn takes its person from here. See
 * src/daemon/turn-owner.ts.
 */
export interface TurnOwner {
  email: string;
  name?: string;
}

/**
 * The person a row written during a turn names, and whether ANYBODY asked for
 * that turn.
 *
 * The two are separate questions with the same answer shape, and a row needs
 * both: when nobody asked, the person is the account that configured the
 * automation (src/identity/system-identity.ts) and the row's role is `system`
 * rather than the channel it came through — which on a single-person install is
 * the only thing distinguishing "they typed it" from "their daemon did it",
 * since both name the same human.
 */
export interface TurnAttribution extends TurnOwner {
  system: boolean;
}


export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Token usage as the AGENT reports it (snake_case), before it is normalized to
 * the camelCase `TokenUsage` we store. This is the shape that travels on the
 * supervisor wire and comes back out of `Agent.parseResponse()`.
 *
 * Kept as one named type rather than re-inlined per call site so that every
 * place which carries a dying turn's tokens — AgentResponse, CompletedResponse,
 * ErrorResponse, the supervisor's error classes — is provably the same shape.
 */
export interface AgentTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
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
  /**
   * The turn currently in flight for this task, when one was started by a
   * caller that will read the answer ITSELF rather than leaving it to the
   * reconciler — see {@link InFlightTurn}. null when no such turn is running.
   */
  in_flight_turn?: InFlightTurn | null;
}

/**
 * Who started an in-flight turn — the turns the DAEMON runs outside the
 * ordinary "park the task and move on" reconciliation, because their answer has
 * a designated reader and a reserved turn sequence.
 *
 * The type keeps `pre_accept` and `wrap_up` for legacy records only, and both
 * are retired: the pre-accept agent turn gave way to the mechanical acceptance
 * gate at accept, and the standalone wrap-up turn behind `lazy finalize` gave
 * way to closing steps that run inside the turn that ends the work. Neither
 * holds a record any more; a record left by an older daemon is abandoned on
 * sight (settleInFlightTurnLocked). `ask` and `review` are ASYNCHRONOUS as of the no-ceiling
 * change — their RPC starts the turn and returns, and the answer lands as a
 * turn of that type, which the caller waits for with `lazy wait`. The record
 * is what makes the turn addressable in between: it names the sequence the
 * answer will occupy, the status to restore, and the run to probe or stop.
 *
 * Deliberately NOT every turn: an ordinary work turn has no reserved sequence,
 * and a record left behind by a crashed one would make auto-resume — whose
 * whole job is to relaunch after a crash — refuse to run.
 */
export type InFlightTurnOwner = 'ask' | 'pre_accept' | 'review' | 'wrap_up';

/** The retired owners, kept only so a legacy record can be read and abandoned. */
export const RETIRED_IN_FLIGHT_OWNERS: readonly InFlightTurnOwner[] = ['pre_accept', 'wrap_up'];

/**
 * How an in-flight turn ended, written by whoever reconciled the response.
 * The waiter polls for this rather than reading the protocol dir.
 */
export interface InFlightTurnOutcome {
  /**
   * - completed — the agent answered and the turn was recorded.
   * - error     — the supervisor wrote an ErrorResponse.
   * - foreign   — a completed response arrived that did not answer this
   *               command (a retired `pre_accept` record, or a response whose
   *               command id does not match).
   */
  kind: 'completed' | 'error' | 'foreign';
  /** Sequence of the agent turn that was recorded, when one was. */
  turn_sequence?: number;
  /** The agent's answer text, for the waiter to hand back to its caller. */
  result?: string;
  /** Token usage the answer reported, so the waiter can report it verbatim. */
  usage?: AgentTokenUsage;
  /** Wall-clock the agent process itself took, for the waiter's timings. */
  agent_duration_ms?: number;
  /**
   * Pre-accept gate verdict, copied verbatim from the response. LEGACY read-only:
   * present only on old records — the pre-accept turn that populated it is
   * retired (the mechanical gate runs at accept and files no turn), and the
   * abandon path settles nothing of the kind.
   */
  gate?: {
    passed: boolean;
    failed_command?: string;
    exit_code?: number;
    output?: string;
  };
  /** Human-readable explanation for `error` and `foreign`. */
  message?: string;
  settled_at: number;
}

/**
 * A turn that is running right now, and who is waiting for its answer.
 *
 * This is the correlation the protocol dir cannot provide: it is a single-slot
 * mailbox with no command id, so a waiter reading `response.json` gets whatever
 * is in the slot — including another command's answer. Here the waiter records,
 * BEFORE the command is written, the turn sequence its answer will occupy;
 * every other writer (reconciler, auto-resume, auto-deliver) checks for a live
 * record and leaves the task alone, and the reconciler settles the response
 * against this record instead of parking the task.
 *
 * Bounded by `expires_at` rather than by liveness: a pid can be recycled (so
 * "is the starter still alive?" is not answerable safely), but a wait always
 * has a deadline, and a record past its deadline is stale by construction.
 */
export interface InFlightTurn {
  /** Session the turn belongs to. */
  session_id: string;
  owner: InFlightTurnOwner;
  /** Turn type the answer must carry for the waiter to accept it. */
  turn_type: TurnType;
  /**
   * Correlation id stamped on the command BEFORE it is written. The supervisor
   * echoes it on the response; a waiter accepts an answer only when they match.
   * Absent on records persisted before correlation shipped — treated as
   * uncorrelated, never as a mismatch.
   */
  command_id?: string;
  /** Sequence RESERVED for the agent's answer (see reserveTurnSequences). */
  turn_sequence: number;
  /**
   * WHO ASKED FOR THIS TURN, captured when the claim was made.
   *
   * The same pair `Session.turn_owner_email` carries, held per TURN rather than
   * per session, because this turn's ending may be recorded after a LATER turn
   * has taken the session over: an abandoned or stopped claim is settled by
   * whoever ticks next. Reading the session then would name the newer turn's
   * owner — a specific wrong person on an append-only row.
   *
   * Absent means nobody asked (a system-initiated turn) or the record predates
   * the field, which downstream treat the same way: record no person.
   */
  turn_owner_email?: string;
  /** The owner's display name at claim time, when their identity carried one. */
  turn_owner_name?: string;
  /** Sequence of the human/marker turn that opened the exchange. */
  human_turn_sequence: number;
  /** Status the task must return to once the turn settles. */
  restore_status: TaskStatus;
  started_at: number;
  /** After this instant the record is stale and any reader may clear it. */
  expires_at: number;
  /**
   * Run/container the turn is executing in, stamped once the launch succeeded.
   *
   * WHY IT IS ON THE RECORD. `ask` and `review` no longer have an RPC caller
   * sitting on the answer (see {@link InFlightTurnOwner}), so "is the thing
   * that would answer this still alive?" has to be answerable by whoever ticks
   * next — the reconciler — and by `lazy stop`. For a review the answer is NOT
   * `session.container_name`: a review deliberately runs in its own ephemeral
   * run and is never stamped on the session, so a stop routed by the session
   * killed the implementer's container and left the reviewer running.
   *
   * Absent until the launch returns, which is exactly the window where a
   * liveness probe would be wrong (the run is claimed but not yet started), so
   * its ABSENCE is the startup grace.
   */
  run_name?: string;
  /** Runner type that owns {@link run_name} (docker / host-process / …). */
  runner_type?: RunnerType;
  /**
   * Which PROCESS made this claim — a random id minted once per process start
   * (`CLAIMING_PROCESS_ID`, src/daemon/in-flight-turn.ts).
   *
   * A claim's run lives only as long as the daemon that launched it: every
   * child's proxy address dies with that daemon (src/daemon/generation.ts),
   * and a launch still in flight when it dies never stamps {@link run_name}.
   * So a reconciler that finds a claim some OTHER process made knows the turn
   * can no longer finish, and ends it instead of waiting out {@link expires_at}.
   * An id rather than a timestamp, so a wall-clock step after boot cannot make
   * this process's own claim look foreign. Absent on records written before the
   * field existed — every one of which a previous daemon made.
   */
  claimed_by_process?: string;
  /**
   * Work a completed `review` still owes when it settles: starting the
   * auto-fix turn. Persisted because the settle now happens in the reconciler
   * rather than in the RPC caller that chose it.
   */
  review_follow_up?: {
    auto_fix?: boolean;
    /**
     * This review was DISPATCHED by the daemon (final-turn design §8): the
     * settle runs the §8.1 round accounting (cap, blocking findings, the
     * hand-back to a cluster parent) instead of the plain auto-fix path. Manual `lazy review`
     * turns never carry it and never count toward the round cap.
     */
    auto_review?: boolean;
    /** Actor to attribute the auto-fix unblock to. */
    actor?: Actor;
  };
  /** Set by the reconciler (or whoever settles the response) when it ends. */
  outcome?: InFlightTurnOutcome;
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
  /** WHICH person performed it, when the daemon knew. See {@link ActorRef}. */
  actor_email?: string;
  /** Their display name at the time, when the write carried one. */
  actor_name?: string;
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
   * Which agent PROFILE the running container was last (re)created for.
   *
   * Launch env (proxy endpoint vars, credential placeholders, harness wiring)
   * is fixed at `docker run` time. A mid-task agent switch updates
   * `session.agent_id` but leaves the old container's env in place; reusing it
   * then fails the new harness (e.g. `LAZY_CODEX_API_BASE` missing after a
   * Claude→Codex switch). Launch paths compare this stamp to `task.agent_id`
   * and recreate on mismatch. null = never stamped (legacy) or container gone.
   */
  container_agent_id: string | null;
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
  /**
   * High-water mark of turn sequences handed out by `reserveTurnSequences`.
   *
   * `getNextTurnSequence` derives from the turns that EXIST, which allocates
   * but does not reserve: "my answer will be turn N+1" is identity by
   * convention, and any turn written in between takes the number. A caller that
   * must be able to recognize its own answer reserves the sequence up front and
   * `getNextTurnSequence` returns `max(lastTurn, reserved) + 1` thereafter.
   *
   * 0 (or missing, on legacy sessions) means nothing was ever reserved.
   */
  reserved_turn_sequence?: number;
  /**
   * High-water mark of task COMMENTS already delivered to the agent: the
   * `created_at` of the newest comment carried by a prompt that actually
   * rendered the `NOTES ADDED SINCE YOUR LAST TURN` block (the initial start
   * and every `lazy unblock`).
   *
   * INVARIANT: this — not "the last agent turn" — is the cutoff for what counts
   * as a new note. Only unblock and the initial launch deliver notes;
   * `lazy ask` skips them on purpose (a read-only question must not consume the
   * human's queued feedback) and `lazy sync` never builds them. Both still
   * record AGENT turns, so a last-agent-turn cutoff silently dropped every
   * comment written before an intervening ask or sync — losing human feedback,
   * which is the one thing lazy must never do.
   *
   * Advanced only by the delivered notes themselves, never to "now", so a
   * comment created while the prompt was being assembled is delivered next
   * time rather than skipped. Turn 1 ESTABLISHES the mark unconditionally
   * (task-launcher), so only sessions predating this field are null/missing —
   * those fall back to the last agent turn, the old behaviour.
   */
  notes_delivered_through?: number | null;
  /**
   * WHO ASKED FOR THE TURN this session is currently running — the durable half
   * of the turn owner (src/daemon/turn-owner.ts).
   *
   * Written at every launch, including the null that means "nobody asked for
   * this one": the owner belongs to the TURN, so a turn the daemon starts by
   * itself (auto-resume, auto-deliver, a sync nobody asked for) CLEARS the
   * person the previous turn recorded rather than inheriting them.
   *
   * Absent or null means NO ASKER, and nothing more. Whether the daemon started
   * the turn ITSELF is a separate, positively recorded fact — see
   * {@link Session.turn_system_initiated}.
   *
   * On the session rather than only in memory because an agent writes for the
   * whole length of a turn: a daemon restarted mid-turn must still be able to
   * say whose work the rows that arrive afterwards are.
   */
  turn_owner_email?: string | null;
  /** The owner's display name at launch time, when their identity carried one. */
  turn_owner_name?: string | null;
  /**
   * THE DAEMON STARTED THIS TURN ITSELF — auto-resume, auto-deliver, a sync
   * nobody typed (§3.3 case 3). Written by the same launch write that clears
   * the owner, and cleared by the one that records a person.
   *
   * Recorded POSITIVELY rather than inferred from the owner being absent,
   * because absence has other causes: a best-effort person write that failed,
   * a session written before any of this existed, a store that never received
   * the write. Those must degrade to naming NOBODY — the pre-identity shape,
   * correctable later — and not to naming the account the automation is
   * configured under, which is a claim about a specific person that reading the
   * row can never expose as wrong.
   */
  turn_system_initiated?: boolean | null;
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
  /**
   * The agent id this turn was LAUNCHED with (e.g. `claude-code`, `cursor`), as
   * resolved at launch.
   *
   * Task-level `agent_id` is last-value-wins — `lazy edit --agent` / the MCP
   * `agent` field switch a task's agent mid-flight (and reset the session), so
   * the task record only remembers the LATEST agent and cannot answer "which
   * agent produced turn N". This field can. Same argument as `effort` below.
   *
   * Recorded on the human/builder turn that requests the work AND on the agent
   * turn that answers it, so a mid-task agent switch is visible on exactly the
   * turns it applied to.
   *
   * Absent means UNKNOWN, and must render as unknown. Every turn written before
   * this field existed has no agent, and there is deliberately no back-fill: a
   * turn labelled `claude-code` because that is today's default, when it in fact
   * ran under something else, is worse than one labelled unknown. Same
   * convention as `effort` and `mcp_tools`.
   */
  agent?: string;
  /**
   * The model this turn was LAUNCHED with — the resolved value passed as
   * `--model` (usually a tier alias like `opus`, or a concrete id for a local
   * backend). Recorded on the human/builder turn that requests the work AND on
   * the agent turn that answers it, so a mid-task `--model` override is visible
   * on exactly the turns it applied to.
   *
   * Purely a LABEL — no launch reads it back. A turn without an explicit
   * override inherits `task.model`, never the previous turn's value; see the
   * edited-task-model-wins invariant in src/utils/turns.ts.
   */
  model?: string;
  /**
   * The CONCRETE model id the agent itself reported for this turn (e.g.
   * `claude-opus-4-5-20251101`), when it reports one. Agent turns only.
   *
   * Deliberately separate from `model`: `model` is what was requested (an alias
   * resolves to different snapshots over time), `model_id` is what actually ran.
   * Absent means the agent did not report one — `model` is then the most
   * specific identifier available for that turn, and the absence is the signal
   * that it is an alias rather than a silent degradation.
   */
  model_id?: string;
  /**
   * Reasoning effort in force for this turn (`--effort`), as resolved at launch.
   *
   * Task-level `metadata.effort` is last-value-wins, so it cannot answer "which
   * effort produced turn N". This field can. Absent means no effort was passed
   * on this turn's launch (e.g. sync conflict-resolution invocations, or turns
   * recorded before this field existed).
   */
  effort?: string;
  /**
   * What the agent reported about its own lazy MCP tools when this turn
   * started: `lazy=<server status> tools=<count of mcp__lazy__* tools>`.
   *
   * Recorded because nothing else can answer "did that turn actually have its
   * tools?" once the container is gone — the config lazy wrote proves only what
   * was offered, not what the agent loaded. Absent for turns whose agent
   * reported nothing (and for every turn recorded before this field existed),
   * which is NOT the same as "had no tools".
   */
  mcp_tools?: string;
  /** Full prompt sent to agent (only for human turns that trigger agent work) */
  prompt?: string;
  /** Who created this turn: human (CLI) or builder (MCP). Only meaningful for role='human' turns. */
  actor?: Actor;
  /**
   * WHICH person acted, when the daemon knew — git's email for them. Absent
   * for actors with no person behind them and for every turn written before
   * this field existed. See {@link ActorRef}.
   */
  actor_email?: string;
  /** Their display name at the time, when the write carried one. */
  actor_name?: string;
  /** File permission violations detected in this turn */
  violations?: FileViolation[];
  /**
   * Paths that were still uncommitted in the worktree when this turn ended.
   *
   * None of them is on the branch, so none of them is in this task's diff, in
   * its walkthrough, or in what accept would merge — the field exists so a
   * reviewer learns that from the turn record instead of by running `git
   * status` in a container they may not have. Capped at 50 paths.
   *
   * Written only when the set is NON-EMPTY. Absent therefore means "clean, or
   * never scanned": a scan that could not run is deliberately indistinguishable
   * from a clean one here rather than being recorded as proof of cleanliness.
   */
  uncommitted?: string[];
  /** Exit code of the post-turn check command (undefined if no check configured) */
  check_exit_code?: number;
  /** Captured output from the post-turn check command */
  check_output?: string;
  /** Exit code of the pre-turn setup hook, when it failed before this turn */
  pre_turn_exit_code?: number;
  /** Captured output of the failed pre-turn setup hook */
  pre_turn_output?: string;
  /** Whether this turn was auto-triggered (CI failure, comment, upstream sync, crash) vs human-triggered */
  auto_triggered?: boolean;
  /**
   * Category of work this turn represents. Default (missing) is 'work' —
   * a substantive agent turn that advances the task's narrative. 'ask' is
   * a read-only Q&A exchange (e.g. from `lazy browse -i`) that doesn't
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
  /**
   * True when the turn that recorded this error provably had no effect on the
   * branch: no new commits AND the worktree was clean when the turn ended.
   *
   * Only meaningful on agent error turns — successful turns always have some
   * effect (at minimum, the agent's response). Downstream consumers use this to
   * skip mechanisms that only make sense when work was done (e.g., reflection
   * is nonsensical when there's nothing to reflect on).
   *
   * Absence means unknown, not "had effect" — fall back to existing behavior.
   */
  agent_had_no_effect?: boolean;
  /**
   * Structured findings from an agent review turn (`turn_type: 'review'`).
   * Absent on every other turn. See {@link ReviewReport}.
   */
  review?: ReviewReport;
  /**
   * How this review was started — 'auto' (daemon-dispatched after a final) or
   * 'manual' (somebody asked). Read by the accept gate; absent means 'manual'.
   */
  review_dispatch?: 'auto' | 'self' | 'manual';
  /**
   * This review's findings were already applied by the same exchange — the
   * `low_high` revise pass. Read by the gate, which must not hold a merge on
   * findings that were fixed seconds after they were written down.
   */
  review_addressed?: boolean;
  /**
   * Pencils down: the agent (or a human) declared this task's work finished on
   * THIS turn. Absent on every turn that declared nothing. See {@link FinalClaim}.
   */
  final?: FinalClaim;
}

/**
 * A declaration that a task's work is DONE, recorded on the turn that made it.
 *
 * INVARIANT (final-turn design §2.2): a final is a CLAIM ABOUT A SHA, never a
 * boolean on the task and never recomputed. It lives on the turn — alongside
 * {@link ReviewReport} and for the same reason — because turns are append-only,
 * so nothing can rewrite the record of who declared what, when, and over which
 * head. Whether a task IS final right now is a question only
 * `resolveFinalState` (src/task/final-state.ts) answers, from these records.
 */
export interface FinalClaim {
  /** HEAD of the task branch when the claim was made. */
  sha: string;
  /** 'agent' for `lazy_final`; 'human' for a human declaring it themselves. */
  actor: Actor;
  /** WHICH person declared it, when the daemon knew. See {@link ActorRef}. */
  actor_user_id?: string;
  /** When the claim was made (epoch ms). */
  at: number;
  /** The agent's one-line note about the state it is handing over, if any. */
  note?: string;
  /**
   * Which wrap-up steps actually RAN for this final, in order — an AUDIT
   * RECORD, so a reviewer can see what was skipped.
   *
   * INVARIANT (final-turn design §13.3): this is NOT the task's audience. No
   * surface may read it to answer "what audience is this task" — only
   * `audienceOf` (src/task/audience.ts) answers that, derived from the runner.
   * A stored audience is exactly the drift `resolveFinalState` avoids for
   * finality itself. Empty until a wrap-up has run (slice 3 stamps it).
   */
  wrap_up_steps: string[];
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
export type TurnType = 'work' | 'ask' | 'nudge' | 'sync' | 'pre_accept' | 'review' | 'wrap_up';

export type {
  ReviewFinding,
  ReviewFindingCategory,
  ReviewFindingSeverity,
  ReviewReport,
} from './review-report';
export {
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_SEVERITIES,
} from './review-report';

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
  /** WHICH person left it, when the daemon knew. See {@link ActorRef}. */
  actor_email?: string;
  /** Their display name at the time, when the write carried one. */
  actor_name?: string;
  /** Where this comment originated: 'local' (created in lazy) or 'remote' (synced from PR/MR). */
  source?: CommentSource;
  /**
   * The forge item this comment corresponds to. On a `remote` comment it is
   * the item it was imported FROM; on a `local` comment it is the item it was
   * posted AS (lazy does not post comments today, but the field is shaped so
   * that it can record one). Import dedup is by this, never by content.
   */
  external?: CommentExternalRef;
  /** When the content was last edited in place (only allowed while unseen). */
  edited_at?: number;
  /** Who made the last edit (the channel), when recorded. */
  edited_by?: Actor;
  /** WHICH person made the last edit (their address), when the daemon knew. */
  edited_by_email?: string;
  /** What to call that person, when the write carried a name. */
  edited_by_name?: string;
  /**
   * The local comment this one revises: a forge comment edited AFTER the agent
   * saw the local copy is imported as a new comment pointing back at it,
   * because history the agent acted on is never rewritten.
   */
  revises_comment_id?: string;
}

/** A forge a comment can be tied to. */
export type CommentForge = 'github' | 'gitlab';

/**
 * Which kind of forge item. Ids are unique only WITHIN a kind (a GitHub issue
 * comment and a line comment can share a numeric id), so kind is part of the
 * identity.
 */
export type CommentExternalKind =
  | 'issue_comment'   // GitHub PR conversation comment
  | 'line_comment'    // GitHub PR review (inline) comment
  | 'review_body'     // GitHub PR review summary
  | 'mr_note';        // GitLab MR note

export interface CommentExternalRef {
  forge: CommentForge;
  kind: CommentExternalKind;
  /** The forge's own id for the item, as a string. */
  id: string;
  /** sha256 (hex) of the forge body this comment reflects — detects edits. */
  body_hash: string;
}

/** A change to an existing comment. See {@link Storage.updateComment}. */
export interface CommentUpdate {
  content?: string;
  external?: CommentExternalRef;
}

/** Optional structured fields at comment creation. */
export interface CommentCreateOptions {
  external?: CommentExternalRef;
  revises_comment_id?: string;
}

/** @deprecated Use Comment instead */
export type Note = Comment;

/**
 * A task journal entry — an append-only, free-form note about *managing* a task
 * rather than *doing* it: orchestration metadata ("blocked on X landing"),
 * decision rationale ("chose K=3 because…"), or an agent memory ("stubbed Z,
 * revisit next run").
 *
 * INVARIANT (three parts, all load-bearing):
 *   1. **Non-triggering** — appending an entry must never start, resume, or
 *      auto-react a turn. Nothing may hook a turn off a journal write.
 *   2. **Body never auto-injected** — entry CONTENT must never be placed into
 *      the agent/LLM prompt by any code path. This is why the journal is a
 *      separate entity from {@link Comment} (whose body DOES enter the prompt as
 *      guidance) rather than a flag on it: with no shared code path, there is
 *      structurally no way for an entry body to leak into a prompt.
 *   3. **Count-notice only** — the ONE thing prompt assembly may derive from the
 *      journal is a mechanistic count of entries new since the agent's last
 *      turn, rendered by `buildJournalNotice` in src/task/turn-context.ts.
 *      Count and pointer, never text.
 *
 * Reads are pull-based and open: anyone — human, builder, or an agent looking at
 * its own task — may read entries on demand (`lazy journal`, `lazy_show
 * sections=["journal"]`). "Not injected" is not "not readable"; the point is
 * that the journal INFORMS on request, while a comment INSTRUCTS on delivery.
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
  /** WHICH person wrote it, when the daemon knew. See {@link ActorRef}. */
  actor_email?: string;
  /** Their display name at the time, when the write carried one. */
  actor_name?: string;
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
 * Distinct from the task journal: the journal is a raw, per-task, pull-based
 * record of what happened on one task (its text is never injected — an agent is
 * only ever told how many entries are new); memory is curated, cross-task
 * knowledge that IS injected (as a compact index) into builder and agent launches.
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
  /** Actor (role) that first created this record. */
  created_by: Actor;
  /**
   * The PERSON behind `created_by`, when the write could be attributed to one
   * (a member's token, or the daemon's git identity on a laptop). Absent — not
   * present-and-undefined — when nobody could be named.
   */
  created_by_email?: string;
  created_by_name?: string;
  /** Actor (role) of the most recent write. */
  updated_by: Actor;
  /** The person behind `updated_by`, when there was one. */
  updated_by_email?: string;
  updated_by_name?: string;
  /** Write count: 1 on create, incremented on every update. */
  revision: number;
  /**
   * Tombstone. Set by `lazy memory rm`; the record stops being listed, recalled
   * and injected, but its write history is preserved (history is never
   * rewritten). A later save under the same name revives it as a new revision.
   */
  deleted_at?: number;
  deleted_by?: Actor;
  /** The person behind `deleted_by`, when there was one. */
  deleted_by_email?: string;
  deleted_by_name?: string;
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
  /** The person behind `actor`, when the write could be attributed to one. */
  actor_email?: string;
  actor_name?: string;
  timestamp: number;
  /** Revision the record carried after this write. */
  revision: number;
  /** Content as written. Absent for 'delete' events (nothing was written). */
  description?: string;
  type?: MemoryType;
  body?: string;
}

// --- Builder scratch sandbox ---

/**
 * Why a scratch file's content is not stored.
 *
 * NEVER a truncation: content is stored whole or not at all. A skipped file
 * still gets a record (path, size, provenance) so the engineer can see that the
 * artifact exists in the live scratch dir and why lazy declined to persist it —
 * silently dropping it would be worse than not persisting it.
 *
 *   - 'binary'       — not valid UTF-8. Unsearchable and unreadable through
 *                      lazy's text surfaces; it stays on the host only.
 *   - 'too_large'    — over the per-file cap.
 *   - 'sandbox_full' — the sandbox is at its total cap.
 */
export type ScratchSkipReason = 'binary' | 'too_large' | 'sandbox_full';

/**
 * One file captured from a builder's scratch sandbox into the project store.
 *
 * Keyed by `path` — the file's path relative to the sandbox root — so a builder
 * rewriting the same file updates one record rather than accumulating versions.
 */
export interface ScratchFile {
  /** Path relative to the scratch sandbox root, e.g. `review/accept-foo.md`. */
  path: string;
  /**
   * Full UTF-8 content. Empty string when `skipped` is set — the content was
   * never stored, not shortened.
   */
  content: string;
  /** Size in bytes of the file on disk at capture time. */
  size: number;
  /** Set when content was deliberately not stored. Absent for stored files. */
  skipped?: ScratchSkipReason;
  /**
   * Claude session id of the builder that last wrote this file, when the
   * capturing supervisor had detected one. This is the link to the captured
   * conversation — `lazy conversation read <session_id>` shows what the builder
   * was doing when it wrote this.
   */
  session_id?: string;
  created_at: number;
  /** Last capture that changed the content. Not a re-capture of identical bytes. */
  updated_at: number;
  /** Actor of the most recent write. */
  updated_by: Actor;
}

/** The caller-supplied fields of a scratch-file write. */
export interface ScratchFileInput {
  path: string;
  content: string;
  size: number;
  skipped?: ScratchSkipReason;
  session_id?: string;
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
  /** The person behind `generated_by`, when there was one. */
  generated_by_email?: string;
  generated_by_name?: string;
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
 * What a system message is:
 *   - 'report' — a proactive analysis (post-mortem digest, weekly tool-call
 *                patterns, daily token usage) produced by a scheduled task.
 *   - 'notice' — a system event worth telling the human about (e.g. the daemon
 *                version changed across a restart), or an environment problem
 *                an agent hit and cannot fix that is not blocking its task.
 *   - 'alert'  — something that likely needs the human's attention soon, e.g. an
 *                environment blocker holding up a task's acceptance.
 *
 * NOT lazy's own diagnosis channel: config/health warnings about LAZY stay in
 * `lazy doctor` (single-warning-surface rule). System messages carry proactive
 * reports, and blockers in the project's environment that only the human can
 * fix — both written FOR the human.
 */
export type SystemMessageKind = 'report' | 'notice' | 'alert';

/**
 * A proactive system-to-human report. Written by the system (a scheduled
 * report task, the daemon, the builder); read by the human — injected compactly
 * into the builder's launch prompt while unread, listable by the CLI and any
 * UI at all times.
 *
 * INVARIANT: creation is append-only and messages are never deleted or edited.
 * Reading and dismissal are state changes on the message (`read_at`,
 * `dismissed_at`), so the record of what the system told the human is
 * permanent. Dismissal only removes a message from the default surfaces.
 */
export interface SystemMessage {
  id: string;
  created_at: number;
  /**
   * What produced this message — a task code (report tasks), 'daemon',
   * 'builder', or 'doctor'. Attribution data, derived by the producing
   * surface, never free-form caller input from an agent.
   */
  source: string;
  /** One-line headline. This is what compact surfaces (builder launch) render. */
  title: string;
  /** Full body (markdown). */
  body: string;
  kind: SystemMessageKind;
  /** Set the first time the full body is read. Never cleared or moved. */
  read_at?: number;
  /** Set on dismissal (human/builder decision). Never cleared. */
  dismissed_at?: number;
  dismissed_by?: Actor;
}

/** The caller-supplied fields of a system message creation. */
export interface SystemMessageInput {
  source: string;
  title: string;
  body: string;
  kind: SystemMessageKind;
}

/**
 * A first-class item an agent surfaces for human eyes: a question, a decision,
 * a proposal for orthogonal work, or an FYI. ONE entity with ONE attribute —
 * `blocking` — replacing the former raised-item / follow-up split.
 *
 * `blocking: true` means "a question or decision about THIS task's own scope or
 * diff": accept refuses while any such item is open, until each is resolved.
 * `blocking: false` is everything else the human should see — yesterday's
 * follow-ups. It never gates anything.
 *
 * INVARIANT: task-level and NON-TRIGGERING. Creating or resolving one never
 * starts a turn, writes a comment, or changes task status by itself. That
 * non-triggering property is exactly why this is a distinct store and NOT
 * comments (comments feed the auto-react loop, which would spuriously kick the
 * agent into a new turn). Accept refuses while blocking items are open; that is
 * the only lifecycle coupling. Close / reject / abandon leave open items as
 * historical `open` — never rewrite on terminal transitions.
 *
 * Comments for a resolution stay PENDING on the item (`pending_comment`) until
 * the next unblock/accept materializes them into real comments. Undo is
 * overwrite or unresolve before that moment — comments are append-only, so we
 * never write one at resolve time.
 *
 * See docs/design/raised-items-unified.md.
 */
export type RaisedItemStatus =
  | 'open'
  | 'responded'
  | 'acknowledged'
  | 'dismissed'
  | 'promoted_subtask'
  | 'promoted_peer'
  /** Legacy stored records — display them; do not accept as new input. */
  | 'answered';

/**
 * How a reviewer resolves an open raised item. One vocabulary for blocking and
 * non-blocking items alike.
 *
 * `answer` remains on the type so stored payloads and display of historical
 * records type-check; validation rejects it as new input.
 */
export type RaisedItemResolveAction =
  | 'respond'
  | 'promote_subtask'
  | 'promote_peer'
  | 'dismiss'
  | 'acknowledge'
  | 'answer';

/** Actions accepted on new resolutions (not the legacy `answer`). */
export const ACTIVE_RAISED_ACTIONS = [
  'respond',
  'promote_subtask',
  'promote_peer',
  'dismiss',
  'acknowledge',
] as const;

export type ActiveRaisedResolveAction = (typeof ACTIVE_RAISED_ACTIONS)[number];

/** Map a (new or legacy) action to the status stored on the item. */
export function raisedStatusForAction(action: RaisedItemResolveAction): RaisedItemStatus {
  switch (action) {
    case 'respond':
      return 'responded';
    case 'promote_subtask':
      return 'promoted_subtask';
    case 'promote_peer':
      return 'promoted_peer';
    case 'dismiss':
      return 'dismissed';
    case 'acknowledge':
      return 'acknowledged';
    case 'answer':
      return 'answered';
  }
}

/**
 * Append-only note on a raised item (typically from the task agent after a
 * review auto-fix). Does NOT resolve or dismiss the item — only humans do
 * that. Shown on Raised surfaces so a reviewer can see "fixed", "disagree",
 * etc. without the agent being able to clear the gate by commenting.
 */
export interface RaisedItemComment {
  id: string;
  content: string;
  created_at: number;
  actor: Actor;
  /** WHICH person wrote it, when the daemon knew. See {@link ActorRef}. */
  actor_email?: string;
  /** Their display name at the time, when the write carried one. */
  actor_name?: string;
  session_id?: string | null;
  turn_sequence?: number | null;
}

export interface RaisedItem {
  id: string;
  task_id: string;
  /**
   * Canonical body for search, recurrence grouping, and listings. For a structured
   * proposal this is `title` + optional `explanation`; otherwise it is the
   * free-text the agent filed.
   */
  content: string;
  /**
   * TRUE when this is a question or decision about the task's own scope or
   * diff — accept refuses while it is open. FALSE for orthogonal proposals and
   * FYIs, which never gate.
   *
   * Required on every new write. Legacy stored records that predate the flag
   * are read as `true` (the raised-item store only ever held gating items);
   * records converted from the follow-up store are `false`.
   */
  blocking: boolean;
  /** Short title for listings and the default promote goal, when structured. */
  title?: string;
  /** Longer context shown at review; omitted when the title alone suffices. */
  explanation?: string;
  /** Agent-suggested task code used when this item is promoted. */
  proposed_code?: string;
  /** Agent-suggested task prompt used when this item is promoted. */
  proposed_prompt?: string;
  /** Optional options the agent offers (multiple-choice). Omitted = open-ended. */
  options?: string[];
  created_at: number;
  /** The session (agent run) that surfaced it, if known. */
  session_id?: string | null;
  /**
   * Turn sequence that raised it, when known. Lets the structured turn report
   * and review surfaces link "this report's questions" without parsing prose.
   */
  turn_sequence?: number | null;
  status: RaisedItemStatus;
  /** Set when resolved. Cleared on undo (only if the comment is still pending). */
  resolved_at?: number;
  resolved_by?: Actor;
  /**
   * WHICH PERSON decided it, when the daemon knew — the `human` role says a
   * human decided, this says who, by email. Absent for every actor with no
   * person behind it and for records written before per-person attribution.
   */
  resolved_by_email?: string;
  /** Their display name at the time, when the write carried one. */
  resolved_by_name?: string;
  /**
   * Reviewer note: the respond text, dismiss reason, acknowledge note, or
   * optional extra instruction on a promote.
   */
  resolution?: string | null;
  /**
   * Agent (or peer) notes on this item — append-only. Never resolves the item.
   * Distinct from `pending_comment`, which is the human resolution that becomes
   * a task Comment on the next unblock/accept.
   */
  comments?: RaisedItemComment[];
  /**
   * Comment text scheduled for the next unblock/accept. Absent on records that
   * never scheduled one (acknowledge, and everything migrated from follow-ups).
   * Cleared after materialize (see comment_delivered_at).
   */
  pending_comment?: string | null;
  /** When pending_comment was written as a real comment. */
  comment_delivered_at?: number;
  /**
   * Session turn number of the unblock turn that carried the materialized
   * comment, when known. Absent when the comment was materialized outside a
   * turn launch (accept) or before this field existed — surfaces fall back to
   * the comment_delivered_at timestamp alone.
   */
  delivered_turn?: number | null;
  /** Task created when a promotion is materialized (or promoted immediately). */
  promoted_task_id?: string | null;
  /** Human-facing code of the promoted task — avoids a lookup in listings. */
  promoted_task_code?: string | null;
  /**
   * Who last changed `blocking` from what the agent chose. Absent means the
   * flag is still the agent's own call — the reviewer has not overridden it.
   */
  flagged_by?: Actor;
  /** Which person last changed `blocking`, when the daemon knew. */
  flagged_by_email?: string;
  /** Their display name at the time, when the write carried one. */
  flagged_by_name?: string;
  /**
   * Who UNDID a resolution, when one was undone — the item is open again, so
   * there is no decision to attribute, and "who reopened this" is the only
   * thing left worth recording. Cleared by the next resolution.
   */
  unresolved_by?: Actor;
  /** Which person undid the resolution, when the daemon knew. */
  unresolved_by_email?: string;
  /** Their display name at the time, when the write carried one. */
  unresolved_by_name?: string;
  /** Provenance for records converted from the pre-unification follow-up store. */
  migrated_from?: 'follow_up';
}

/**
 * Caller input when creating a raised item — free-text note or structured
 * proposal, plus the blocking flag.
 */
export interface RaisedItemInput {
  /** Canonical body. Alias: `note`. Optional when `title` is supplied. */
  content?: string;
  /** Legacy single-field spelling of `content`. */
  note?: string;
  blocking: boolean;
  title?: string;
  explanation?: string;
  proposed_code?: string;
  proposed_prompt?: string;
  options?: string[];
  session_id?: string | null;
  turn_sequence?: number | null;
}

/** Caller input when resolving a raised item (accept / unblock / review). */
export interface RaisedItemResolution {
  id: string;
  action: RaisedItemResolveAction;
  /** Required for respond/dismiss; optional extra note for the rest. */
  response?: string;
}

/** Result of promoting a raised item into a backlog task. */
export interface PromoteRaisedItemResult {
  raised_item: RaisedItem;
  task: Task;
}

/** Outcome of promoting part of a stored builder conversation into a task. */
export interface PromoteConversationResult {
  task: Task;
  /** Full session id of the conversation the task was seeded from. */
  session_id: string;
  /** 1-based inclusive message numbers the seed came from. */
  range: { from: number; to: number };
  /**
   * Tasks already promoted from an OVERLAPPING part of the same conversation.
   * Not a refusal — a long conversation legitimately yields several tasks —
   * but the caller must say so, or the same passage gets promoted twice.
   */
  overlapping: Array<{ task_id: string; task_code: string | null; range: { from: number; to: number } }>;
}

/**
 * Pre-unification follow-up triage vocabulary. Retained only so the migration
 * and the Teams-facing legacy RPC view can name the states they map.
 */
export type FollowUpTriageStatus = 'open' | 'acknowledged' | 'dismissed' | 'promoted';

/**
 * Outcome of the one-time follow-up → raised-item migration.
 *
 * `failures` is why this is a result and not a void: a record that could not be
 * converted must be REPORTED, not dropped. A non-empty `failures` means those
 * tasks' follow-up files were left in place for a retry.
 */
export interface FollowUpMigrationResult {
  /** Tasks whose follow-up file was read (converted or not). */
  tasks_scanned: number;
  /** Records written as raised items by this run. */
  converted: number;
  /** Records skipped because a raised item already carried that id. */
  already_migrated: number;
  /** Tasks whose follow-up file was renamed to follow-ups.migrated.json. */
  tasks_retired: number;
  failures: Array<{
    task_id: string;
    /** Absent when the whole file failed to read/parse. */
    follow_up_id?: string;
    reason: string;
  }>;
}

/**
 * Outcome of the one-time `actor_user_id` → `actor_email` migration
 * (docs/design/actor-identity-and-remote-clients.md §3.8).
 *
 * `cleared` and `cleared_ids` are why this is a result and not a void: an id
 * this install cannot read as a person is DROPPED by the migration, and
 * dropping attribution silently is the one thing a migration of this field must
 * not do. The daemon reports both on every start that changes anything.
 */
export interface ActorIdentityMigrationResult {
  /** Task directories whose files were read. */
  tasks_scanned: number;
  /** Files rewritten. Zero on a store that has already been migrated. */
  files_rewritten: number;
  /** Attributions carried forward: a legacy id that WAS an email. */
  carried: number;
  /**
   * Attributions cleared: a legacy id that was not an email, so the row keeps
   * its actor ROLE and names nobody. Counted per attribution, not per row — one
   * raised item can carry a resolver and an un-resolver.
   */
  cleared: number;
  /**
   * The distinct ids that were cleared, capped — so an operator can still map
   * them by hand (or from their control plane) after the fact instead of
   * learning only that "some" attribution went away.
   */
  cleared_ids: string[];
  /** True when more distinct ids were cleared than `cleared_ids` lists. */
  cleared_ids_truncated: boolean;
  failures: Array<{
    task_id: string;
    /** The file that could not be read or rewritten. */
    file: string;
    reason: string;
  }>;
}

/**
 * Typed end-of-turn report an agent delivers via `lazy_report`.
 *
 * INVARIANT: reporting channel ONLY — never a turn-end or liveness signal.
 * Upserting one must not arm any watchdog fuse, change task status, or start a
 * turn (the lazy_commit-fuse pathology that fix-turn-end-detection killed).
 *
 * INVARIANT (narrowed 2026-09, engineer-approved): storage and MCP keep the
 * agent's array order (the authoring contract). Human-facing renderers apply a
 * policy-seamed tier order and preserve agent order within a tier — see
 * src/review/report-policy.ts. Duplicate kinds in one report are allowed.
 *
 * `what_was_done` is the pre-split narrative; it still stores and still
 * renders on Landing as "What was done". Do not migrate stored reports.
 *
 * Questions/decisions are NOT sections here — they live on RaisedItem; the
 * report may reference their ids via `raised_item_ids`.
 *
 * Extension point for present-review-changes: optional `presentation` on the
 * report declares how the Changes block walks the reviewer through the diff.
 * See docs/design/present-review-changes.md.
 */
export type TurnReportSectionKind =
  | 'capabilities_lost'
  | 'behavior_change'
  | 'implementation'
  | 'what_was_done'
  | 'how_to_verify'
  | 'commentary';

export interface TurnReportSection {
  kind: TurnReportSectionKind;
  /** Markdown body. */
  body: string;
}

/** Visual / default-collapse weight — does NOT determine group order. */
export type PresentationTier =
  | 'core'
  | 'tests'
  | 'docs'
  | 'generated'
  | 'other';

export interface ReviewPresentation {
  /**
   * Agent-ordered walkthrough groups. A presentation must carry groups or
   * screenshots (or both) — an empty presentation is invalid at the boundary.
   */
  groups: PresentationGroup[];
  /**
   * Images the agent wants the reviewer to see FIRST — a screenshot of the UI,
   * TUI or CLI output it built. Each names a task artifact that must already
   * exist and be an image; the review page renders them above everything else.
   */
  screenshots?: PresentationScreenshot[];
}

/** One screenshot: a task artifact name plus the caption shown under it. */
export interface PresentationScreenshot {
  /** Artifact name on THIS task, as attached via `lazy_artifact_add`. */
  artifact: string;
  caption?: string;
}

export interface PresentationGroup {
  id?: string;
  title: string;
  summary?: string;
  tier: PresentationTier;
  items: PresentationItem[];
}

export type PresentationItem =
  | PresentationSnippet
  | PresentationFile
  | PresentationProse;

export interface PresentationSnippet {
  kind: 'snippet';
  file: string;
  start: number;
  end: number;
  side?: 'old' | 'new';
  note?: string;
}

export interface PresentationFile {
  kind: 'file';
  /**
   * A changed file's path, OR a pattern claiming several of them as one item:
   * a directory (`src/review/`) or a glob (`test/e2e/regions*.test.ts`).
   * A release-sized walkthrough is only writable because a 40-file test mass
   * can cost one slot instead of forty.
   */
  file: string;
  note?: string;
  /**
   * The diff paths a PATTERN claimed, resolved against the task's diff range
   * at store time and persisted here. Absent on a literal path, which claims
   * itself.
   *
   * Persisted rather than re-matched on read so the partition is STABLE: a
   * commit landing after the walkthrough was written must not silently move
   * files into a signed-off region (the sign-off stales only when the
   * signed-off group's OWN files change).
   */
  matched?: string[];
}

export interface PresentationProse {
  kind: 'prose';
  body: string;
}

/**
 * Which presentation cap a refused walkthrough exceeded.
 *
 * Only the caps that genuinely SHRINK a walkthrough are here, because this is
 * what the reviewer's "the walkthrough was cut down to fit" line is derived
 * from: hitting one of these means the agent had to leave something out, and
 * files may be unassigned for that reason rather than by choice. A snippet
 * that is too long or a thirteenth screenshot cannot push a file into the
 * residual, so those stay ordinary validation errors — named at the item the
 * agent must fix, and never reported to a reviewer as an incomplete partition.
 */
export type PresentationCapName =
  /** `kind: 'file'` items across all groups — a path plus a note. */
  | 'file_items'
  /** `kind: 'snippet'` and `kind: 'prose'` items — context the reader pays for. */
  | 'narrative_items'
  | 'groups';

/** A cap a walkthrough exceeded, recorded on the turn report it was sent with. */
export interface PresentationCapRefusal {
  cap: PresentationCapName;
  /** The cap's value. */
  limit: number;
  /** What the refused walkthrough declared. */
  actual: number;
  created_at: number;
}

export interface TurnReport {
  id: string;
  task_id: string;
  /** Session that wrote it — primary link to the agent turn that follows. */
  session_id: string;
  /**
   * Best-effort turn sequence once the work turn is recorded.
   * Absent until reconciler stamps it; readers that only have session_id still work.
   */
  turn_sequence?: number | null;
  /** Agent-chosen order — storage and MCP keep this; renderers apply policy. */
  sections: TurnReportSection[];
  /** Raised-item ids this report refers to (informational; not an accept gate). */
  raised_item_ids?: string[];
  /** Optional agent-declared walkthrough for the Changes block on review. */
  presentation?: ReviewPresentation;
  /**
   * Branch HEAD when {@link presentation} was declared.
   *
   * The regeneration key: a walkthrough describes a diff, so it goes stale only
   * when the diff moves. The daemon reads the task's worktree at `lazy_report`
   * time and stamps it here, and the next launch hands it to the supervisor,
   * which re-runs the presentation step only when HEAD has moved past it.
   *
   * DELIBERATELY NOT a field on `ReviewPresentation`: that object is normalized
   * straight out of agent input, so a SHA living there would be agent-writable
   * — and an agent that could name the head its walkthrough was written against
   * could suppress its own presentation step. This one is stamped by the
   * daemon and never read from the tool's arguments.
   *
   * Absent on reports written before this existed, which reads as "unknown" and
   * makes the step run — the safe direction.
   */
  presentation_head_sha?: string;
  /**
   * A walkthrough this task's agent sent that was REFUSED for exceeding a cap.
   *
   * Recorded so the cap is visible to the REVIEWER, not only to the agent that
   * hit it: a refusal the agent quietly worked around (naming files in prose
   * instead of claiming them) looks exactly like a walkthrough that chose to
   * leave them unassigned. Kept when a later report replaces this row without
   * one — it is history, and the smaller walkthrough that followed is the
   * thing it explains.
   */
  presentation_cap_refusal?: PresentationCapRefusal;
  created_at: number;
  /** Set when the agent replaces the report mid-session (latest-wins). */
  updated_at?: number;
}

/** Caller input when upserting a turn report (latest-wins per session). */
export interface TurnReportInput {
  session_id: string;
  sections: TurnReportSection[];
  raised_item_ids?: string[];
  turn_sequence?: number | null;
  presentation?: ReviewPresentation;
  /** See {@link TurnReport.presentation_head_sha} — daemon-stamped, never agent input. */
  presentation_head_sha?: string;
  /**
   * Record a REFUSED walkthrough's cap alongside the sections that arrived
   * with it. Omitting it never clears one already on the row.
   */
  presentation_cap_refusal?: PresentationCapRefusal;
}

/**
 * Per-file / per-maintain-group keep justification from a nudge turn.
 *
 * INVARIANT: justification NEVER auto-approves a protected file — it feeds the
 * reviewer. Revert is proven by git re-detect, not declared here.
 * decision is always 'keep' in v1 (room to grow).
 */
export type FileDecisionScope = 'protected' | 'maintain';

export interface FileDecision {
  id: string;
  task_id: string;
  session_id?: string | null;
  scope: FileDecisionScope;
  /** File path (protected) or maintain group title (maintain). */
  target: string;
  decision: 'keep';
  reason: string;
  created_at: number;
}

export interface FileDecisionInput {
  scope: FileDecisionScope;
  target: string;
  reason: string;
  session_id?: string | null;
}

/**
 * Which direction an artifact travels: an INPUT is a file handed TO the task
 * (design assets, a spec, a data fixture); an OUTPUT is a file the task
 * PUBLISHED back (a report, a rendered image, a data dump).
 *
 * The distinction is descriptive, not a permission: both are stored, bounded
 * and retrieved identically. It exists so a human scanning `lazy artifact list`
 * can tell "what I gave it" from "what it gave me" without reading names.
 */
export type TaskArtifactOrigin = 'input' | 'output';

/**
 * A named file attached to a task.
 *
 * WHY THIS EXISTS: before artifacts, the only way to hand a task a file was to
 * paste its content into a comment under an ad-hoc `=== FILE: path ===` header
 * and ask the agent to re-materialize it. That has no integrity check, cannot
 * carry binary, is bounded only by the comment surface, pollutes the notes the
 * agent is told to act on, and has to be re-explained every single time.
 *
 * INVARIANT: an artifact is DATA, never guidance. Attaching one must not create
 * a comment, change status, or trigger a turn — same non-triggering property as
 * follow-ups and for the same reason. Artifact *content* is never injected into
 * a prompt; the agent is told only that artifacts exist and where to read them
 * (see `buildArtifactNotice`). A file the human wants acted on is a comment.
 *
 * INVARIANT: one name, one artifact. Re-attaching a name REPLACES it — there is
 * deliberately no versioning, no dedup and no external blob backend. Artifacts
 * are inputs and outputs, not a blob store: `src/artifacts/limits.ts` bounds
 * per-file size, per-task total and per-task count, because unbounded per-task
 * growth is exactly what broke a real store once (the proxy audit log).
 */
export interface TaskArtifact {
  id: string;
  task_id: string;
  /**
   * Relative POSIX path within the task's artifact space, e.g.
   * `design/index.html`. Validated by `normalizeArtifactName` — never absolute,
   * never containing `..`, and safe to join onto a worktree path.
   */
  name: string;
  /** Decoded content length in bytes. */
  size: number;
  /** Hex SHA-256 of the decoded content — the integrity check comments lacked. */
  sha256: string;
  mime_type: string;
  /** True when the content is not valid UTF-8 text (images, archives, …). */
  binary: boolean;
  origin: TaskArtifactOrigin;
  created_at: number;
  created_by: Actor;
  /** The agent run that published this artifact, when one did. */
  session_id?: string | null;
}

/** An artifact plus its content, base64-encoded for JSON transport. */
export interface TaskArtifactContent extends TaskArtifact {
  /** Base64 of the raw bytes — base64 regardless of `binary`, so one decode path serves both. */
  content_base64: string;
}

/** What a caller supplies to attach an artifact. */
export interface TaskArtifactInput {
  name: string;
  /** Base64 of the raw bytes. */
  content_base64: string;
  /** Sniffed from the extension when omitted. */
  mime_type?: string;
  /** Defaults to 'input'. */
  origin?: TaskArtifactOrigin;
  session_id?: string | null;
}

/**
 * Which side of a diff a review comment is anchored to. 'new' is the
 * post-change side (added/context lines); 'old' is the pre-change side
 * (removed/context lines).
 */
export type ReviewCommentSide = 'old' | 'new';

/** Who wrote a review comment. */
export type ReviewCommentRole = 'human' | 'agent';

/**
 * Delivery state of a human review comment that was dispatched to the task's
 * agent as a read-only `ask` turn.
 *
 * - 'pending'  — persisted, ask in flight (or queued behind another ask)
 * - 'answered' — the agent replied; the reply is a sibling comment in the thread
 * - 'failed'   — the ask could not be delivered. The comment is STILL persisted
 *                and visible; `ask_error` says why. Never a silent loss.
 */
export type ReviewCommentAskState = 'pending' | 'answered' | 'failed';

/**
 * What the reviewer meant by a message, chosen per message.
 *
 * - 'ask'     — a question. Dispatched to the agent as a read-only ask turn as
 *               soon as the worktree is free; the answer joins the thread.
 * - 'comment' — a change request or note. NOT dispatched. It accumulates and is
 *               delivered later, batched with every other undelivered comment,
 *               inside ONE unblock work turn.
 *
 * INVARIANT: a comment must never become a work turn on its own. That is the
 * behaviour of the legacy `Comment` entity (one comment = one agent turn) and
 * it is the thing this model deliberately replaces: a reviewer marking up ten
 * lines should produce one turn, not ten. This mirrors how lazy already treats
 * forge PR comments — collect, then react in batch.
 */
export type ReviewCommentIntent = 'ask' | 'comment';

/**
 * Delivery state of a 'comment'-intent review comment.
 *
 * - 'pending_delivery' — durable and visible, waiting for the next unblock
 * - 'delivered'        — carried into an unblock work turn (`delivered_turn`)
 *
 * Only ever advances on a turn that actually launched, so a failed unblock
 * leaves the comment pending for the next attempt rather than losing it.
 */
export type ReviewCommentDeliveryState = 'pending_delivery' | 'delivered';

/**
 * A review comment anchored to a line of a task's diff, threaded so a reviewer
 * and the task's agent can hold a conversation about that line.
 *
 * INVARIANT: review comments are a SEPARATE store from `Comment`. Comments feed
 * the daemon's comment auto-react loop (auto-deliver.ts), which would kick the
 * agent into an unsolicited work turn. A review comment is dispatched
 * explicitly and only as a read-only `ask`, so it must never enter that loop.
 * This mirrors why raised items are their own store — see CLAUDE.md.
 *
 * INVARIANT: the anchor (file/line/side) and the thread are durable. The
 * comment is persisted BEFORE any ask dispatch that could fail, so human
 * feedback that never reached the agent still exists and is still visible.
 */
export interface ReviewComment {
  id: string;
  task_id: string;
  /**
   * Thread identity. The first (root) comment of a thread carries its own id
   * here; every reply — human or agent — repeats the root's id.
   */
  thread_id: string;
  /**
   * Anchor path: usually a repo-relative path from the diff, but may be the
   * task-level sentinel `'(task)'` for questions about the work as a whole.
   * See `TASK_LEVEL_REVIEW_ANCHOR` in `src/review/task-level-anchor.ts`.
   */
  file: string;
  /**
   * 1-based line number within `side` for diff-anchored comments, or `0` for
   * task-level comments (whose file is the `'(task)'` sentinel).
   */
  line: number;
  side: ReviewCommentSide;
  role: ReviewCommentRole;
  content: string;
  created_at: number;
  actor?: Actor;
  /**
   * What the reviewer meant (human messages only; absent on agent replies).
   * Absent on human messages written before intents existed — read those as
   * 'ask', which is what they were.
   */
  intent?: ReviewCommentIntent;
  /** Set on human 'ask'-intent comments. */
  ask_state?: ReviewCommentAskState;
  /** Why the ask failed. Present only when ask_state === 'failed'. */
  ask_error?: string;
  /** Set on human 'comment'-intent comments. */
  delivery_state?: ReviewCommentDeliveryState;
  /** Session turn number of the unblock turn that carried this comment. */
  delivered_turn?: number;
  /** When the comment was carried into that turn, in ms since epoch. */
  delivered_at?: number;
  /** Session turn number of the agent's answering turn, when known. */
  turn_number?: number;
  /**
   * The task this discussion was promoted into, recorded on the thread's ROOT
   * comment. Set once and never cleared — like a raised item's
   * `promoted_task_id`, it is the durable link back, and it is what stops the
   * same conversation being promoted twice by two reviewers.
   */
  promoted_task_id?: string;
  /** Listing code of that task, when it has one. */
  promoted_task_code?: string;
  /**
   * The diff line the comment was anchored to, captured at post time. Keeps the
   * thread readable after the agent changes the file and the line moves — the
   * reviewer still sees what they commented on.
   */
  anchor_snippet?: string;
  /**
   * When the reviewer withdrew this message, in ms since epoch. Set only on the
   * reviewer's OWN messages, and only while nothing has reached the agent (a
   * queued comment, or a question whose ask failed). A withdrawn message keeps
   * its record and its place in the thread — it is retracted, not deleted — but
   * is excluded from the queue, the counts, and any future unblock prompt.
   *
   * INVARIANT: one-way. There is no un-withdraw; a reviewer who changes their
   * mind posts again. This is a deliberately narrow, additive widening of the
   * "a review comment's words are immutable" rule: a human retracting their own
   * words before anyone read them is not feedback being lost.
   */
  withdrawn_at?: number;
  /**
   * When this message was FILED — carried out of the reviewer's in-progress
   * review by the unblock or accept that ended it, in ms since epoch.
   *
   * Asks are answered as they are posted, so nothing in `ask_state` ever says
   * "this round of review is over". Without that, the Current review page
   * listed every question the reviewer had ever asked, forever, as if each one
   * were still open business.
   *
   * INVARIANT: filing RECORDS, it never discards. The message, its answer and
   * its delivery state all stay exactly as they were and stay visible — a
   * filed ask is moved, not deleted (CLAUDE.md, "Never Lose Human Feedback").
   * One-way, like `withdrawn_at`: set once, never cleared.
   */
  filed_at?: number;
}

/** Caller-supplied fields when creating a review comment. */
export interface ReviewCommentInput {
  threadId?: string;
  file: string;
  line: number;
  side: ReviewCommentSide;
  role: ReviewCommentRole;
  content: string;
  actor?: Actor;
  intent?: ReviewCommentIntent;
  askState?: ReviewCommentAskState;
  deliveryState?: ReviewCommentDeliveryState;
  turnNumber?: number;
  anchorSnippet?: string;
}

/**
 * Mutable fields of a review comment: delivery bookkeeping, plus withdrawal.
 *
 * The body, the anchor and the intent are absent on purpose — those are
 * immutable once written. `withdrawnAt` is the single exception, and it is
 * one-way: it may be set, never cleared, and there is no `ReviewCommentInput`
 * counterpart because a comment cannot be born withdrawn.
 */
export interface ReviewCommentUpdate {
  askState?: ReviewCommentAskState;
  askError?: string | null;
  deliveryState?: ReviewCommentDeliveryState;
  deliveredTurn?: number;
  deliveredAt?: number;
  turnNumber?: number;
  withdrawnAt?: number;
  /** One-way, like `withdrawnAt`: the review that carried this was filed. */
  filedAt?: number;
  /** One-way: the discussion in this thread was promoted into this task. */
  promotedTaskId?: string;
  /** One-way: that task's listing code. */
  promotedTaskCode?: string;
}

/** Whether a UI builder review session is idle or has a turn in flight. */
export type ReviewSessionStatus = 'idle' | 'turn_in_flight';

/** Who authored a message in a builder review session transcript. */
export type ReviewSessionMessageRole = 'human' | 'assistant' | 'system';

/**
 * Launch bookkeeping for a review-session message.
 *
 * Human compose-box messages are appended with `pending` BEFORE any builder
 * launch that could fail — the same never-lose-feedback invariant as review
 * comments. Launch success moves to `launched`; failure stays visible as
 * `failed` rather than rolling the message back.
 */
export type ReviewSessionMessageDelivery = 'pending' | 'launched' | 'failed';

/** One line in a task-scoped builder review session transcript. */
export interface ReviewSessionMessage {
  id: string;
  role: ReviewSessionMessageRole;
  content: string;
  created_at: number;
  delivery: ReviewSessionMessageDelivery;
}

/**
 * Durable record for the web "Review with builder" conversation on one task.
 *
 * v1: exactly one session per task. The lazy-minted `id` exists before any
 * agent runs so compose-box writes and recovery files can point at stable
 * storage. Claude's `--resume` target lives in `resume_session_id`.
 *
 * INVARIANT: human messages are appended independently of launch success.
 * See CLAUDE.md "Never Lose Human Feedback".
 */
export interface ReviewSession {
  id: string;
  task_id: string;
  status: ReviewSessionStatus;
  resume_session_id: string | null;
  created_at: number;
  updated_at: number;
  messages: ReviewSessionMessage[];
}

/** Fields supplied when appending a review-session message. */
export interface ReviewSessionMessageInput {
  role: ReviewSessionMessageRole;
  content: string;
  /**
   * Defaults to `pending` for human messages and `launched` for assistant/system
   * — assistant replies are written only after a turn completes.
   */
  delivery?: ReviewSessionMessageDelivery;
}

/** Mutable session fields — status and Claude resume target only. */
export interface ReviewSessionUpdate {
  status?: ReviewSessionStatus;
  resumeSessionId?: string | null;
}

/** Mutable message fields — delivery bookkeeping only; content is immutable. */
export interface ReviewSessionMessageUpdate {
  delivery?: ReviewSessionMessageDelivery;
}

/**
 * A review in progress: everything the reviewer has typed or ticked but not
 * yet sent, held server-side per task so it survives navigating away, a second
 * tab, or a different browser on the same daemon.
 *
 * INVARIANT (CLAUDE.md "Never Lose Human Feedback"): the drafts here are human
 * words that have not been delivered anywhere. They are written on input,
 * before any action that can fail, and cleared only once the action they belong
 * to has actually succeeded.
 *
 * `viewed_files` maps a file's path to the CONTENT HASH it had when the
 * reviewer ticked it viewed — never a bare boolean. A tick that outlived its
 * change would assert a file had been read when it had not, so a file whose
 * hash no longer matches comes back unviewed. That is the one piece of this
 * record which is reading state rather than unsent words; it lives here anyway
 * because "which files have I already been through" is the other half of a
 * review in progress, and losing it on a tab switch costs the same re-read.
 */
export interface ReviewDraftState {
  task_id: string;
  /**
   * Which reviewer this belongs to: the actor's user id when the daemon could
   * attribute the caller to a person (a per-user token, as Lazy Teams sends),
   * or `local` for the single-IC case — the CLI, and the daemon's own review
   * page, which has no login. NOT a multi-user model: it is one key so two
   * signed-in reviewers do not overwrite each other's words.
   */
  reviewer: string;
  /** Unblock feedback the reviewer has typed but not sent. */
  feedback: string;
  /** Accept reason the reviewer has typed but not sent. */
  accept_reason: string;
  /** Builder review-session message typed into the composer but not sent. */
  session_message: string;
  /** file path → content hash at the moment it was ticked viewed. */
  viewed_files: Record<string, string>;
  /**
   * Half-typed line/prose/presented comments: anchor key → the words in the box.
   *
   * The same "unsent words are human feedback" rule as `feedback` above, for
   * the boxes that are opened against one line of the diff or one block of the
   * agent's report. Kept because the page re-renders underneath them —
   * expanding context, switching layout — and used to take the typing with it.
   * The key is built and read only by the review island (anchor side, line,
   * thread id and file); the daemon stores it opaquely.
   */
  line_drafts: Record<string, string>;
  updated_at: number;
}

/**
 * Fields to write on a review draft. An omitted key is left untouched, so
 * autosaving the feedback box never clears the accept reason or the viewed
 * ticks. Clearing a draft is writing `''` (or `{}` for the ticks).
 */
export interface ReviewDraftPatch {
  feedback?: string;
  acceptReason?: string;
  sessionMessage?: string;
  viewedFiles?: Record<string, string>;
  /**
   * Anchor key → half-typed comment text, MERGED per key — the one patch field
   * that is not applied wholesale. An empty string deletes that anchor's draft;
   * an anchor the patch does not name is left exactly as stored, so a second
   * tab autosaving its own box cannot erase the first tab's.
   */
  lineDrafts?: Record<string, string>;
}

/**
 * Persistent record that a reviewer has marked a hunk as reviewed in
 * `lazy browse -i`. Keyed by a content hash (see `src/utils/hunk-hash.ts`)
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
  usage: AgentTokenUsage;
  /**
   * Concrete model id the agent reported for this invocation, when it reports
   * one. Normalized by the agent implementation — absent means the agent's
   * output carried no model identity, NOT that a default should be assumed.
   * Recorded on the turn as `Turn.model_id`.
   */
  model_id?: string;
}

/**
 * Why a wait interval ended.
 *
 * There is deliberately no `abandoned` variant for "the MCP client disconnected
 * mid-call": the daemon finishes such a call anyway (complete-anyway semantics),
 * so from the wait's point of view it settled normally and its duration still
 * belongs to the turn. A wait that genuinely never settled is recorded by the
 * ABSENCE of an end record (`ended_at: null`), not by an outcome.
 */
export type WaitOutcome = 'completed' | 'error';

/**
 * One stretch of wall-clock an agent spent BLOCKED on another task, recorded
 * from the daemon's own view of an in-flight blocking MCP call (`lazy_wait`,
 * `lazy_ask`) — never from parsing agent output.
 *
 * This is time the agent was not working. Duration/economics reports must be
 * able to subtract it from a turn's wall-clock, otherwise an agent that
 * decomposed its work into subtasks looks arbitrarily slower than one that did
 * everything inline.
 *
 * `ended_at: null` is a first-class readable state, not corruption: the turn (or
 * the daemon) died mid-wait. Consumers should treat such an interval as open —
 * bounded above by the turn's end — rather than discarding it.
 */
export interface WaitInterval {
  /** Unique id for this wait; the start and end records are folded on it. */
  id: string;
  /** The WAITING task (the caller), not the task being waited on. */
  task_id: string;
  /** Session the wait happened in, or null when the task had no session. */
  session_id: string | null;
  /**
   * Sequence the in-flight turn is expected to be recorded under (the next
   * unused sequence at the moment the wait started). Best-effort attribution:
   * agent turns are only written when the turn ends, so nothing with a
   * guaranteed sequence exists yet. Consumers that need certainty should
   * attribute by time overlap with the turn's own window and use this as a
   * hint. Null when the sequence could not be determined.
   */
  turn_sequence: number | null;
  /** MCP tool that blocked, e.g. `lazy_wait`. */
  tool: string;
  /** Task ids being waited on (an array — `lazy_wait` can race several). */
  waited_on: string[];
  /** Display labels (code or short id) for `waited_on`, same order. */
  waited_on_labels: string[];
  /** ISO timestamp the blocking call started. */
  started_at: string;
  /** ISO timestamp it settled, or null when it never did. */
  ended_at: string | null;
  /** How it settled, or null while open. */
  outcome: WaitOutcome | null;
}
