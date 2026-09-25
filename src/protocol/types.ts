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

import type { TokenUsage, AgentTokenUsage, MergeConflict, FileViolation } from '../types';
import type { MaintainEntry, ReactEntry } from '../config/types';
import type { AgentFailureClass } from '../agent/failure-taxonomy';

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
export const PROTOCOL_VERSION = 4;

/**
 * Correlation id carried on every supervisor-bound command and echoed on its
 * response. The protocol dir is a single-slot mailbox — without this, a
 * synchronous waiter cannot tell whether `response.json` answers its command.
 */
export type CommandId = string;

// --- Command (host → supervisor) ---

export type CommandType = 'start' | 'unblock' | 'ask' | 'sync' | 'stop' | 'review' | 'accept_gate';

/*
 * `agent_id` vs `harness` on a command — they answer different questions.
 *
 * `agent_id` is the PROFILE the turn was launched under (`[agents.<name>]` in
 * lazy.toml: harness + model + endpoint + credential). It is what the human or
 * the builder selected, it is what the task record stores, and it is what the
 * response echoes back and what a failed-invocation record keeps — a task on
 * `local-ollama-pi` must report itself as that, not as `pi`.
 *
 * `harness` is which agent BINARY runs, and it is the only one the supervisor
 * can act on: `getAgent()` / `getAgentPackaging()` are registry lookups, and the
 * registry holds harnesses. The daemon resolves it from the profile at dispatch
 * (it owns the project's config) and states it here rather than making every
 * supervisor site re-derive it.
 *
 * It is OPTIONAL and every reader falls back to `agent_id`: the built-in
 * profiles are named after their harnesses, so for every project that has not
 * defined a custom profile the two strings are equal and the fallback is exact.
 * That is also why this needs no PROTOCOL_VERSION bump — an older supervisor
 * ignoring an unknown field lands on the same harness it would have picked.
 */

export interface StartCommand {
  type: 'start';
  task_id: string;
  goal: string;
  prompt: string;
  /** Echoed on the response so the host can correlate a single-slot answer. */
  command_id?: CommandId;
  protocol_version?: number;   // wire protocol version — supervisor rejects on mismatch (see PROTOCOL_VERSION)
  agent_id?: string;           // which agent to use (e.g., 'claude-code', 'cursor') — defaults to 'claude-code'
  /** Harness (agent binary) the profile in `agent_id` runs. See the note above CommandType. */
  harness?: string;
  system_prompt?: string;      // static system instructions (tool usage, commit guidelines) — passed as --append-system-prompt
  model_id?: string;
  effort?: string;             // reasoning effort level — passed as --effort (Claude Code only)
  parent_branch?: string;      // upstream branch for sync (pre-turn and/or post-turn)
  /**
   * Ref `resolveUpstreamMergeRef` chose for the parent — the same base accept
   * and sync use. Written by the daemon at command dispatch; the supervisor
   * uses this (not the raw parent branch name) when filtering merge-artifact
   * protected-file violations.
   */
  upstream_merge_ref?: string;
  sync_before_work?: boolean;  // if true, sync upstream before work phase (default: false for start)
  sync_after_work?: boolean;   // if true, sync upstream after work phase
  remote_branch?: string;      // remote tracking ref to merge (e.g., "origin/lazy/abc12345") — sync-with-remote phase

  turn_started_at?: string;    // ISO timestamp — used for elapsed-time logging
  watchdog_output_timeout_ms?: number; // kill process if no output for this many ms (0 = disabled)
  wind_down_timeout_ms?: number;       // kill process this many ms after it emits its final result if it hasn't exited (0 = disabled)
  protected_patterns?: string[];      // glob patterns for file permission violation detection
  branch_point_sha?: string;          // SHA of the commit the task branched from — files not present here are task-created and exempt from permission violations
  post_turn_check?: string;           // command to run after agent work (output captured for review)
  post_turn_timeout?: number;          // timeout in seconds for post_turn_check (default: 300)
  pre_turn_hook?: string;              // setup command run in the worktree BEFORE the agent starts (`[automation] pre_turn`)
  pre_turn_timeout?: number;           // timeout in seconds for pre_turn_hook (default: 120)
  pre_turn_required?: boolean;         // if true, a failing pre_turn_hook fails the turn instead of warning
  agent_extra_args?: string[];         // extra `claude` args for the agent launch (host OS-sandbox `--settings`); see commonCommandFields
  maintain?: MaintainEntry[];          // maintained-file groups agents are nudged to keep up to date (post-turn skip check + up-front context)
  react?: ReactEntry[];                // reactive automations: pattern match → one-shot follow-up with instructions
  low_high_loop?: LowHighLoopSettings; // EXPERIMENTAL two-phase turn — see LowHighLoopSettings
  /** Closing steps for this turn, by how it ends — see WrapUpPlan. */
  wrap_up?: WrapUpPlan;
  /** Base SHA the wrap-up phase scans from — see WrapUpPlan docs. */
  base_sha?: string;
}

export interface UnblockCommand {
  type: 'unblock';
  task_id: string;
  goal: string;
  prompt: string;
  /** Echoed on the response so the host can correlate a single-slot answer. */
  command_id?: CommandId;
  protocol_version?: number;   // wire protocol version — supervisor rejects on mismatch (see PROTOCOL_VERSION)
  agent_id?: string;           // which agent to use (e.g., 'claude-code', 'cursor') — defaults to 'claude-code'
  /** Harness (agent binary) the profile in `agent_id` runs. See the note above CommandType. */
  harness?: string;
  system_prompt?: string;      // static system instructions (tool usage, commit guidelines) — passed as --append-system-prompt
  model_id?: string;
  effort?: string;             // reasoning effort level — passed as --effort (Claude Code only)
  agent_session_id?: string;  // resume existing agent session
  parent_branch?: string;      // upstream branch for sync (pre-turn and/or post-turn)
  /**
   * Ref `resolveUpstreamMergeRef` chose for the parent — see StartCommand.
   */
  upstream_merge_ref?: string;
  sync_before_work?: boolean;  // if true, sync upstream before work phase
  sync_after_work?: boolean;   // if true, sync upstream after work phase
  remote_branch?: string;      // remote tracking ref to merge (e.g., "origin/lazy/abc12345") — sync-with-remote phase

  /**
   * Agent permission mode for this turn. When 'plan', the agent runs read-only
   * (no writes, no commits) — used by `lazy browse -i` for Q&A against the
   * agent's session. Omitted/undefined means the default (unconstrained) mode.
   */
  permission_mode?: 'plan' | 'default';

  turn_started_at?: string;    // ISO timestamp — used for elapsed-time logging
  watchdog_output_timeout_ms?: number; // kill process if no output for this many ms (0 = disabled)
  wind_down_timeout_ms?: number;       // kill process this many ms after it emits its final result if it hasn't exited (0 = disabled)
  protected_patterns?: string[];      // glob patterns for file permission violation detection
  branch_point_sha?: string;          // SHA of the commit the task branched from — files not present here are task-created and exempt from permission violations
  post_turn_check?: string;           // command to run after agent work (output captured for review)
  post_turn_timeout?: number;          // timeout in seconds for post_turn_check (default: 300)
  pre_turn_hook?: string;              // setup command run in the worktree BEFORE the agent starts (`[automation] pre_turn`)
  pre_turn_timeout?: number;           // timeout in seconds for pre_turn_hook (default: 120)
  pre_turn_required?: boolean;         // if true, a failing pre_turn_hook fails the turn instead of warning
  agent_extra_args?: string[];         // extra `claude` args for the agent launch (host OS-sandbox `--settings`); see commonCommandFields
  maintain?: MaintainEntry[];          // maintained-file groups agents are nudged to keep up to date (post-turn skip check + up-front context)
  react?: ReactEntry[];                // reactive automations: pattern match → one-shot follow-up with instructions
  low_high_loop?: LowHighLoopSettings; // EXPERIMENTAL two-phase turn — see LowHighLoopSettings
  /** Closing steps for this turn, by how it ends — see WrapUpPlan. */
  wrap_up?: WrapUpPlan;
  /** Base SHA the wrap-up phase scans from — see WrapUpPlan docs. */
  base_sha?: string;
}

/**
 * One step of the final-turn wrap-up phase, in the order the supervisor runs
 * them (final-turn design §3.3). Which of these a task actually gets is decided
 * by the DAEMON from the task's audience (`audienceOf`, src/task/audience.ts)
 * at command dispatch — the supervisor runs the steps it is handed and never
 * derives a plan itself.
 */
export type WrapUpStep =
  | 'permission_pushback'
  | 'maintain'
  | 'react'
  | 'commit_leftovers'
  | 'present';

/**
 * The wrap-up plan a work turn carries (start/unblock only — ask, sync and
 * review turns have no wrap-up phase).
 *
 * The plan rides on every work command because the turn's ENDING is not known
 * when the command is written: the agent declares (or does not) during the
 * turn. So the daemon sends BOTH lists and the supervisor picks by what
 * actually happened — it never derives a plan itself.
 *
 * - {@link steps} runs when the turn ended with a `lazy_final` — pencils down,
 *   the full reader-facing closing chain (final-turn design §3.3).
 * - {@link park_steps} runs when it did NOT: the turn left a blocking raise, or
 *   just stopped. This is the presentation-on-every-human-facing-park rule: a
 *   human being asked to decide gets the walkthrough whichever way the turn
 *   ended, because the walkthrough exists to INFORM that decision. Everything
 *   else in the chain still belongs to the final alone.
 *
 * `base_sha` (on the same commands) is the concrete SHA of the base this task's
 * own diff is rendered against — the daemon resolves it through
 * `resolveTaskDiffBase`, the same resolution the reviewer's diff uses. The
 * wrap-up phase's scans run over `base_sha..HEAD` — the task's own range, not
 * the turn window (§3.4) — so the push-back sees exactly what the reviewer
 * sees. When omitted (resolution failed), the supervisor falls back to the
 * turn window rather than refusing the scan.
 */
export interface WrapUpPlan {
  /** Steps for a turn that declared `lazy_final`. */
  steps: WrapUpStep[];
  /**
   * Steps for a turn that parked WITHOUT a final — needs-input or plain
   * blocked. Today this is `['present']` on a human-audience task that is not
   * a hub, and empty otherwise.
   *
   * Optional on the wire only so a daemon/supervisor version skew degrades to
   * the old behaviour (no park steps) rather than crashing.
   */
  park_steps?: WrapUpStep[];
  /**
   * HEAD when the walkthrough now on record was declared, or absent when the
   * task has none.
   *
   * The regeneration rule, handed to the supervisor as a COMPARISON rather than
   * a decision: the `present` step re-authors only when HEAD has moved since
   * the stored walkthrough was written. A park that changed nothing is shown
   * the walkthrough that already exists, and costs no model turn.
   */
  presented_sha?: string;
}

/**
 * EXPERIMENTAL "low-high loop" settings for a work turn (start/unblock only —
 * ask, sync and wrap-up turns never run the loop).
 *
 * When present, the command's `effort` field IS the draft/revise effort (the
 * work phase runs at it), and after the work phase the supervisor runs one
 * bounded review→revise cycle in the same agent session:
 *   1. self-review at `review_effort` in plan mode (instructions only, no writes)
 *   2. unless the review approved, one revise invocation back at the command's
 *      `effort` applying those instructions.
 * Absent → normal single-shot turn, byte-for-byte unchanged behavior.
 */
export interface LowHighLoopSettings {
  /** Reasoning effort for the self-review phase (e.g. "xhigh"). */
  review_effort: string;
}

/**
 * Ask command — a read-only "ask turn" against an existing agent session.
 *
 * Used by `lazy browse -i` so a reviewer can ask questions of the agent while
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
  /** Echoed on the response so the host can correlate a single-slot answer. */
  command_id?: CommandId;
  protocol_version?: number;   // wire protocol version — supervisor rejects on mismatch (see PROTOCOL_VERSION)
  agent_id?: string;
  /** Harness (agent binary) the profile in `agent_id` runs. See the note above CommandType. */
  harness?: string;
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
  pre_turn_hook?: string;
  pre_turn_timeout?: number;
  pre_turn_required?: boolean;
  agent_extra_args?: string[];         // extra `claude` args for the agent launch (host OS-sandbox `--settings`); see commonCommandFields
  maintain?: MaintainEntry[];
  react?: ReactEntry[];
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
  /** Echoed on the response so the host can correlate a single-slot answer. */
  command_id?: CommandId;
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
  /**
   * Remote tracking ref for the task's OWN branch (e.g. `origin/lazy/abc12345`),
   * set only when the host's fetch found commits the local branch lacks — a
   * colleague pushed to the task branch.
   *
   * When present the supervisor merges it FIRST, before `parent_branch`: what
   * the branch is supposed to contain is settled before approved upstream work
   * is merged on top, the same ordering the start/unblock path uses. The parent
   * branch itself is never touched by either step.
   */
  remote_branch?: string;
  agent_session_id?: string;   // existing agent session for conflict resolution
  model_id?: string;           // model for conflict resolution (if needed)
  /**
   * Reasoning effort for the conflict-resolution turn.
   *
   * Travels with `model_id` for the same reason every other command carries
   * both: a sync turn runs on the task's own effort, `task.metadata.effort`
   * (INVARIANT turn-launch-continuity, src/daemon/launch-identity.ts).
   * Omitting it made a conflict resolution — the turn most likely to need the
   * task's real effort — silently run on the agent binary's own default.
   */
  effort?: string;
  /**
   * Which agent resolves the conflicts (e.g. 'claude-code', 'cursor') —
   * defaults to 'claude-code'.
   *
   * REQUIRED for `model_id` and `agent_session_id` to mean anything: both are
   * issued by, and only valid for, one agent. A sync that carried a cursor
   * task's model and session but launched `claude` exited 1 on every attempt
   * and left the worktree wedged mid-merge, which is why all three now travel
   * together (see src/supervisor/merge.ts).
   */
  agent_id?: string;
  /** Harness (agent binary) the profile in `agent_id` runs. See the note above CommandType. */
  harness?: string;
  /**
   * Guard timeouts for the conflict-resolution agent turn. A sync that hits
   * conflicts runs a real agent turn, so it gets the same two guards as work:
   * kill on no forward progress, and a wind-down window that can only open
   * once the agent's final result has landed.
   */
  watchdog_output_timeout_ms?: number;
  wind_down_timeout_ms?: number;
}

export interface StopCommand {
  type: 'stop';
  task_id: string;
  reason?: string;
}

/**
 * Acceptance-gate command — the MECHANICAL check run at accept.
 *
 * Dispatched synchronously by the daemon's accept path (launchAcceptanceGate)
 * into a DEDICATED protocol mailbox and run in its own EPHEMERAL container: no
 * agent runs, no session is resumed, no turn is recorded. The supervisor runs
 * the configured gate commands in the task's worktree, in order, and reports
 * the outcome in the response's `accept_gate` field — the agent cannot
 * self-certify, and a failing suite can never merge.
 *
 * Deliberately minimal: no agent_id/harness/model/session fields, because
 * nothing here launches an agent. `command_id` is kept so the response is
 * correlated in logs; there is no single-slot answer to protect (the mailbox
 * belongs to this gate alone).
 */
export interface AcceptGateCommand {
  type: 'accept_gate';
  task_id: string;
  /** Echoed on the response; the gate mailbox is dedicated, so this is log hygiene, not correlation. */
  command_id?: CommandId;
  protocol_version?: number;   // wire protocol version — supervisor rejects on mismatch (see PROTOCOL_VERSION)
  /** Gate commands run in order; first non-zero exit fails the gate. */
  accept_gate_commands: string[];
  /** Timeout in seconds for EACH gate command (default 600). */
  accept_gate_timeout?: number;
}

/**
 * Review command — a read-only review turn in a NEW agent session.
 *
 * Dispatched synchronously by `lazy review` / `lazy_review` (`launchReviewTask`).
 * Same shape as an ask (plan mode, no integration machinery, daemon-owned
 * response) EXCEPT it never carries `agent_session_id`: the reviewer must not
 * resume the implementer's session, and the new session id must not be written
 * back onto the task's work session.
 */
export interface ReviewCommand {
  type: 'review';
  task_id: string;
  goal: string;
  prompt: string;
  /** Echoed on the response so the host can correlate a single-slot answer. */
  command_id?: CommandId;
  protocol_version?: number;
  agent_id?: string;
  /** Harness (agent binary) the profile in `agent_id` runs. See the note above CommandType. */
  harness?: string;
  system_prompt?: string;
  model_id?: string;
  effort?: string;
  // Deliberately no agent_session_id — a review is always a fresh session.

  turn_started_at?: string;
  watchdog_output_timeout_ms?: number;
  // Accepted so the command builder can share commonCommandFields; they are
  // no-ops on the review path (read-only plan mode).
  protected_patterns?: string[];
  post_turn_check?: string;
  post_turn_timeout?: number;
  pre_turn_hook?: string;
  pre_turn_timeout?: number;
  pre_turn_required?: boolean;
  agent_extra_args?: string[];
  maintain?: MaintainEntry[];
  react?: ReactEntry[];
}


/**
 * The authoritative merge-gate outcome carried on the gate command's response
 * (`accept_gate`, formerly `pre_accept`). `passed` false means the accept must
 * abort and the task return to its prior status; the daemon surfaces
 * `failed_command` + `output` to the human.
 */
export interface AcceptGateResult {
  passed: boolean;
  /** The first command that exited non-zero (undefined when passed). */
  failed_command?: string;
  /** Exit code of the failed command (-1 exec error, -2 timeout). */
  exit_code?: number;
  /** Captured output of the failed command (truncated). */
  output?: string;
}

export type Command = StartCommand | UnblockCommand | AskCommand | SyncCommand | StopCommand | AcceptGateCommand | ReviewCommand;

/** Supervisor-bound commands that carry a correlation id (every type except stop). */
export type CorrelatedCommand = Exclude<Command, StopCommand>;

// --- Response (supervisor → host) ---

export type ResponseStatus = 'completed' | 'error';

/**
 * Kind of a supervised follow-up invocation (see `CompletedResponse.supervised`).
 *
 * `low_high_review` / `low_high_revise` were spelled `ivan_review` /
 * `ivan_revise` before the loop was renamed. Old spellings are NOT part of this
 * union — they are normalized away at the protocol read boundary
 * ({@link normalizeSupervisedKind}), so nothing downstream has to know they
 * ever existed.
 */
export type SupervisedKind =
  | 'permission_pushback'
  | 'maintain'
  | 'react'
  | 'commit_leftovers'
  | 'present'
  | 'low_high_review'
  | 'low_high_revise'
  | 'review_reask';

export interface CompletedResponse {
  status: 'completed';
  /** Echo of the command that produced this response; absent on pre-correlation supervisors. */
  command_id?: CommandId;
  result: string;
  session_id: string;
  usage: AgentTokenUsage;
  /**
   * Launch settings THIS invocation ran under, echoed back so the reconciler can
   * stamp them on the turn it records. Per-response (not per-bundle) because a
   * bundle's supervised follow-ups are separate `claude -p` invocations and, for
   * sync, run under different settings than the work phase.
   *
   * `agent`/`model`/`effort` are what was requested (the command's `agent_id`
   * and the resolved `--model`/`--effort` values); `model_id` is the concrete id
   * the agent itself reported, present only when it reports one.
   */
  agent?: string;
  model?: string;
  model_id?: string;
  effort?: string;
  /**
   * What the agent reported about its lazy MCP tools at session start, in the
   * compact `lazy=<status> tools=<n>` form. Absent when the agent reported
   * nothing to judge (an agent that does not enumerate its tools).
   */
  mcp_tools?: string;
  /**
   * Present ONLY on a review response whose first reply had no usable verdict.
   *
   * A review's verdict is a closed set (`clean` / `needs_work` / `needs_human`)
   * because the daemon ACTS on it — auto-fix, park, count a round, gate accept.
   * When the first reply resolves to none of them the supervisor re-asks the
   * same session ONCE for the JSON block alone, single-shot exactly like the
   * maintain follow-up, and carries the answer here.
   *
   * A separate field rather than a replaced `result`: the first reply may hold
   * the reviewer's only written reasoning, and it stays the turn's content. The
   * daemon parses THIS instead only when it actually resolves to a verdict —
   * otherwise the review is recorded as FAILED and gates accept like
   * `needs_work`.
   */
  review_reask?: string;
  /** Merge conflicts captured before agent resolution (if any merges had conflicts) */
  merge_conflicts?: MergeConflict[];
  /** File permission violations detected after this invocation (FINAL set for the
   * last invocation that re-detected them; empty array means "checked, none remain"). */
  violations?: FileViolation[];
  /** Whether the agent was given a push-back chance for violations */
  pushed_back?: boolean;
  /**
   * Paths still uncommitted in the worktree when the TURN ended — after every
   * wrap-up step, including the `commit_leftovers` follow-up that asked about
   * them. Capped at {@link MAX_REPORTED_PATHS}.
   *
   * Nothing here is on the branch, so nothing here survives the worktree. The
   * field exists so that fact reaches the turn record and the review surfaces
   * without a human running `git status` in a container they may not have.
   *
   * Set on the WORK response — it describes the turn as a whole, not one
   * invocation, and is deliberately written only when the set is NON-EMPTY:
   * absent means "clean, or never scanned", and a scan that FAILED must never
   * be recorded as an empty set (see `detectUncommittedPaths`, which answers
   * null for exactly that reason).
   */
  uncommitted?: string[];
  /** Exit code of the post-turn check command (undefined if no check, -1 if exec failed, -2 if timed out) */
  check_exit_code?: number;
  /** Captured stdout+stderr from the post-turn check command (truncated to last 200 lines) */
  check_output?: string;
  /** Exit code of the pre-turn setup hook (only set when it FAILED; -1 exec error, -2 timeout) */
  pre_turn_exit_code?: number;
  /** Captured output of the failed pre-turn setup hook (truncated) */
  pre_turn_output?: string;
  /**
   * Wall-clock duration (ms) of the agent process itself — measured inside
   * the supervisor around the `work` phase. Used by LAZY_VERBOSE telemetry
   * to break ask-turn latency into agent vs supervisor vs daemon vs rpc.
   */
  agent_duration_ms?: number;
  /**
   * Per-invocation work SHA window — HEAD before/after THIS `claude -p`
   * invocation's commits. Lets the reconciler attribute each invocation's
   * commits/diff to ITS own turn (the work response's window covers only the
   * work commits; a push-back response's window covers only the push-back
   * commits). Set by the supervisor for supervised follow-ups; the work
   * response derives its SHAs from status.json instead (4-SHA pre-turn model).
   */
  start_sha_work?: string;
  end_sha_work?: string;
  /**
   * Present ONLY on supervised follow-up responses (push-back, maintain nudge).
   * Carries the kind and the prompt the SUPERVISOR authored and sent to the
   * agent. The reconciler materializes this as a `supervisor`-actored prompt
   * turn followed by the agent's reply turn — a discrete exchange, modeled the
   * same way a human→agent exchange is. Absent on the work response.
   */
  supervised?: {
    kind: SupervisedKind;
    prompt: string;
  };
  /**
   * Present ONLY on the acceptance-gate response. The authoritative gate
   * outcome: the supervisor ran `accept_gate_commands` mechanically (no agent)
   * in the task's worktree before the merge. `passed` false means the accept
   * must abort and the task return to its prior status; the daemon surfaces
   * `failed_command` + `output` to the human. Absent → this response is not
   * the gate's answer (the gate mailbox is dedicated, so anything else there
   * is foreign).
   */
  accept_gate?: AcceptGateResult;
  /**
   * Present ONLY on the upstream-merge (sync) response. Carries the outcome the
   * reconciler needs to record turns:
   *   - `merged: false` — nothing to merge (already up to date). NO turn is
   *     recorded at all; the sync leaves no trace in the turn history.
   *   - `merged: true` — a real merge happened → a single `supervisor`-actored
   *     merge turn. When `conflicts > 0` the agent was invoked to resolve them,
   *     and its conflict-resolution reply follows as responses[1] (a discrete
   *     agent turn). The supervisor authors the merge itself, so the merge turn
   *     is `supervisor`-actored — never `agent` and never `human`.
   */
  sync?: {
    merged: boolean;
    conflicts: number;
  };
  /**
   * Set when the supervisor rolled back a half-merged worktree it found on
   * arrival (see `WorktreeRecovery`). Carried on the response so the rollback is
   * ATTRIBUTED — the reconciler journals it against the task — instead of
   * existing only as a warning line in a container log nobody reads.
   */
  worktree_recovery?: WorktreeRecovery;
  /**
   * End-of-turn journal entries and follow-ups the agent left in its handoff
   * file because the `lazy_*` tools were unreachable (see `AgentHandoffEntry`).
   */
  agent_handoff?: AgentHandoffEntry[];
  /**
   * PENCILS DOWN: this invocation's agent declared the task's work finished.
   *
   * Read by the supervisor off `final.json` in the protocol dir (see
   * src/protocol/final-marker.ts), which the `lazy_final` MCP handler wrote in
   * the daemon. Present only on the invocation that declared it, so the
   * reconciler can record the claim on the TURN that made it — a final is a
   * claim about a SHA, not a property of the bundle.
   */
  final?: FinalDeclaration;
}

/**
 * What an agent declared when it called `lazy_final` (or wrote a
 * `{"kind":"final"}` handoff entry because its tools were down).
 *
 * Deliberately not `FinalClaim`: the ACTOR and the person behind it are the
 * daemon's to decide from the channel, never a field a container-side process
 * fills in. This carries only what the agent itself said.
 */
export interface FinalDeclaration {
  /** HEAD of the task branch when the claim was made. */
  sha: string;
  /** ISO timestamp the claim was recorded. */
  declared_at: string;
  /** The agent's one-line note about what it is handing over, if any. */
  note?: string;
}

/**
 * One end-of-turn record an agent wrote to its handoff file instead of through
 * an MCP tool, because the tool channel was down.
 *
 * Why this exists: the daemon MCP proxy is the agent's only channel to lazy
 * state, and when it dies mid-turn — a daemon restart moving the port, a dead
 * stdio child — the agent's retrospective has nowhere to go. Agents fell back to
 * running the lazy CLI in the container, which fails with EROFS (the repo mount
 * is read-only) and would bypass the daemon even if it could write. So instead
 * the agent appends NDJSON to a file it can always write, in its own worktree,
 * and the supervisor — which runs outside that failure mode and already owns a
 * durable, daemon-owned write channel — carries it home on the response.
 */
export interface AgentHandoffEntry {
  /**
   * `followup` is the pre-unification spelling of a non-blocking `raised`.
   *
   * `final` is pencils down — the fallback for `lazy_final` when the tool
   * channel died. It is the one kind whose `content` is optional-in-spirit: the
   * note, if the agent wrote one. A turn that lost its tools can still say the
   * work is done.
   */
  kind: 'journal' | 'followup' | 'raised' | 'final';
  content: string;
  /**
   * Only meaningful for `raised`, and only `true` does anything: an item
   * recovered from the handoff file gates accept only when the agent said so
   * explicitly. A fallback channel must not wedge a task on a typo.
   */
  blocking?: boolean;
}

/**
 * A mid-merge worktree the supervisor found before running a command, and what
 * it did about it.
 *
 * This is a destructive act: rolling back discards whatever resolution was in
 * the worktree, which may be an hour of a human's or an agent's work. It once
 * happened silently — the only trace was a reflog line reading
 * "reset: moving to HEAD" — and the merge simply vanished between two commands
 * (fix-sync-silent-conflict). So it is recorded, the discarded state is saved to
 * `.lazy/recovery/` as a patch first, and the response says so.
 */
export interface WorktreeRecovery {
  /** What was found on arrival. */
  found: 'merge_in_progress' | 'unmerged_files';
  /** Human-readable one-liner: what was found and what was done. */
  summary: string;
  /** Paths that were unmerged at the time (may be empty for a staged merge). */
  files: string[];
  /** Where the discarded worktree state was saved, when saving succeeded. */
  patch_path?: string;
  /** Why the supervisor was in the worktree (`startup`, `sync`, `turn`, …). */
  context: string;
}

/**
 * Completed-work envelope: a bundle of full `CompletedResponse` objects, one per
 * `claude -p` invocation the supervisor ran for a single command, in order.
 *
 *   responses[0]   — the work response (the agent's task work)
 *   responses[1..] — supervised follow-ups (push-back, maintain nudge), each a
 *                    FULL CompletedResponse with its own commits/SHAs, usage
 *                    (incl. cache tokens), violations, and a `supervised` block.
 *
 * Why an array and not a reduced nudge struct: each supervised exchange is a real
 * agent invocation with real cost and real commits. Flattening it to prompt+text
 * dropped usage and forced lumping all commits onto the work turn (double-count).
 * The array gives each invocation full fidelity, attributed to its own turn.
 */
export interface CompletedResponseBundle {
  status: 'completed';
  /** Echo of the command that produced this bundle; absent on pre-correlation supervisors. */
  command_id?: CommandId;
  responses: CompletedResponse[];
}

export interface ErrorResponse {
  status: 'error';
  /** Echo of the command that produced this response; absent on pre-correlation supervisors. */
  command_id?: CommandId;
  error: string;
  phase: SupervisorPhase;
  /**
   * Tokens the agent reported before the turn died, when any could be salvaged
   * from its final output (see src/supervisor/usage.ts).
   *
   * INVARIANT: a turn that spent tokens and then crashed must still be able to
   * put those tokens on a TURN record. Without this field the reconciler had no
   * usage to write on the error turn at all, so a crashed turn's cost either
   * vanished or (worse) showed up only in the session total, which is how
   * `session.total_usage > sum(turns)` gaps were produced.
   *
   * Absent means "nothing was reported" — never assume a default.
   */
  usage?: AgentTokenUsage;
  /** Process exit code (when available from agent crash) */
  exit_code?: number;
  /** Last N lines of stderr */
  stderr?: string;
  /** Error message extracted from stdout JSON (Claude Code puts errors in stdout) */
  stdout_error?: string;
  /** How long the agent ran before crashing (ms) */
  duration_ms?: number;
  /**
   * Taxonomy class of the failure that ended the turn, when the supervisor
   * stopped retrying on purpose (src/agent/failure-taxonomy.ts). A `fatal_*`
   * class tells the reconciler to BLOCK the task instead of auto-resuming it —
   * auto-resume against a dead credential or a bad model id just re-crashes.
   */
  failure_class?: AgentFailureClass;
  /** Human-readable reason paired with failure_class, shown in the error turn. */
  failure_reason?: string;
  /** How many launch attempts were made before giving up. */
  failure_attempts?: number;
  /**
   * Set ONLY when the no-progress watchdog ended the turn: the guard's limit in
   * ms, i.e. the effective `[agent] watchdog_output_timeout_ms`. Its presence is
   * how the reconciler knows to render "killed by the watchdog" rather than the
   * generic "agent crashed" — a 30-minute kill has to explain itself to whoever
   * reads the task next.
   */
  watchdog_timeout_ms?: number;
  /** Relaunch attempts the supervisor made after watchdog kills in this turn. */
  watchdog_attempts?: number;
  /** True when the killed turn had already captured a result or new commits. */
  watchdog_captured_work?: boolean;
  /**
   * Claude session id, when recoverable. Set by the supervisor on
   * GracefulExitTimeoutError so the human can `lazy unblock` after the kill
   * and pick up the conversation cleanly instead of orphaning it.
   */
  session_id?: string;
  /**
   * Launch settings the failed invocation ran under (the command's `agent_id`
   * and the requested `--model` / `--effort`). A crash turn is still an agent
   * turn, and "which agent/model crashed" is exactly the question a comparison
   * needs answered. No `model_id` counterpart: a crashed invocation produced no
   * parseable result, so the agent never self-reported one.
   */
  agent?: string;
  model?: string;
  effort?: string;
  /** See `CompletedResponse.worktree_recovery` — same field, failing turn. */
  worktree_recovery?: WorktreeRecovery;
  /**
   * See `CompletedResponse.agent_handoff` — same field, failing turn. Carried
   * here too on purpose: a watchdog kill is exactly when an agent's own account
   * of what it was doing is most worth keeping.
   */
  agent_handoff?: AgentHandoffEntry[];
  /**
   * State of the worktree's merge when the turn failed, after the supervisor
   * tried to settle it. Present on merge-phase failures so the human is told
   * whether their worktree is clean or still needs `git merge --abort`, instead
   * of finding UU files hours later (fix-sync-silent-conflict).
   */
  merge_state?: {
    settled: boolean;
    detail: string;
  };
  /**
   * True when the failed turn provably had no effect on the branch: no commits
   * between turn start and turn end, AND the worktree is clean. This lets
   * downstream consumers (reconciler, accept) skip mechanisms that
   * only make sense when the agent actually did something — asking a crashed
   * agent to "reflect on its work" is nonsensical when there is no work.
   *
   * Absence means "unknown" (older supervisor, or detection failed), not "had
   * effect" — consumers must fall back to existing behavior when undefined.
   */
  agent_had_no_effect?: boolean;
  /**
   * See `CompletedResponse.uncommitted` — same field, failing turn, and the
   * case where it matters MOST.
   *
   * A turn that crashes or is killed by the watchdog never reaches the wrap-up,
   * so nobody asks it to commit what it wrote; the edits sit in the worktree
   * with no record that they exist. That is precisely how this task's own
   * crashed turn left a CHANGELOG line behind. The failure path already runs a
   * dirty check for `agent_had_no_effect`, so the paths cost nothing extra.
   *
   * Written only when NON-EMPTY, for the same reason as on the work response: a
   * scan that could not run must not read back as a clean worktree.
   */
  uncommitted?: string[];
}

export type Response = CompletedResponse | CompletedResponseBundle | ErrorResponse;

/** Read the command id a supervisor echoed on a response, if any. */
export function responseCommandId(response: Response): CommandId | undefined {
  return response.command_id;
}

/** Attach the originating command's id to a response before writing it. */
export function attachCommandId(response: Response, commandId: CommandId | undefined): Response {
  if (!commandId) return response;
  return { ...response, command_id: commandId };
}

/** Read the correlation id from a command (every type except stop). */
export function commandCorrelationId(command: CorrelatedCommand): CommandId | undefined {
  return command.command_id;
}

/**
 * Whether a response positively correlates to an in-flight turn's command.
 *
 * Version skew: a response without `command_id`, or a record persisted before
 * correlation shipped, is never a positive match — callers fall back to their
 * owner's own rules (an ask tolerates the skew; a legacy `pre_accept` record
 * abandons).
 */
export function inFlightResponseCorrelates(
  response: Response,
  recordCommandId: CommandId | undefined,
): 'match' | 'mismatch' | 'uncorrelated' {
  if (!recordCommandId) return 'uncorrelated';
  const responseId = responseCommandId(response);
  if (!responseId) return 'uncorrelated';
  return responseId === recordCommandId ? 'match' : 'mismatch';
}

/**
 * Normalize a completed wire response to the flat array of invocation responses.
 * A bundle yields its `responses`; a bare CompletedResponse (ask, sync, recovery —
 * single-invocation paths) yields a one-element array. Callers that only need the
 * primary/work response take `[0]`.
 */
export function completedResponses(
  response: CompletedResponse | CompletedResponseBundle,
): CompletedResponse[] {
  return 'responses' in response ? response.responses : [response];
}

// --- Status (supervisor checkpoint/heartbeat) ---

export type SupervisorPhase =
  | 'idle'
  | 'reading_command'
  | 'sync_with_remote'
  | 'sync_with_remote_done'
  | 'merge_and_fix'
  | 'merge_and_fix_done'
  | 'pre_turn_hook'
  | 'pre_turn_hook_done'
  | 'work'
  | 'work_done'
  | 'low_high_review'
  | 'low_high_review_done'
  | 'low_high_revise'
  | 'low_high_revise_done'
  | 'permission_pushback'
  | 'permission_pushback_done'
  | 'maintain'
  | 'maintain_done'
  | 'react'
  | 'react_done'
  | 'commit_leftovers'
  | 'commit_leftovers_done'
  | 'present'
  | 'present_done'
  // The ONE re-ask for a review whose verdict was not one of the three values
  // the daemon acts on (src/supervisor/review-reask.ts).
  | 'review_reask'
  | 'review_reask_done'
  | 'wrap_up'
  | 'wrap_up_done'
  // The mechanical acceptance gate: the supervisor runs the configured commands
  // in its own ephemeral container — no agent, no session. Never observed by the
  // daemon's working-substate surfaces (the status lives in the gate's own
  // protocol dir, not the work mailbox).
  | 'accept_gate'
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
  /** Taxonomy class the agent assigned to this error (src/agent/failure-taxonomy.ts). */
  failure_class?: AgentFailureClass;
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
  /**
   * The claim this turn's WORK invocation made, when it made one.
   *
   * Written at the start of the wrap-up chain and read by `lazy_final` across
   * the protocol-dir seam: the daemon can see which phase it is serving but
   * not how the turn ended, because the turn-ending marker was read and
   * CLEARED by the supervisor before the closing steps ran. Without it the
   * walkthrough-step refusal cannot tell an agent re-declaring a claim that
   * already stands from one declaring for the first time where it will be
   * dropped (review c6b6cdde).
   *
   * Cleared on every turn for the same reason the marker is (§13.10): a stale
   * value would answer a later turn's question with an earlier turn's claim.
   */
  declared_final?: { sha: string; declared_at: string };
  /** PID of the supervisor process */
  pid: number;
  /** Retry count (only present when phase is 'retrying') */
  retryCount?: number;
  /** Deduplicated error log (only present when phase is 'retrying') */
  errors?: RetryError[];
  /**
   * Taxonomy class of the most recent failure (only when phase is 'retrying').
   * Presentation surfaces (watch header, `lazy show`) render this so a human can
   * tell "rate limited, still trying" from "can't reach the endpoint" at a glance.
   */
  retry_failure_class?: AgentFailureClass;
  /** Human-readable reason paired with retry_failure_class. */
  retry_failure_reason?: string;
  /** Delay before the next attempt (ms) — lets the UI say when the retry lands. */
  retry_next_delay_ms?: number;
}

// --- Legacy spellings (the loop's pre-rename names) ---

/**
 * The EXPERIMENTAL two-phase turn used to be called the "Ivan Loop", and its
 * supervised kinds and supervisor phases were spelled `ivan_*`. Those strings
 * were written into status/response files (and, through them, into everything
 * that switched on them) before the rename, so lazy must still be able to READ
 * them: a supervisor from before an upgrade is still running mid-turn, and a
 * status file it wrote must not render as "unknown phase".
 *
 * Compatibility lives HERE, at the one read boundary, and nowhere else. The
 * type unions above carry only the new spellings on purpose — a `||` check
 * scattered through the presenters is how a legacy value ends up handled in
 * three places and missed in a fourth. Nothing WRITES the old spellings any
 * more, and no store is migrated in place.
 */
const LEGACY_KIND_SPELLINGS: Readonly<Record<string, string>> = {
  ivan_review: 'low_high_review',
  ivan_review_done: 'low_high_review_done',
  ivan_revise: 'low_high_revise',
  ivan_revise_done: 'low_high_revise_done',
};

/** Map a possibly-legacy supervisor phase onto its current spelling. */
export function normalizeSupervisorPhase(phase: string): SupervisorPhase {
  return (LEGACY_KIND_SPELLINGS[phase] ?? phase) as SupervisorPhase;
}

/** Map a possibly-legacy supervised follow-up kind onto its current spelling. */
export function normalizeSupervisedKind(kind: string): SupervisedKind {
  return (LEGACY_KIND_SPELLINGS[kind] ?? kind) as SupervisedKind;
}

/**
 * Normalize a status record read off disk. Returns the same object (mutated) so
 * callers can keep treating `readStatus()` as a plain read.
 */
export function normalizeSupervisorStatus(status: SupervisorStatus): SupervisorStatus {
  if (typeof status.phase === 'string') {
    status.phase = normalizeSupervisorPhase(status.phase);
  }
  return status;
}

/** Normalize a response record read off disk (every invocation in a bundle). */
export function normalizeResponse(response: Response): Response {
  if (response.status !== 'completed') return response;
  for (const invocation of completedResponses(response)) {
    if (invocation.supervised && typeof invocation.supervised.kind === 'string') {
      invocation.supervised.kind = normalizeSupervisedKind(invocation.supervised.kind);
    }
  }
  return response;
}
