/**
 * The wrap-up phase: the supervised steps that close out a turn.
 *
 * Before this phase existed, protected-file push-back, the maintained-file
 * nudge and the reactive nudge ran on EVERY work turn. Now the plan on the
 * launch command decides, and it carries TWO lists because the daemon cannot
 * know when it writes the command how the turn will end:
 *
 *   - a turn that declared `lazy_final` runs `wrap_up.steps` — the full
 *     reader-facing chain, once, at pencils down;
 *   - a turn that parked without one runs `wrap_up.park_steps`, which today is
 *     the presentation and nothing else. A walkthrough exists to inform the
 *     human's accept decision, so it is owed on every human-facing park, not
 *     only when the agent claimed to be done.
 *
 * Detection itself did not move: every end-of-turn park resolves the
 * outstanding set with the host-side `resolveOutstandingViolations` scan over
 * the task's own range (the same scan accept's pre-flight runs), so a non-final
 * turn that touched a protected file still parks the task in `conflict` at turn
 * end — what it does not get is the supervised revert-or-justify exchange,
 * which waits for the final.
 *
 * The plan's step list is the order: protected push-back first (it may revert
 * commits), then the maintained-file nudge, then the reactive nudge — the same
 * order the chain had when it ran inline in handleWorkCommand, kept because
 * each step may commit and the later scans must see those commits. Then the
 * leftovers check, which reads the WORKING TREE rather than a committed range
 * and is therefore the only step that can see what those nudges wrote and
 * never committed (./leftovers.ts). The presentation step runs last, after all
 * of them: its declaration must be over the final file list, after everything
 * that can add files.
 *
 * The presentation step is where the presentation REQUIREMENT is enforced
 * (§6.2): its marker is cleared before the invocation, and if the report on
 * record carries no presentation afterwards the step THROWS ON A FINAL — the
 * turn fails and the task parks, exactly as a failed wrap-up step does today.
 * On a park it warns instead (see `declaredFinal`). The marker is a signal,
 * never the record (src/protocol/presentation-marker.ts). The step is skipped
 * outright when the walkthrough on record was declared at the current HEAD.
 */

import type { MaintainEntry, ReactEntry } from '../config/types';
import type { CompletedResponse, FinalDeclaration, SupervisorPhase, SupervisorStatus, WrapUpStep } from '../protocol/types';
import type { FileViolation } from '../types';
import type { Agent } from '../agent/interface';
import { runGit } from '../utils/git';
import { log, logWarn } from './log';
import { elevatedTag } from './elevated-git';
import { detectViolations, ViolationScanError } from './permissions';
import { runPermissionPushback } from './pushback';
import { detectSkippedMaintainEntries, runMaintainFollowup } from './maintain';
import { detectMatchedReactEntries, runReactFollowup } from './react';
import { detectUncommittedPaths, runLeftoversFollowup } from './leftovers';
import { carveProvenanceHint, runPresentStep } from './present';
import {
  clearPresentationMarker,
  readPresentationMarker,
} from '../protocol/presentation-marker';

/** The command fields the wrap-up steps and per-invocation launch settings need. */
export interface WrapUpCommandFields {
  task_id: string;
  agent_id?: string;
  model_id?: string;
  effort?: string;
  agent_extra_args?: string[];
  /**
   * Concrete SHA of the task's own diff base (final-turn design §3.4),
   * resolved daemon-side via resolveTaskDiffBase before the turn launched.
   * When present, every wrap-up scan runs over `base_sha..HEAD` — the task's
   * own range, the same range the reviewer is about to be shown — instead of
   * the turn window. Absent (unresolvable base), the scans fall back to the
   * turn window via `startSha`.
   */
  base_sha?: string;
}

export interface WrapUpStepContext {
  agent: Agent;
  worktreePath: string;
  protocolDir: string;
  status: SupervisorStatus;
  /** Phase reporter bound to the caller's (status, protocolDir). */
  updatePhase: (phase: SupervisorPhase) => void;
  cmd: WrapUpCommandFields;
  /** Steps to run, in plan order. Unknown steps are logged and skipped. */
  steps: readonly WrapUpStep[];
  /**
   * Turn-window start: where the caller's own attribution bookkeeping begins
   * and the scan fallback when the command carries no `base_sha`. Scans prefer
   * the task's own range (`cmd.base_sha..HEAD`, §3.4); attribution windows on
   * step responses always stay turn-relative regardless.
   */
  startSha: string;
  /** Session the wrap-up continues — the work invocation's session id; steps advance it. */
  startSessionId: string;
  protectedPatterns: string[];
  branchPointSha?: string;
  upstreamMergeRef?: string;
  maintainEntries: MaintainEntry[];
  reactEntries: ReactEntry[];
  /**
   * Read-and-clear the turn-ending marker, as the caller does between its own
   * invocations — a step's invocation gets its own chance to declare, and its
   * claim rides on that step's response.
   */
  captureTurnEnding: () => Promise<FinalDeclaration | undefined>;
  /**
   * The caller's supervised-response bundle. Each step pushes its FULL
   * CompletedResponse here — own commits/SHAs, usage, and (for push-back and
   * react) the re-detected violation set.
   */
  supervisedResponses: CompletedResponse[];
  /**
   * HEAD when the walkthrough already on record was declared, from the plan.
   *
   * The `present` step is SKIPPED when it equals HEAD at the moment the step
   * would run: the stored walkthrough describes exactly this branch, so
   * re-authoring it would spend a model turn to produce the same thing. Absent
   * means there is no walkthrough yet, and the step runs.
   */
  presentedSha?: string;
  /**
   * Whether the turn that reached here declared `lazy_final`.
   *
   * Read by TWO policies, both in the `present` step:
   *
   *   - a final that produced no walkthrough FAILS the turn (the §6.2
   *     requirement — a reviewable task owes its reviewer a reading order),
   *     while a park that produced none is logged and carries on. Failing a
   *     plain park would turn "the agent stopped" into "the turn errored",
   *     which is a worse answer than the missing walkthrough;
   *   - a claim the presentation step itself makes is carried home only on a
   *     turn that had ALREADY declared. The walkthrough step may not decide
   *     how a turn ended.
   */
  declaredFinal: boolean;
}

export interface WrapUpOutcome {
  /** Final protected-file violation set — the last re-detection that ran. */
  violations: FileViolation[];
  /** Whether the push-back exchange RAN, independent of its outcome. */
  pushedBack: boolean;
  /** HEAD after the last step that ran; the caller continues its window bookkeeping from here. */
  lastInvocationSha: string;
  /**
   * Session id the caller's next invocation resumes from, advanced through
   * each step so the whole wrap-up stays one conversation.
   */
  lastSessionId: string;
}

/**
 * Run the plan's supervised steps. Single-shot by construction: push-back runs
 * at most once here, and the maintain/react nudges never re-trigger it.
 */
export async function runWrapUpSteps(ctx: WrapUpStepContext): Promise<WrapUpOutcome> {
  const { agent, worktreePath, cmd } = ctx;
  const startSha = ctx.startSha;
  // §3.4: on a final turn every step scans the TASK's own range — the base
  // resolveTaskDiffBase resolved (carried as `base_sha`), to HEAD — which is
  // also the range the reviewer is about to be shown. The turn window is only
  // the fallback for a task whose base could not be resolved daemon-side.
  // Attribution windows (start_sha_work on step responses) are NOT affected:
  // they stay turn-relative, owned by the invocation that made the commits.
  const scanStart = cmd.base_sha ?? startSha;
  const supervisedResponses = ctx.supervisedResponses;
  const launchSettings = (reportedModelId?: string): { agent?: string; model?: string; model_id?: string; effort?: string } => ({
    ...(cmd.agent_id ? { agent: cmd.agent_id } : {}),
    ...(cmd.model_id ? { model: cmd.model_id } : {}),
    ...(reportedModelId ? { model_id: reportedModelId } : {}),
    ...(cmd.effort ? { effort: cmd.effort } : {}),
  });

  let violations: FileViolation[] = [];
  let pushedBack = false;
  let lastInvocationSha = ctx.startSha;
  let lastSessionId = ctx.startSessionId;

  for (const step of ctx.steps) {
    switch (step) {
      case 'permission_pushback': {
        if (ctx.protectedPatterns.length === 0) {
          log('[supervisor] Wrap-up push-back: no protected patterns configured — skipping');
          break;
        }
        log(
          `[supervisor] Wrap-up permissions check: ${ctx.protectedPatterns.length} pattern(s) ` +
          `[${ctx.protectedPatterns.join(', ')}], diff ${scanStart.substring(0, 8)}..${lastInvocationSha.substring(0, 8)}`,
        );
        violations = await detectViolations(
          worktreePath,
          scanStart,
          lastInvocationSha,
          ctx.protectedPatterns,
          ctx.branchPointSha,
          ctx.upstreamMergeRef,
        );
        log(`[supervisor] Wrap-up violations detected: ${violations.length}`);
        if (violations.length === 0) break;

        pushedBack = true;
        log(`[supervisor] Wrap-up detected ${violations.length} file permission violation(s). Pushing back...`);
        ctx.updatePhase('permission_pushback');

        const pushbackResult = await runPermissionPushback(
          agent,
          worktreePath,
          lastSessionId,
          violations,
          cmd.model_id,
          cmd.effort,
          cmd.agent_extra_args,
        );

        // Re-check violations on the new HEAD (agent may have reverted some files).
        // A failed scan must NOT invent [] — that would clear a real pending set.
        const postPushbackSha = await getHeadSha(worktreePath);
        try {
          violations = await detectViolations(
            worktreePath,
            scanStart,
            postPushbackSha,
            ctx.protectedPatterns,
            ctx.branchPointSha,
            ctx.upstreamMergeRef,
          );
          log(`[supervisor] After wrap-up push-back: ${violations.length} violation(s) remaining`);
        } catch (err) {
          if (err instanceof ViolationScanError) {
            logWarn(`[supervisor] Post-push-back protected-file scan failed — keeping pre-push-back set: ${err.message}`);
            // `violations` stays as the set that triggered push-back.
          } else {
            throw err;
          }
        }
        ctx.updatePhase('permission_pushback_done');

        // The push-back response owns exactly the commits made during ITS
        // invocation (lastInvocationSha..postPushbackSha) and carries the FINAL
        // violation set (empty array when the agent resolved them — so the
        // reconciler sees "checked, none remain" rather than falling back to a
        // stale set).
        const pushbackFinal = await ctx.captureTurnEnding();
        supervisedResponses.push({
          status: 'completed',
          result: pushbackResult.response,
          session_id: pushbackResult.session_id,
          usage: pushbackResult.usage,
          ...launchSettings(pushbackResult.model_id),
          start_sha_work: lastInvocationSha,
          end_sha_work: postPushbackSha,
          violations,
          ...(pushbackFinal ? { final: pushbackFinal } : {}),
          supervised: { kind: 'permission_pushback', prompt: pushbackResult.prompt },
        });

        if (postPushbackSha !== lastInvocationSha) {
          await tagHead(worktreePath, `turn/${cmd.task_id.substring(0, 8)}/post-work/${postPushbackSha.substring(0, 8)}`);
        }
        lastInvocationSha = postPushbackSha;
        // Resume the next step from the push-back session so it lands AFTER the
        // push-back exchange in one continuous conversation.
        lastSessionId = pushbackResult.session_id;
        break;
      }

      case 'maintain': {
        if (ctx.maintainEntries.length === 0) break;
        const maintainEndSha = await getHeadSha(worktreePath);
        const { skipped, turnHadChanges } = await detectSkippedMaintainEntries(
          worktreePath,
          scanStart,
          maintainEndSha,
          ctx.maintainEntries,
        );
        log(`[supervisor] Wrap-up maintained-file check: ${ctx.maintainEntries.length} group(s), turnHadChanges=${turnHadChanges}, skipped=${skipped.length}, violationsRemaining=${violations.length}, pushedBack=${pushedBack}`);

        if (skipped.length === 0) break;
        log(`[supervisor] Wrap-up: ${skipped.length} maintained group(s) skipped — prompting agent...`);
        // Shield stranded-completion recovery for the duration of the nudge —
        // maintain can run real agent work for up to 10 minutes.
        ctx.updatePhase('maintain');
        const followup = await runMaintainFollowup(
          agent,
          worktreePath,
          lastSessionId,
          skipped,
          cmd.model_id,
          cmd.effort,
          cmd.agent_extra_args,
        );

        // The follow-up may have committed updates (it can do real work). Those
        // commits belong to the maintain turn — attribute them via its own SHA
        // window (lastInvocationSha..postFollowupSha), not the work turn.
        const postFollowupSha = await getHeadSha(worktreePath);
        const maintainFinal = await ctx.captureTurnEnding();
        supervisedResponses.push({
          status: 'completed',
          result: followup.response,
          session_id: followup.session_id,
          usage: followup.usage,
          ...launchSettings(followup.model_id),
          start_sha_work: lastInvocationSha,
          end_sha_work: postFollowupSha,
          ...(maintainFinal ? { final: maintainFinal } : {}),
          supervised: { kind: 'maintain', prompt: followup.prompt },
        });

        if (postFollowupSha !== lastInvocationSha) {
          await tagHead(worktreePath, `turn/${cmd.task_id.substring(0, 8)}/post-work/${postFollowupSha.substring(0, 8)}`);
        }
        lastInvocationSha = postFollowupSha;
        // Advance the session so a subsequent react nudge continues AFTER this
        // maintain exchange in one conversation (same pattern as push-back above).
        lastSessionId = followup.session_id;
        ctx.updatePhase('maintain_done');
        break;
      }

      case 'react': {
        if (ctx.reactEntries.length === 0) break;
        const reactEndSha = await getHeadSha(worktreePath);
        const { matched, turnHadChanges } = await detectMatchedReactEntries(
          worktreePath,
          scanStart,
          reactEndSha,
          ctx.reactEntries,
        );
        log(`[supervisor] Wrap-up reactive-automation check: ${ctx.reactEntries.length} group(s), turnHadChanges=${turnHadChanges}, matched=${matched.length}`);

        if (matched.length === 0) break;
        log(`[supervisor] Wrap-up: ${matched.length} reactive group(s) matched — prompting agent...`);
        ctx.updatePhase('react');
        const followup = await runReactFollowup(
          agent,
          worktreePath,
          lastSessionId,
          matched,
          cmd.model_id,
          cmd.effort,
          cmd.agent_extra_args,
        );

        const postFollowupSha = await getHeadSha(worktreePath);
        // Re-detect over the full scan window (scanStart..HEAD), same range
        // push-back uses after its exchange — so edits made during react that
        // touch protected paths show up in the final violation set.
        // A successful scan attaches the set (including []) so the reconciler's
        // "last response with violations wins" rule is authoritative. A FAILED
        // scan must omit the field — never write [] that would clear a prior
        // push-back pending set (raised 07b89876).
        let reactViolations: FileViolation[] | undefined;
        try {
          reactViolations = await detectViolations(
            worktreePath,
            scanStart,
            postFollowupSha,
            ctx.protectedPatterns,
            ctx.branchPointSha,
            ctx.upstreamMergeRef,
          );
          violations = reactViolations;
          log(`[supervisor] After react follow-up: ${violations.length} violation(s)`);
        } catch (err) {
          if (err instanceof ViolationScanError) {
            logWarn(`[supervisor] Post-react protected-file scan failed — omitting violations field (prior set kept): ${err.message}`);
          } else {
            throw err;
          }
        }
        const reactFinal = await ctx.captureTurnEnding();
        supervisedResponses.push({
          status: 'completed',
          result: followup.response,
          session_id: followup.session_id,
          usage: followup.usage,
          ...launchSettings(followup.model_id),
          start_sha_work: lastInvocationSha,
          end_sha_work: postFollowupSha,
          ...(reactViolations !== undefined ? { violations: reactViolations } : {}),
          ...(reactFinal ? { final: reactFinal } : {}),
          supervised: { kind: 'react', prompt: followup.prompt },
        });

        if (postFollowupSha !== lastInvocationSha) {
          await tagHead(worktreePath, `turn/${cmd.task_id.substring(0, 8)}/post-work/${postFollowupSha.substring(0, 8)}`);
        }
        lastInvocationSha = postFollowupSha;
        lastSessionId = followup.session_id;
        ctx.updatePhase('react_done');
        break;
      }

      case 'commit_leftovers': {
        // The one scan in this chain that reads the WORKING TREE rather than a
        // committed range. It runs after the nudges above precisely because
        // they are what most often writes a file and forgets it, and before
        // `present` because a commit made here belongs in the walkthrough.
        const beforePaths = await detectUncommittedPaths(worktreePath);
        if (beforePaths === null) {
          // A failed scan is not "clean". Say so and move on: refusing the turn
          // over an unreadable `git status` would be a worse trade than a turn
          // that parks without this check having run.
          logWarn('[supervisor] Wrap-up leftovers check: could not read the worktree status — skipping');
          break;
        }
        log(`[supervisor] Wrap-up leftovers check: ${beforePaths.length} uncommitted path(s)`);
        if (beforePaths.length === 0) break;

        ctx.updatePhase('commit_leftovers');
        const followup = await runLeftoversFollowup(
          agent,
          worktreePath,
          lastSessionId,
          beforePaths,
          cmd.model_id,
          cmd.effort,
          cmd.agent_extra_args,
        );

        const postFollowupSha = await getHeadSha(worktreePath);
        // What is STILL loose after the exchange. A failed re-scan keeps the
        // pre-nudge set rather than inventing a clean worktree — the same
        // direction the push-back keeps its pre-push-back violations.
        const afterPaths = await detectUncommittedPaths(worktreePath);
        if (afterPaths === null) {
          logWarn('[supervisor] Post-leftovers status scan failed — keeping the pre-follow-up path set');
        }
        const remaining = afterPaths ?? beforePaths;
        log(`[supervisor] After leftovers follow-up: ${remaining.length} uncommitted path(s) remaining`);

        // RE-DETECT VIOLATIONS, for the same reason react does — and with more
        // force here, because this is the LAST step that can add a commit and
        // the one whose entire purpose is to turn loose edits into commits. A
        // turn that left `lazy.toml` (or any protected path) edited and
        // uncommitted gets asked to commit it HERE; without this scan the agent
        // does exactly as asked and the protected-file push-back never sees the
        // file, because every other scan in this chain ran before the commit
        // existed. The task parks `blocked` over a stale set instead of
        // `conflict`.
        //
        // Same two rules as react: a successful scan attaches the set (including
        // []) so the reconciler's "last response with violations wins" is
        // authoritative, and a FAILED scan omits the field entirely — never []
        // from a scan that could not look (raised 07b89876).
        let leftoverViolations: FileViolation[] | undefined;
        try {
          leftoverViolations = await detectViolations(
            worktreePath,
            scanStart,
            postFollowupSha,
            ctx.protectedPatterns,
            ctx.branchPointSha,
            ctx.upstreamMergeRef,
          );
          violations = leftoverViolations;
          log(`[supervisor] After leftovers follow-up: ${violations.length} violation(s)`);
        } catch (err) {
          if (err instanceof ViolationScanError) {
            logWarn(`[supervisor] Post-leftovers protected-file scan failed — omitting violations field (prior set kept): ${err.message}`);
          } else {
            throw err;
          }
        }

        const leftoversFinal = await ctx.captureTurnEnding();
        supervisedResponses.push({
          status: 'completed',
          result: followup.response,
          session_id: followup.session_id,
          usage: followup.usage,
          ...launchSettings(followup.model_id),
          start_sha_work: lastInvocationSha,
          end_sha_work: postFollowupSha,
          ...(leftoverViolations !== undefined ? { violations: leftoverViolations } : {}),
          // No `uncommitted` here on purpose: what is left loose is ONE fact
          // about the turn, and the work response carries it, measured after
          // every step rather than after this one. Two records of the same
          // worktree, taken at different moments, is how a reviewer ends up
          // reading a stale one.
          ...(leftoversFinal ? { final: leftoversFinal } : {}),
          supervised: { kind: 'commit_leftovers', prompt: followup.prompt },
        });

        if (postFollowupSha !== lastInvocationSha) {
          await tagHead(worktreePath, `turn/${cmd.task_id.substring(0, 8)}/post-work/${postFollowupSha.substring(0, 8)}`);
        }
        lastInvocationSha = postFollowupSha;
        lastSessionId = followup.session_id;
        ctx.updatePhase('commit_leftovers_done');
        break;
      }

      case 'present': {
        // REGENERATE ONLY WHEN HEAD MOVED. The walkthrough on record was
        // written against `presentedSha`; if the branch is still there, it
        // already describes this diff exactly and re-authoring it would buy a
        // model turn's worth of nothing. This is what makes presenting on every
        // human-facing park affordable: a task that parks three times for
        // decisions pays for one walkthrough, not three.
        const presentHeadSha = await getHeadSha(worktreePath);
        if (ctx.presentedSha && ctx.presentedSha === presentHeadSha) {
          log(
            `[supervisor] Wrap-up presentation step: walkthrough on record was declared at ` +
            `${presentHeadSha.substring(0, 8)} and the head has not moved — keeping it`,
          );
          break;
        }
        // §13.10 analog: the declaration must be over the FINAL file list, made
        // by THIS invocation — a work invocation's lazy_report may have left a
        // marker (it writes one whenever its report carried a presentation), and
        // that must never stand in for a declaration the present step owns.
        await clearPresentationMarker(ctx.protocolDir, log);
        ctx.updatePhase('present');
        log(`[supervisor] Wrap-up presentation step: invoking the agent (session ${lastSessionId.substring(0, 8)}...)`);
        // §6.4: the presentation prompt carries a provenance hint, carved at
        // PRESENT time (not plan time — the nudges before this step may still
        // commit) over the same range the other scans run. Advisory: a failed
        // carve returns '' and the prompt's hint section collapses; it never
        // fails this step.
        const provenanceHint = await carveProvenanceHint(worktreePath, cmd.task_id, scanStart);
        const present = await runPresentStep(
          agent,
          worktreePath,
          lastSessionId,
          cmd.model_id,
          cmd.effort,
          cmd.agent_extra_args,
          provenanceHint,
        );

        // THE ENFORCEMENT (§6.2). The marker is the daemon-echoed fact that the
        // report on record now carries a presentation; absent means the step did
        // not complete, so the turn fails here and the task parks — exactly as a
        // failed wrap-up step does today. The message names the cause: an
        // invocation that failed and declared nothing, or one that finished and
        // declared nothing. `lazy_final` deliberately cannot enforce this (the
        // tool runs before the step that authors the thing).
        const declared = await readPresentationMarker(ctx.protocolDir, log);
        if (!declared) {
          const why = present.failed
            ? 'the invocation failed and no presentation was declared'
            : 'no presentation was declared via lazy_report';
          // A FINAL owes its reviewer a reading order, so a missing walkthrough
          // fails the turn and the task parks — exactly as a failed wrap-up
          // step does. A PARK does not: the task is already stopping for a
          // human, and turning that into an errored turn would cost them the
          // agent's own account of where it got to on top of the walkthrough
          // they did not get.
          if (ctx.declaredFinal) {
            throw new Error(
              `Presentation step did not complete: ${why} — send the report again with its presentation groups`,
            );
          }
          logWarn(
            `[supervisor] Wrap-up presentation step on a park: ${why}. The task parks without a ` +
            `walkthrough; the next park re-runs the step.`,
          );
        }
        ctx.updatePhase('present_done');
        // The marker is READ AND CLEARED whatever happens — a claim left behind
        // here would survive into the next invocation's capture and be
        // attributed to the wrong one.
        const presentFinal = await ctx.captureTurnEnding();

        // INVARIANT: THE PRESENTATION STEP CANNOT DECIDE THE TURN'S ENDING.
        //
        // On a FINAL turn a claim made here rides home: it is redundant but
        // true about its SHA, and the turn was already going to be reviewable.
        // On a PARK it is DROPPED. This step now runs on every human-facing
        // park, and its prompt opens with "your turn is ending" — the cue the
        // tool instructions attach the pencils-down tool to — so it is a
        // standing invitation to declare that the agent never got from its own
        // reading of the work. Letting it through would mark a task parked
        // mid-work as done and spend an auto-review turn on it, with the
        // declaration attributed to a walkthrough step rather than to any
        // decision about the code. The prompt says not to
        // (src/prompts/present-regions.md); this is what makes saying so
        // unnecessary.
        //
        // Logged rather than swallowed: the agent was told "recorded" by the
        // tool, and the record not existing has to be findable.
        if (presentFinal && !ctx.declaredFinal) {
          logWarn(
            '[supervisor] The presentation step declared final on a turn that parked — ' +
            'dropping the claim. The walkthrough step does not decide how a turn ended; ' +
            'only the work invocation does.',
          );
        }
        const carriedFinal = ctx.declaredFinal ? presentFinal : undefined;

        supervisedResponses.push({
          status: 'completed',
          result: present.response,
          session_id: present.session_id,
          usage: present.usage,
          ...launchSettings(present.model_id),
          start_sha_work: lastInvocationSha,
          end_sha_work: lastInvocationSha,
          ...(carriedFinal ? { final: carriedFinal } : {}),
          supervised: { kind: 'present', prompt: present.prompt },
        });
        // The step authors no commits; the session still advances anyway, so
        // the caller's bookkeeping names the session the conversation actually
        // ended on. This is the last step of the chain.
        lastSessionId = present.session_id;
        break;
      }

      default: {
        // A step the plan names that this supervisor does not implement. Log
        // loudly rather than fail the turn: the plan is additive, and a
        // downgrade-transient command naming an unknown step must still finish.
        logWarn(`[supervisor] Wrap-up plan names step "${step}", which this supervisor does not run — skipping`);
        break;
      }
    }
  }

  return { violations, pushedBack, lastInvocationSha, lastSessionId };
}

/**
 * Branch point SHA — the commit before the task created any files. Files not
 * present at the branch point were created by the task itself and are exempt
 * from permission violations (they are not pre-existing files).
 *
 * Primary: merge-base with the parent branch (accounts for upstream merges).
 * Fallback: the command's `branch_point_sha` (the session's git_start_sha,
 * always available). Shared by the work path and the wrap-up command — the
 * violation scans are the only consumer, and they need the SAME answer in both
 * or a final turn would exempt a different file set than its launching turn.
 *
 * Returns undefined when neither source resolves; callers skip exemption.
 */
export async function computeBranchPointSha(opts: {
  worktreePath: string;
  parentBranch?: string;
  hasProtectedPatterns: boolean;
  fallbackSha?: string;
}): Promise<string | undefined> {
  const { worktreePath, parentBranch, hasProtectedPatterns, fallbackSha } = opts;
  let branchPointSha: string | undefined = fallbackSha;
  if (parentBranch && hasProtectedPatterns) {
    const mergeBaseResult = await runGit(
      ['merge-base', parentBranch, 'HEAD'],
      { cwd: worktreePath },
    );
    if (mergeBaseResult.exitCode === 0 && mergeBaseResult.stdout.trim()) {
      branchPointSha = mergeBaseResult.stdout.trim();
      log(`[supervisor] Branch point SHA (merge-base with ${parentBranch}): ${branchPointSha.substring(0, 8)}`);
    } else {
      log(`[supervisor] Could not compute merge-base with ${parentBranch} — using branch_point_sha fallback`);
    }
  }
  if (branchPointSha) {
    log(`[supervisor] Using branch point SHA: ${branchPointSha.substring(0, 8)}${!parentBranch ? ' (from command)' : ''}`);
  }
  return branchPointSha;
}

async function getHeadSha(cwd: string): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd });
  if (result.exitCode !== 0) {
    // Placeholder for reporting only — but never silent. See the twin in
    // src/supervisor/merge.ts: when git is refusing the whole worktree this is
    // the first call to fail, and swallowing it pushes the visible error several
    // git commands downstream where it no longer names the real cause.
    logWarn(`[supervisor] Could not read HEAD in ${cwd}: ${result.stderr || 'git rev-parse HEAD failed'}`);
    return 'unknown';
  }
  return result.stdout;
}

async function tagHead(cwd: string, tagName: string): Promise<void> {
  // Best-effort tagging — don't fail the turn if tagging fails.
  // Tags are refs, so this goes host-side (the container's refs are read-only).
  const result = await elevatedTag(cwd, tagName);
  if (result.exitCode !== 0) {
    logWarn(`[supervisor] Failed to create tag ${tagName}: ${result.stderr}`);
  } else {
    log(`[supervisor] Tagged HEAD as ${tagName}`);
  }
}