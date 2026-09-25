import { requireStorage, parseFlags, parseLineRange, sliceLines } from '../helpers';
import { formatDate, formatDuration, formatTokenCount, totalTokens, totalInputTokens } from '../../utils/format';
import { resolveTaskForgeLink } from '../../task-forge-link';
import { isLinkedTask, formatLinkedMarker } from '../../task/linked';
import { queryTaskShow, type ShowResult } from '../../daemon/rpc-fallback';
import { theme, dim } from '../../render/theme';
import { renderStatusHeader } from '../../render/status-header';
import { renderWorkingStatus } from '../../utils/working-substate';
import { formatTurnLaunchLabels, formatTurnModelWarning, formatTurnTypeSuffix } from '../../utils/turn-labels';
import { formatUnparsedReviewSuffix } from '../../review/parse-report';
import { isBuiltinPromptCode, readBuiltinPrompt, listBuiltinPrompts } from './prompts';
import { showConversationTranscript } from './import-conversation';
import { isTTY, promptChoice } from '../editor';
import type { Task, Session, Turn } from '../../types';
import { formatArtifactBytes } from '../../artifacts/limits';
import { parentTaskIdOf } from '../../task-target';
import { isMidMerge, describeMergeState } from '../../git/operations';
import { shortId, displayId } from '../../task/identity';
import { clusterProgressOf, formatClusterProgress, clusterProgressPayload } from '../../task/cluster-progress';
import { displayUrlFor } from '../../serve/subdomain';
import type { Storage } from '../../storage/interface';
import { loadTaskShowData, type TaskShowData } from '../../task/show-data';
import { showFileViewer } from '../tui/file-viewer';
import { groupTurnsIntoChunks } from '../../utils/turn-chunks';
import { buildShowFinal } from '../../task/show-sections';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { turnText } from '../../utils/turn-content';
import { REPORT_SECTION_LABELS, orderReportSections } from '../../review/report-policy';
import { reviewExplanationLine } from '../../review/mode';
import { describeExpiry } from '../../utils/local-day';
import { protectionSummary, protectionAdvice } from '../../protection/status';
import { attributionLabel } from '../../actor-ref';
import { usagePauseHoldOf, usagePausePendingStartOf, type UsagePauseHold } from '../../usage-pause/hold';
import { mayOfferUsagePauseOverride } from '../human-terminal';
import { describeUsagePause } from '../../usage-pause/policy';

/**
 * Render the person behind an actor role, when the store recorded one.
 *
 * The actor role says WHAT KIND of actor wrote a row; `actor_email` /
 * `actor_name` say WHICH person. Both are absent for rows with no person
 * behind them and for every row written before per-person attribution existed,
 * so this appends nothing in that case and the line reads exactly as it always
 * has. The role is passed as null because the caller has already printed it.
 */
function formatActorPerson(email: string | undefined, name: string | undefined): string {
  const who = attributionLabel(null, email, name);
  return who ? ` ${dim(`(${who})`)}` : '';
}

/**
 * Build the text output lines for a task.
 * Used by both the show command (for display) and the search command (for line number computation).
 *
 * When `showChunks` is true, the Turns section is grouped into review chunks
 * (one human/builder boundary plus its following agent/supervisor/system turns)
 * using the single source of truth in `src/utils/turn-chunks.ts`. The per-turn
 * rendering is identical in both modes — only the grouping/headers differ.
 */
/**
 * `offerUsagePauseOverride`: name the one-shot usage-pause override command in
 * a hold line — only for a person at their own terminal
 * (`mayOfferUsagePauseOverride`). Defaults to never.
 */
export function buildTaskShowLines(
  data: TaskShowData,
  showFull: boolean,
  showChunks = false,
  offerUsagePauseOverride = false,
): string[] {
  const { task, session: sess, turns, commits, comments, journal, raisedItems, turnReport, fileDecisions, artifacts, statusHistory, tagHistory, children, childSessions, parent, retryStatus, orphanStatus, autoReactStatus, supervisorStatus, workingSubstate, mergeState, serveState, protection, autoResumeQueue } = data;
  const outputLines: string[] = [];

  // Status text decorated with the derived working substate for working tasks.
  // Retry detail is stripped here: `show` already spells it out in the header
  // line and the Retry State block, so repeating it in the status word would be
  // the same error text three times on one screen.
  const substateForStatus = workingSubstate && workingSubstate.kind === 'harness' && workingSubstate.retry
    ? { ...workingSubstate, retry: undefined }
    : workingSubstate;
  const taskStatusText = task.status === 'working' && substateForStatus
    ? renderWorkingStatus(substateForStatus)
    : task.status;

  // Supervisor status header (only for working tasks with a status file)
  if (task.status === 'working' && supervisorStatus) {
    outputLines.push(dim(renderStatusHeader(supervisorStatus)));
    outputLines.push('');
  }

  // Task info
  outputLines.push(`Task ${theme.taskId(displayId(task))}`);
  outputLines.push(`  ${theme.label('ID:')}      ${task.id}`);
  if (task.code) {
    outputLines.push(`  ${theme.label('Code:')}    ${task.code}`);
  }
  outputLines.push(`  ${theme.label('Goal:')}    ${task.goal}`);
  outputLines.push(`  ${theme.label('Status:')}  ${theme.status(taskStatusText)}`);
  // A mid-merge worktree is reported next to the status, because it CONTRADICTS
  // it: `blocked` reads as "settled, waiting for you", and this says otherwise.
  if (mergeState && isMidMerge(mergeState)) {
    outputLines.push(
      `  ${theme.label('Worktree:')} ${theme.warning(`unresolved merge — ${describeMergeState(mergeState)}`)}`,
    );
    outputLines.push(
      `            ${dim(`A sync did not finish. Run \`lazy sync ${displayId(task)}\` to complete it.`)}`,
    );
  }
  // Branch protection, next to the status because it is a fact about what this
  // task can DO — a gated task reads as "ready to accept" until the accept is
  // refused. Printed only when there is something to say, so an unprotected
  // project's `show` output is byte-for-byte what it was.
  const protectionValue = protection ? protectionSummary(protection) : null;
  if (protection && protectionValue) {
    const paint = protection.gated ? theme.warning : dim;
    outputLines.push(`  ${theme.label('Protected:')} ${paint(protectionValue)}`);
    for (const line of protectionAdvice(protection, displayId(task))) {
      outputLines.push(`             ${dim(line)}`);
    }
  }
  // Pencils down, next to the status because it answers the question the status
  // cannot: `blocked` reads as "settled, waiting for you" whether the agent
  // finished or merely stopped. Resolved by the one function that owns the rule
  // (the same one the web page and `lazy_show` read), never re-derived here.
  // Shown only once a session exists — an unstarted task nobody has declared
  // done is not news.
  const finalState = sess ? buildShowFinal(turns) : null;
  if (sess) {
    if (finalState) {
      const who = attributionLabel(finalState.claim.actor, finalState.claim.actor_user_id);
      outputLines.push(
        `  ${theme.label('Final:')}   declared by ${who} at ` +
        `${theme.commitSha(finalState.claim.sha.substring(0, 8))} ` +
        `${theme.timestamp(formatDate(finalState.claim.at))}`,
      );
      if (finalState.claim.note) {
        outputLines.push(`           ${dim(finalState.claim.note)}`);
      }
      if (finalState.head_moved_label) {
        outputLines.push(`           ${theme.warning(finalState.head_moved_label)}`);
      }
    } else {
      outputLines.push(`  ${theme.label('Final:')}   ${dim('not declared — nobody has said this work is done')}`);
    }
  }
  outputLines.push(`  ${theme.label('Model:')}   ${theme.model(task.model ?? '-')}`);
  outputLines.push(`  ${theme.label('Agent:')}   ${task.agent_id}`);
  outputLines.push(`  ${theme.label('Type:')}    ${task.type ?? 'task'}`);
  // Pre-composed by the daemon — this line is never assembled from the three
  // fields here, so the CLI and the web page cannot word it differently.
  if (data.review) {
    outputLines.push(`  ${theme.label('Review:')}  ${data.review.line}`);
    // The line names three values and explains none of them, and the question a
    // surprised reader has is "why is it THAT" — so each value says what it
    // means and where it came from, composed daemon-side (engineer report,
    // 2026-09-21). Dimmed: this is the footnote, the line above is the answer.
    for (const explanation of data.review.explanations ?? []) {
      outputLines.push(`           ${dim(reviewExplanationLine(explanation))}`);
    }
    if (data.review.docs_url) {
      outputLines.push(`           ${dim(`docs: ${data.review.docs_url}`)}`);
    }
  }
  if (task.tags && task.tags.length > 0) {
    outputLines.push(`  ${theme.label('Tags:')}    ${task.tags.map(t => theme.tag('#' + t)).join(' ')}`);
  }
  // One line, same URL the web header and MCP lazy_show read — no second derivation.
  const forgeLink = resolveTaskForgeLink(task);
  if (isLinkedTask(task)) {
    outputLines.push(`  ${theme.label('Linked:')}  ${formatLinkedMarker(task)}`);
  }
  if (forgeLink) {
    outputLines.push(`  ${theme.label(forgeLink.kind === 'mr' ? 'MR:' : 'PR:')}      ${forgeLink.url}`);
  }
  if (data.upstreamLine) {
    outputLines.push(`  ${data.upstreamLine}`);
  }

  outputLines.push(`  ${theme.label('Created:')} ${theme.timestamp(formatDate(task.created_at))}`);
  if (task.completed_at) {
    outputLines.push(`  ${theme.label('Done:')}    ${theme.timestamp(formatDate(task.completed_at))}`);
  }
  if (task.close_reason) {
    outputLines.push(`  ${theme.label('Close Reason:')} ${task.close_reason}`);
  }
  if (task.metadata && Object.keys(task.metadata).length > 0) {
    outputLines.push(`  ${theme.label('Metadata:')}`);
    for (const [key, value] of Object.entries(task.metadata)) {
      outputLines.push(`    ${key}: ${value}`);
    }
  }

  // Parent info
  const parentTaskId = parentTaskIdOf(task);
  if (parentTaskId) {
    outputLines.push(`\n${theme.label('Parent Task:')}`);
    outputLines.push(`  ${theme.taskId(parent ? displayId(parent) : shortId(parentTaskId))} - ${parent?.goal ?? '(unknown)'}`);
    if (task.branched_from_sha) {
      outputLines.push(`  ${theme.label('Branched from:')} ${theme.commitSha(task.branched_from_sha.substring(0, 8))}`);
    }
    // Orphan warning: parent task was accepted and its branch is gone
    if (orphanStatus?.isOrphaned && orphanStatus.retargetBranch) {
      outputLines.push(`\n  ${theme.warning('Warning: Parent task was accepted and its branch deleted.')}`);
      outputLines.push(`  ${theme.warning(`This task needs rebasing onto ${orphanStatus.retargetBranch} before it can continue.`)}`);
      outputLines.push(`  Run ${theme.command('lazy unblock ' + displayId(task))} or ${theme.command('lazy start ' + displayId(task))} to retarget automatically.`);
    }
  }

  // Session info (unified view)
  if (sess) {
    const status = sess.outcome ?? (sess.ended_at ? 'ended' : taskStatusText);
    outputLines.push(`\n${theme.label('Session')} (${sess.agent_id})`);
    outputLines.push(`  ${theme.label('Status:')}           ${theme.status(status)}${sess.ended_at ? ' (' + theme.timestamp(formatDate(sess.ended_at)) + ')' : ''}`);
    outputLines.push(`  ${theme.label('Branch:')}           ${sess.git_branch}`);
    outputLines.push(`  ${theme.label('Started:')}          ${theme.timestamp(formatDate(sess.started_at))}`);
    if (sess.last_interaction_at) {
      outputLines.push(`  ${theme.label('Last Interaction:')} ${theme.timestamp(formatDate(sess.last_interaction_at))}`);
    }
    outputLines.push(`  ${theme.label('Total Duration:')}   ${theme.duration(formatDuration(sess.total_duration_ms))}`);
    if (sess.total_usage) {
      const total = totalTokens(sess.total_usage);
      const inputTotal = totalInputTokens(sess.total_usage);
      outputLines.push(`  ${theme.label('Token Usage:')}      ${formatTokenCount(total)} (${formatTokenCount(inputTotal)} in, ${formatTokenCount(sess.total_usage.outputTokens)} out)`);
      if (sess.total_usage.cacheCreationTokens > 0 || sess.total_usage.cacheReadTokens > 0) {
        outputLines.push(`  ${theme.label('Cache Tokens:')}     ${formatTokenCount(sess.total_usage.cacheCreationTokens)} write, ${formatTokenCount(sess.total_usage.cacheReadTokens)} read`);
      }
    }
    outputLines.push(`  ${theme.label('Start SHA:')}        ${theme.commitSha(sess.git_start_sha.substring(0, 8))}`);

    // Declared [serve] ports. Only rendered when the project declares any —
    // there is nothing useful to say about a project that serves nothing.
    if (serveState && serveState.declared.length > 0) {
      outputLines.push(`\n  ${theme.label('Serving:')}`);
      if (serveState.unavailable === 'not-running') {
        for (const s of serveState.declared) {
          outputLines.push(`    ${s.name} → ${dim('(container not running)')}`);
        }
      } else if (serveState.unavailable === 'no-container-runner') {
        outputLines.push(`    ${dim(`${serveState.runnerType} runner — services are on this machine's own ports`)}`);
      } else {
        for (const s of serveState.services) {
          outputLines.push(`    ${s.name} → ${displayUrlFor(s) ?? dim('(not published — restart to pick up [serve])')}`);
        }
      }
    }

    // [usage_pause] holding a launch the daemon would otherwise have made.
    const usageHold = usagePauseHoldOf(task);
    if (usageHold) {
      outputLines.push(...usagePauseHoldLines(usageHold, {
        heldStart: usagePausePendingStartOf(task) !== null,
        offerOverride: offerUsagePauseOverride,
      }));
    }

    // Interrupt diagnostics (if task was interrupted)
    if (sess.interrupt_at) {
      outputLines.push(`\n  ${theme.label('Last Interrupt:')}`);
      outputLines.push(`    ${theme.label('Reason:')} ${sess.interrupt_reason ?? 'unknown'}`);
      if (sess.interrupt_exit_code !== null) {
        outputLines.push(`    ${theme.label('Exit Code:')} ${sess.interrupt_exit_code}`);
      }
      outputLines.push(`    ${theme.label('Time:')} ${theme.timestamp(formatDate(sess.interrupt_at))}`);
      outputLines.push(`    ${theme.label('Consecutive:')} ${sess.consecutive_interruptions}`);
      if (sess.auto_resumed) {
        outputLines.push(`    ${theme.label('Auto-resumed:')} yes`);
      }
      if (sess.user_stopped) {
        outputLines.push(`    ${theme.label('User-stopped:')} yes (reconciler will not auto-resume)`);
      }
      if (autoResumeQueue) {
        const eta = autoResumeQueue.nextEligibleAt <= Date.now() ? 'now' : describeExpiry(new Date(autoResumeQueue.nextEligibleAt));
        outputLines.push(
          `    ${theme.label('Slow-lane auto-resume:')} ${eta} (attempt ${autoResumeQueue.attempts + 1}/${autoResumeQueue.maxAttempts})`,
        );
        outputLines.push(`      ${dim(`Full queue: ${theme.command('lazy daemon resume-queue')}`)}`);
      }
      if (showFull && sess.interrupt_logs) {
        outputLines.push(`    ${theme.label('Logs (last 50 lines):')}`);
        for (const line of sess.interrupt_logs.split('\n').slice(0, 50)) {
          outputLines.push(`      ${line}`);
        }
      }
    }

    // Retry state (if currently retrying)
    if (retryStatus) {
      outputLines.push(`\n  Retry State:`);
      outputLines.push(`    Retry Count:    ${retryStatus.retryCount}`);
      if (retryStatus.failureClass) {
        outputLines.push(
          `    Failure:        ${retryStatus.failureClass}${retryStatus.failureReason ? ` — ${retryStatus.failureReason}` : ''}`,
        );
      }
      if (retryStatus.nextDelayMs !== undefined) {
        outputLines.push(`    Next Attempt:   in ${Math.round(retryStatus.nextDelayMs / 1000)}s`);
      }
      if (retryStatus.errors.length > 0) {
        outputLines.push(`    Error Log (deduplicated, last 10):`);
        for (const err of retryStatus.errors) {
          outputLines.push(`      - [${err.count}x] ${err.message}`);
          outputLines.push(`        First: ${err.firstSeen}, Last: ${err.lastSeen}`);
        }
      }
    }

    // Auto-react budget status (if any auto-reacts have occurred or limits reached)
    if (autoReactStatus) {
      if (autoReactStatus.paused) {
        outputLines.push(`\n  ${theme.error('Auto-react paused:')} ${autoReactStatus.reason ?? 'limit reached'}`);
      } else {
        outputLines.push(`\n  ${theme.label('Auto-react counts:')}`);
      }
      const triggerLabels: Record<string, string> = {
        ci_failure: 'CI failures',
        upstream_sync: 'Upstream syncs',
        comment: 'Comments',
        crash: 'Crashes',
      };
      for (const [trigger, count] of Object.entries(autoReactStatus.counts)) {
        if (count > 0) {
          outputLines.push(`    ${theme.label(triggerLabels[trigger] + ':')} ${count}`);
        }
      }
      if (autoReactStatus.consecutiveAutoTurns > 0) {
        outputLines.push(`    ${theme.label('Consecutive auto-turns (current burst):')} ${autoReactStatus.consecutiveAutoTurns}`);
      }
    }

    // Turns
    if (turns.length > 0) {
      // Render one turn's lines (identical in flat and chunked modes). Provenance
      // — the authoring actor for non-human human-role turns, and the `auto` flag
      // — is surfaced in the header so a reviewer can tell a real human/builder
      // turn from an automation turn.
      const renderTurn = (turn: typeof turns[number]) => {
        const turnBody = turnText(turn);
        const isErrorTurn = turn.role === 'agent' && turnBody.startsWith('[Agent crashed]');
        const usageSuffix = turn.usage
          ? ` | ${formatTokenCount(totalInputTokens(turn.usage))} in, ${formatTokenCount(turn.usage.outputTokens)} out`
          : '';
        // Per-turn launch labels: which agent, model and effort this turn ran
        // under, always all three, `unknown` for anything the turn does not
        // carry. Built by the shared formatter so `lazy show`, `lazy browse` and
        // the web UI agree; an absent field is never filled in from the task's
        // current setting (see src/utils/turn-labels.ts).
        // A turn lazy wrote itself (supervisor nudge, [system] notice) ran no
        // agent and gets no labels at all — see turnRanNoAgent.
        const launchSegment = formatTurnLaunchLabels(turn);
        const launchLabels: string[] = launchSegment ? [launchSegment] : [];
        const modelWarning = formatTurnModelWarning(turn, data.modelsDefault);
        if (modelWarning) launchLabels.push(theme.warning(modelWarning));
        // What the agent reported about its own lazy tools at session start.
        // Printed only when it is NEWS — i.e. the turn ran with no lazy tools —
        // since the healthy case is every turn and would be pure noise. Absent
        // (older turns, agents that report nothing) prints nothing at all.
        if (turn.mcp_tools && / tools=0$/.test(turn.mcp_tools)) {
          launchLabels.push(theme.error(`no lazy tools (${turn.mcp_tools})`));
        }
        const modelSuffix = launchLabels.length > 0 ? ` | ${launchLabels.join(' | ')}` : '';
        const checkSuffix = turn.check_exit_code !== undefined
          ? (turn.check_exit_code === 0
            ? ` | ${theme.status('check: OK')}`
            : ` | ${theme.error(`check: FAILED (exit ${turn.check_exit_code})`)}`)
          : '';
        // Only ever set when the hook FAILED — a healthy pre-turn hook is silent.
        const preTurnSuffix = turn.pre_turn_exit_code !== undefined
          ? ` | ${theme.error(`pre-turn hook: FAILED (exit ${turn.pre_turn_exit_code})`)}`
          : '';
        const autoSuffix = turn.auto_triggered ? ` | ${theme.warning('auto')}` : '';
        // Work the turn left in the worktree. It is in no commit, so it is in
        // no diff below and in nothing accept would merge — which is why the
        // count sits on the header, where a reader who is only skimming turns
        // still meets it. The paths themselves print in the full view.
        const uncommittedSuffix = turn.uncommitted?.length
          ? ` | ${theme.error(`${turn.uncommitted.length} uncommitted`)}`
          : '';
        // WHICH person acted, when the store recorded one. Absent for rows
        // with nobody behind them and for turns predating attribution.
        const personSuffix = formatActorPerson(turn.actor_email, turn.actor_name);
        // Show the author for human-role turns authored by a non-human actor
        // (e.g. 'supervisor' for push-back/maintain prompts, 'builder' for MCP),
        // so the reader can tell "the human said" from "the supervisor pushed back".
        const authorLabel = turn.role === 'human' && turn.actor && turn.actor !== 'human'
          ? turn.actor
          : turn.role;
        const roleDisplay = isErrorTurn ? theme.error('crash') : theme.turnRole(authorLabel);
        const unparsedSuffix = formatUnparsedReviewSuffix(turn);
        const reviewFailSuffix = unparsedSuffix ? theme.error(unparsedSuffix) : '';
        if (showFull) {
          outputLines.push(`\n    --- Turn #${turn.sequence} [${roleDisplay}]${formatTurnTypeSuffix(turn)}${reviewFailSuffix}${usageSuffix}${modelSuffix}${preTurnSuffix}${checkSuffix}${autoSuffix}${uncommittedSuffix}${personSuffix} ---`);
          if (isErrorTurn) {
            for (const line of turnBody.split('\n')) {
              outputLines.push(`    ${theme.error(line)}`);
            }
          } else {
            // For human turns with a full prompt, show the prompt (what agent saw)
            if (turn.role === 'human' && turn.prompt) {
              outputLines.push(`\n    ${theme.label('--- Full prompt sent to agent ---')}\n`);
              outputLines.push(turn.prompt);
            } else {
              outputLines.push(turnBody);
            }
          }
          if (turn.pre_turn_output) {
            outputLines.push(`\n    ${theme.label('--- Pre-turn hook output ---')}`);
            for (const line of turn.pre_turn_output.split('\n')) {
              outputLines.push(`    ${line}`);
            }
          }
          // The paths this turn left in the worktree. Printed in full, with
          // what it means next to them: "uncommitted" is a git word, and the
          // consequence a reviewer has to act on is that none of it is in the
          // diff they are about to approve.
          if (turn.uncommitted?.length) {
            outputLines.push(`\n    ${theme.error('--- Uncommitted when this turn ended (not on the branch) ---')}`);
            for (const path of turn.uncommitted) {
              outputLines.push(`    ${path}`);
            }
          }
          // Show check output in full view
          if (turn.check_output) {
            outputLines.push(`\n    ${theme.label('--- Post-turn check output ---')}`);
            for (const line of turn.check_output.split('\n')) {
              outputLines.push(`    ${line}`);
            }
          }
        } else {
          const preview = turnBody.substring(0, 80).replace(/\n/g, ' ');
          if (isErrorTurn) {
            outputLines.push(`    #${turn.sequence} [${roleDisplay}]${formatTurnTypeSuffix(turn)}${reviewFailSuffix}${usageSuffix}${modelSuffix}${preTurnSuffix}${checkSuffix}${autoSuffix}${uncommittedSuffix}${personSuffix} ${theme.error(preview)}${turnBody.length > 80 ? '...' : ''}`);
          } else {
            outputLines.push(`    #${turn.sequence} [${theme.turnRole(authorLabel)}]${formatTurnTypeSuffix(turn)}${reviewFailSuffix}${usageSuffix}${modelSuffix}${preTurnSuffix}${checkSuffix}${autoSuffix}${uncommittedSuffix}${personSuffix} ${preview}${turnBody.length > 80 ? '...' : ''}`);
          }
        }
      };

      const autoTriggeredCount = turns.filter(t => t.auto_triggered).length;
      const humanTriggeredCount = turns.length - autoTriggeredCount;
      const turnSummary = autoTriggeredCount > 0
        ? `${theme.count(String(turns.length))} total (${humanTriggeredCount} human, ${autoTriggeredCount} auto)`
        : theme.count(String(turns.length));

      if (showChunks) {
        // Group by review boundary using the single source of truth. Each chunk
        // header names its boundary turn (or "(no boundary)" for the leading
        // automation-only chunk) so the grouping is legible.
        const chunks = groupTurnsIntoChunks(turns);
        outputLines.push(`\n  ${theme.label('Turns (chunked):')} ${turnSummary} in ${theme.count(String(chunks.length))} chunk${chunks.length === 1 ? '' : 's'}`);
        for (const chunk of chunks) {
          const b = chunk.boundary;
          const boundaryDesc = b
            ? `#${b.sequence} [${b.role === 'human' && b.actor && b.actor !== 'human' ? b.actor : b.role}]`
            : '(no boundary — leading automation turns)';
          outputLines.push(`\n  ${theme.separator('━')} ${theme.label(`Chunk ${chunk.index + 1}`)} ${dim(boundaryDesc)} ${dim(`(${chunk.turns.length} turn${chunk.turns.length === 1 ? '' : 's'})`)}`);
          for (const turn of chunk.turns) {
            renderTurn(turn);
          }
        }
      } else {
        outputLines.push(`\n  ${theme.label('Turns:')} ${turnSummary}`);
        for (const turn of turns) {
          renderTurn(turn);
        }
      }
    }

    // Commits
    if (commits.length > 0) {
      outputLines.push(`\n  ${theme.label('Commits:')} ${theme.count(String(commits.length))}`);
      for (const c of commits) {
        outputLines.push(`    ${theme.commitSha(c.sha.substring(0, 8))} [${theme.status(c.status)}] ${c.message}`);
      }
    }
  } else {
    outputLines.push(`\n${theme.label('Session:')} (not started)`);
    outputLines.push(`  Start with: ${theme.command('lazy start ' + displayId(task))}`);
    // A subtask start the usage pause is holding has no session yet (only a
    // first start is held), so its hold is shown here rather than above.
    const heldStartHold = usagePauseHoldOf(task);
    if (heldStartHold) {
      outputLines.push(...usagePauseHoldLines(heldStartHold, {
        heldStart: usagePausePendingStartOf(task) !== null,
        offerOverride: offerUsagePauseOverride,
      }));
    }
  }

  // Cluster progress — derived from the children below, printed above them so
  // the k-of-n answer is the first thing a reviewer sees on a cluster task.
  const clusterProgress = clusterProgressOf(task, children);
  if (clusterProgress) {
    outputLines.push(`\n${theme.label('Cluster progress:')} ${formatClusterProgress(clusterProgress)}`);
    for (const child of clusterProgress.deferred) {
      outputLines.push(`  ${dim('deferred')} ${theme.taskId(displayId(child))} ${child.goal}`);
    }
  }

  // Children (variants)
  if (children.length > 0) {
    outputLines.push(`\n${theme.label('Child Tasks (variants):')} ${theme.count(String(children.length))}`);
    for (const child of children) {
      const childSess = childSessions.get(child.id) ?? null;
      const childStatus = childSess
        ? (childSess.outcome ?? (childSess.ended_at ? 'ended' : child.status))
        : child.status;
      outputLines.push(`  ${theme.taskId(displayId(child))} [${theme.status(childStatus)}] ${child.goal}`);
    }
  }

  // Comments
  if (comments.length > 0) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label(`Comments (${comments.length})`)} ${theme.separator('---')}`);

    for (const comment of comments) {
      if (showFull) {
        outputLines.push(`\n  [${theme.timestamp(formatDate(comment.created_at))}]${formatActorPerson(comment.actor_email, comment.actor_name)}`);
        const lines = comment.content.split('\n');
        for (const line of lines) {
          outputLines.push(`    ${line}`);
        }
      } else {
        const preview = comment.content.substring(0, 80).replace(/\n/g, ' ');
        outputLines.push(`  [${theme.timestamp(formatDate(comment.created_at))}]${formatActorPerson(comment.actor_email, comment.actor_name)} ${preview}${comment.content.length > 80 ? '...' : ''}`);
      }
    }
  }

  // Journal (append-only side channel — separate from Comments: entry text is
  // never injected into an agent prompt, only counted)
  if (journal.length > 0) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label(`Journal (${journal.length})`)} ${theme.separator('---')}`);

    for (const entry of journal) {
      const who = entry.actor
        ? ` ${theme.label(entry.actor)}${formatActorPerson(entry.actor_email, entry.actor_name)}`
        : '';
      if (showFull) {
        outputLines.push(`\n  [${theme.timestamp(formatDate(entry.created_at))}]${who}`);
        for (const line of entry.content.split('\n')) {
          outputLines.push(`    ${line}`);
        }
      } else {
        const preview = entry.content.substring(0, 80).replace(/\n/g, ' ');
        outputLines.push(`  [${theme.timestamp(formatDate(entry.created_at))}]${who} ${preview}${entry.content.length > 80 ? '...' : ''}`);
      }
    }
  }
  // Raised items — everything the agent surfaced for a human. Open BLOCKING
  // ones gate accept; non-blocking ones are the orthogonal proposals that used
  // to be follow-ups. One list, one vocabulary, the flag says which is which.
  // `?? []` for version skew against a daemon that predates raised items.
  const raisedList = raisedItems ?? [];
  if (raisedList.length > 0) {
    const open = raisedList.filter(r => r.status === 'open');
    const openBlocking = open.filter(r => r.blocking).length;
    const openNonBlocking = open.length - openBlocking;
    const label = open.length > 0
      ? `Raised items (${raisedList.length}, ${openBlocking} open blocking, ${openNonBlocking} open non-blocking)`
      : `Raised items (${raisedList.length})`;
    outputLines.push(`\n${theme.separator('---')} ${theme.label(label)} ${theme.separator('---')}`);

    for (const r of raisedList) {
      const statusTag = r.status === 'open'
        ? theme.warning('[open]')
        : dim(`[${r.status}]`);
      const gateTag = r.blocking ? theme.warning('[gates accept]') : dim('[fyi]');
      const body = r.title ?? r.content;
      if (showFull) {
        outputLines.push(`\n  [${theme.timestamp(formatDate(r.created_at))}] ${dim(r.id.slice(0, 8))} ${statusTag} ${gateTag}`);
        for (const line of (r.title ? [r.title, ...(r.explanation ? ['', r.explanation] : [])] : [r.content]).join('\n').split('\n')) {
          outputLines.push(`    ${line}`);
        }
        if (r.options && r.options.length > 0) {
          outputLines.push(`    ${dim('options:')} ${r.options.join(' | ')}`);
        }
        if (r.proposed_code) {
          outputLines.push(`    ${dim(`proposed code: ${r.proposed_code}`)}`);
        }
        // Who decided — the person when the store knew one, the role
        // otherwise. Above the note, because "who" frames it.
        const decidedBy = attributionLabel(r.resolved_by, r.resolved_by_email, r.resolved_by_name);
        if (r.status !== 'open' && decidedBy) {
          outputLines.push(`    ${dim(`decided by: ${decidedBy}`)}`);
        }
        const reopenedBy = attributionLabel(r.unresolved_by, r.unresolved_by_email, r.unresolved_by_name);
        if (r.status === 'open' && reopenedBy) {
          outputLines.push(`    ${dim(`reopened by: ${reopenedBy}`)}`);
        }
        if (r.resolution) {
          outputLines.push(`    ${dim(`resolution: ${r.resolution}`)}`);
        }
        if (r.comments && r.comments.length > 0) {
          outputLines.push(`    ${dim(`agent comments (${r.comments.length}):`)}`);
          for (const c of r.comments) {
            const preview = c.content.replace(/\n/g, ' ').slice(0, 120);
            outputLines.push(`      ${dim(`[${c.actor}]`)} ${preview}${c.content.length > 120 ? '...' : ''}`);
          }
        }
        if (r.pending_comment && r.comment_delivered_at == null) {
          outputLines.push(`    ${dim('pending comment (delivered on next unblock/accept)')}`);
        }
        if (r.promoted_task_id) {
          outputLines.push(`    ${dim(`promoted task: ${r.promoted_task_id.slice(0, 8)}`)}`);
        }
      } else {
        const preview = body.substring(0, 80).replace(/\n/g, ' ');
        outputLines.push(`  [${theme.timestamp(formatDate(r.created_at))}] ${dim(r.id.slice(0, 8))} ${statusTag} ${gateTag} ${preview}${body.length > 80 ? '...' : ''}`);
      }
    }
    if (openBlocking > 0) {
      outputLines.push(`  ${dim(`Resolve blocking items before accept: --respond-raised / --promote-raised-subtask / --promote-raised-peer / --dismiss-raised`)}`);
    }
    if (openNonBlocking > 0) {
      outputLines.push(`  ${dim(`Triage: lazy raised respond|acknowledge|dismiss|promote ${displayId(task)} <id>`)}`);
    }

  }

  // Structured turn report. Storage keeps agent order; this CLI view is
  // human-facing so it applies the same tier policy as web/TUI.
  if (turnReport && turnReport.sections.length > 0) {
    const seq =
      turnReport.turn_sequence != null
        ? ` turn #${turnReport.turn_sequence}`
        : '';
    outputLines.push(
      `\n${theme.separator('---')} ${theme.label(`Turn report${seq}`)} ${theme.separator('---')}`,
    );
    for (const section of orderReportSections(turnReport.sections)) {
      const label = REPORT_SECTION_LABELS[section.kind] ?? section.kind;
      if (showFull) {
        outputLines.push(`\n  ${theme.label(label)}`);
        for (const line of section.body.split('\n')) {
          outputLines.push(`    ${line}`);
        }
      } else {
        const preview = section.body.substring(0, 80).replace(/\n/g, ' ');
        outputLines.push(
          `  ${theme.label(label)}: ${preview}${section.body.length > 80 ? '...' : ''}`,
        );
      }
    }
  }

  // Structured keep/skip reasons from justify tools (display-only; never auto-approve).
  // `?? []` for version skew against a daemon that predates file decisions.
  const decisionList = fileDecisions ?? [];
  if (decisionList.length > 0) {
    outputLines.push(
      `\n${theme.separator('---')} ${theme.label(`File decisions (${decisionList.length})`)} ${theme.separator('---')}`,
    );
    for (const d of decisionList) {
      const scope = d.scope === 'protected' ? 'keep' : 'skip';
      const preview = d.reason.substring(0, 80).replace(/\n/g, ' ');
      outputLines.push(
        `  [${d.scope}/${scope}] ${d.target}: ${preview}${d.reason.length > 80 ? '...' : ''}`,
      );
    }
  }

  // Artifacts (files attached to the task, and files it published back).
  // Metadata only, always — content is fetched with `lazy artifact get`, and a
  // megabyte of design files must never land in a `lazy show`.
  //
  // `?? []`, not a bare read: this data can arrive deserialized from a daemon
  // that predates artifacts, and `lazy show` crashing on version skew would be
  // a far worse failure than one missing section.
  const artifactList = artifacts ?? [];
  if (artifactList.length > 0) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label(`Artifacts (${artifactList.length})`)} ${theme.separator('---')}`);
    for (const a of artifactList) {
      const origin = a.origin === 'output' ? ' (published by this task)' : '';
      outputLines.push(
        `  ${a.name}  ${dim(formatArtifactBytes(a.size))}${origin}  ` +
        `[${theme.timestamp(formatDate(a.created_at))}]`,
      );
    }
    outputLines.push(`  ${dim(`Read one with: lazy artifact get ${displayId(task)} <name>`)}`);
  }

  // Status History (audit trail of status transitions)
  if (statusHistory.length > 0) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label(`Status History (${statusHistory.length})`)} ${theme.separator('---')}`);
    let prev: string | null = null;
    for (const change of statusHistory) {
      const transition = prev === null
        ? theme.status(change.status)
        : `${theme.status(prev)} → ${theme.status(change.status)}`;
      const actor = change.actor ? ` ${theme.label('by')} ${change.actor}${formatActorPerson(change.actor_email, change.actor_name)}` : '';
      outputLines.push(`  [${theme.timestamp(formatDate(change.timestamp))}] ${transition}${actor}`);
      prev = change.status;
    }
  }

  // Tag History (append-only audit trail of every tag/untag, actor-attributed)
  if (tagHistory.length > 0) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label(`Tag History (${tagHistory.length})`)} ${theme.separator('---')}`);
    for (const event of tagHistory) {
      const verb = event.action === 'tag' ? theme.success('tagged') : theme.warning('untagged');
      const actor = event.actor ? ` ${theme.label('by')} ${event.actor}${formatActorPerson(event.actor_email, event.actor_name)}` : '';
      outputLines.push(`  [${theme.timestamp(formatDate(event.timestamp))}] ${verb} ${theme.tag('#' + event.tag)}${actor}`);
    }
  }

  // Prompt
  if (task.prompt) {
    outputLines.push(`\n${theme.separator('---')} ${theme.label('Prompt')} ${theme.separator('---')}`);
    outputLines.push(task.prompt);
  } else {
    outputLines.push('\n  (no prompt yet)');
  }

  return outputLines;
}

export async function commandShow(args: string[], invokedAs = 'show'): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'full', takesValue: false },
    { name: 'lines', takesValue: true },
    { name: 'json', takesValue: false },
    { name: 'chunks', takesValue: false },
    { name: 'flat', takesValue: false },
  ], invokedAs);

  const taskId = parsed.positional[0];
  if (!taskId) {
    showUsage();
    process.exit(1);
  }

  // Parse line range if specified
  let lineRange = null;
  const linesValue = parsed.flags.get('lines') as string | undefined;
  if (linesValue !== undefined) {
    lineRange = parseLineRange(linesValue);
    if (!lineRange) {
      console.error(`Invalid line range: ${linesValue}. Format: N..M, N.., or ..M`);
      process.exit(1);
    }
  }

  const jsonOutput = parsed.flags.get('json') === true;

  // Handle built-in prompt codes (lazy-prompt-* prefix)
  if (isBuiltinPromptCode(taskId)) {
    const content = await readBuiltinPrompt(taskId);
    if (!content) {
      // Show available prompts to help the user
      const available = (await listBuiltinPrompts()).map(p => p.code);
      console.error(`No built-in system prompt found for '${taskId}'.`);
      console.error(`\nAvailable prompts: ${available.join(', ')}`);
      console.error(`\nRun ${theme.command('lazy system prompts')} to see all built-in system prompts.`);
      process.exit(1);
    }

    if (jsonOutput) {
      const prompts = await listBuiltinPrompts();
      const meta = prompts.find(p => p.code === taskId);
      console.log(JSON.stringify({
        type: 'prompt',
        code: taskId,
        filename: meta?.filename ?? null,
        content,
      }));
      return;
    }

    // Find the prompt metadata for display
    const prompts = await listBuiltinPrompts();
    const meta = prompts.find(p => p.code === taskId);

    const outputLines: string[] = [];
    outputLines.push(`${theme.label('Prompt')} ${theme.taskId(taskId)}`);
    if (meta) {
      outputLines.push(`  ${theme.label('File:')} ${meta.filename}`);
    }
    outputLines.push(`  ${theme.label('Size:')} ${content.length} chars, ${content.split('\n').length} lines`);
    outputLines.push(`\n${theme.separator('─'.repeat(60))}\n`);
    outputLines.push(content);

    let output = outputLines.join('\n');
    if (lineRange) {
      output = sliceLines(output, lineRange);
    }
    console.log(output);
    return;
  }

  const showFull = parsed.flags.get('full') === true;
  // Turn grouping default depends on the invoked name: `lazy view` groups turns
  // into review chunks by default (parity with `lazy browse`, which groups by
  // default), while the canonical `lazy show` stays flat by default so scripts
  // reading its text output are undisturbed. `--chunks`/`--flat` force either
  // mode explicitly on both; `--flat` wins if both are somehow passed.
  const chunkedByDefault = invokedAs === 'view';
  const showChunks = parsed.flags.get('flat') === true
    ? false
    : parsed.flags.get('chunks') === true
      ? true
      : chunkedByDefault;

  // Resolve as a task via daemon RPC
  const showResult = await queryTaskShow(taskId);

  if (showResult && !showResult.ambiguous) {
    const data = showResult.data;

    if (jsonOutput) {
      const jsonData = buildShowJson(data);
      console.log(JSON.stringify(jsonData));
      return;
    }

    const outputLines = buildTaskShowLines(data, showFull, showChunks, await mayOfferUsagePauseOverride());
    let output = outputLines.join('\n');
    if (lineRange) {
      output = sliceLines(output, lineRange);
    }
    console.log(output);
    return;
  }

  if (showResult?.ambiguous) {
    // Build formatted options for each task
    const options: string[] = [];
    for (const t of showResult.matches) {
      // Same columns as resolveTaskOrExit (src/cli/helpers.ts): the timestamp is
      // what actually distinguishes two same-code tasks for a human, so `show`
      // must not drop it while every other command shows it.
      const paddedStatus = t.status.padEnd(12);
      options.push(`${shortId(t.id)}  ${paddedStatus}  ${formatDate(t.lastInteractionAt)}  ${t.goal}`);
    }


    // In TTY mode, offer interactive choice
    if (isTTY()) {
      const choice = await promptChoice(`Multiple tasks match code '${taskId}'. Choose one:`, options);
      const selectedMatch = showResult.matches[choice];

      // Re-query with the full ID to get the task data
      const resolved = await queryTaskShow(selectedMatch.id);
      if (resolved && !resolved.ambiguous) {
        if (jsonOutput) {
          const jsonData = buildShowJson(resolved.data);
          console.log(JSON.stringify(jsonData));
          return;
        }

        const outputLines = buildTaskShowLines(resolved.data, showFull, showChunks, await mayOfferUsagePauseOverride());
        let output = outputLines.join('\n');
        if (lineRange) {
          output = sliceLines(output, lineRange);
        }
        console.log(output);
        return;
      }
    }

    // In non-TTY mode, print error and exit
    console.error(`Multiple tasks match code '${taskId}'. Use the ID to disambiguate:`);
    for (const option of options) {
      console.error(`  ${option}`);
    }
    process.exit(1);
  }

  // Not a task — try conversation session ID, then file path
  const storage = await requireStorage();
  try {
    const conversations = await storage.listConversations();
    // Prefer an exact session-ID match; otherwise accept a unique prefix, the
    // same way tasks resolve short IDs. A prefix matching more than one
    // conversation is ambiguous — error rather than silently picking the first.
    const exact = conversations.find(c => c.sessionId === taskId);
    const prefixMatches = conversations.filter(c => c.sessionId.startsWith(taskId));
    const convMatch = exact ?? (prefixMatches.length === 1 ? prefixMatches[0] : null);

    if (!convMatch && prefixMatches.length > 1) {
      console.error(`Multiple conversations match '${taskId}'. Use a longer prefix to disambiguate:`);
      for (const c of prefixMatches) {
        const firstUserMsg = c.messages.find(m => m.role === 'user');
        const firstLine = firstUserMsg ? firstUserMsg.text.split('\n')[0].substring(0, 60) : '(no prompt)';
        console.error(`  ${c.sessionId.substring(0, 8)}  ${firstLine}`);
      }
      process.exit(1);
    }

    if (convMatch) {
      if (jsonOutput) {
        const conv = await storage.loadConversation(convMatch.sessionId);
        if (conv) {
          console.log(JSON.stringify({
            type: 'conversation',
            session_id: conv.sessionId,
            summary: conv.summary,
            git_branch: conv.gitBranch,
            started_at: conv.startedAt,
            ended_at: conv.endedAt,
            stats: conv.stats,
            total_usage: conv.totalUsage,
            messages: conv.messages.map(m => ({
              role: m.role,
              text: m.text,
              timestamp: m.timestamp,
              model: m.model,
              usage: m.usage,
            })),
          }));
        }
        return;
      }
      await showConversationTranscript(storage, convMatch.sessionId, lineRange);
      return;
    }
  } finally {
    await storage.close();
  }

  // Try as a file path
  if (existsSync(taskId)) {
    // JSON output for files
    if (jsonOutput) {
      const content = readFileSync(taskId, 'utf-8');
      console.log(JSON.stringify({
        type: 'file',
        path: taskId,
        content,
        size: content.length,
        lines: content.split('\n').length,
      }));
      return;
    }

    // Line range output for files
    if (lineRange) {
      const content = readFileSync(taskId, 'utf-8');
      const output = sliceLines(content, lineRange);
      console.log(output);
      return;
    }

    // Launch full-screen TUI viewer
    await showFileViewer(taskId);
    return;
  }

  console.error(`No task, conversation, or file found matching '${taskId}'`);
  process.exit(1);
}

/** Build the JSON output structure from TaskShowData. Used by both direct and daemon paths. */
function buildShowJson(data: TaskShowData): Record<string, unknown> {
  const { task, session: sess, turns, commits, comments, journal, raisedItems, turnReport, fileDecisions, artifacts, children, retryStatus, autoReactStatus, mergeState, workingSubstate, supervisorStatus } = data;

  const jsonData: Record<string, unknown> = {
    id: task.id,
    code: task.code,
    goal: task.goal,
    status: task.status,
    type: task.type ?? 'task',
    model: task.model,
    agent_id: task.agent_id,
    prompt: task.prompt || null,
    created_at: task.created_at,
    completed_at: task.completed_at,
    close_reason: task.close_reason,
    parent_task_id: parentTaskIdOf(task),
    branched_from_sha: task.branched_from_sha,
    metadata: task.metadata,
    session: sess ? {
      id: sess.id,
      agent_id: sess.agent_id,
      status: sess.outcome ?? (sess.ended_at ? 'ended' : task.status),
      git_branch: sess.git_branch,
      git_start_sha: sess.git_start_sha,
      started_at: sess.started_at,
      ended_at: sess.ended_at,
      last_interaction_at: sess.last_interaction_at,
      // Which run the reconciler probes for this session, and on which runner
      // — the first two things to check when a task sits at working(not-alive).
      container_name: sess.container_name ?? null,
      runner_type: sess.runner_type ?? null,
      total_duration_ms: sess.total_duration_ms,
      total_usage: sess.total_usage,
      consecutive_interruptions: sess.consecutive_interruptions,
      auto_resumed: sess.auto_resumed,
    } : null,
    turns: turns.map(t => ({
      sequence: t.sequence,
      role: t.role,
      // WHAT KIND of actor wrote the turn, and WHICH person — null for rows
      // with nobody behind them and for turns predating attribution.
      actor: t.actor ?? null,
      actor_email: t.actor_email ?? null,
      actor_name: t.actor_name ?? null,
      content: turnText(t),
      prompt: t.prompt ?? null,
      timestamp: t.timestamp,
      usage: t.usage,
      // Null means "unknown", never the task's current agent — turns written
      // before this field existed have no agent, and `lazy edit --agent` can
      // switch agents mid-task. See `Turn.agent`.
      agent: t.agent ?? null,
      model: t.model ?? null,
      // Null, not the alias, when the agent reported no concrete id — a consumer
      // labelling experiment arms must be able to tell "ran on this exact model"
      // from "we only ever knew the tier alias".
      model_id: t.model_id ?? null,
      effort: t.effort ?? null,
      // Null means "never observed" (older turn, or an agent that reports no
      // tool list) — deliberately distinct from an observed `tools=0`.
      mcp_tools: t.mcp_tools ?? null,
      auto_triggered: t.auto_triggered ?? false,
      ...(t.check_exit_code !== undefined ? { check_exit_code: t.check_exit_code } : {}),
      ...(t.check_output !== undefined ? { check_output: t.check_output } : {}),
      // Paths the turn left in the worktree — present only when there were
      // some, so a script can read the field's presence as the alarm.
      ...(t.uncommitted?.length ? { uncommitted: t.uncommitted } : {}),
      ...(t.pre_turn_exit_code !== undefined ? { pre_turn_exit_code: t.pre_turn_exit_code } : {}),
      ...(t.pre_turn_output !== undefined ? { pre_turn_output: t.pre_turn_output } : {}),
    })),
    commits: commits.map(c => ({
      sha: c.sha,
      message: c.message,
      status: c.status,
      timestamp: c.timestamp,
    })),
    comments: comments.map(c => ({
      content: c.content,
      created_at: c.created_at,
      actor: c.actor ?? null,
      actor_email: c.actor_email ?? null,
      actor_name: c.actor_name ?? null,
    })),
    journal: journal.map(j => ({
      content: j.content,
      created_at: j.created_at,
      actor: j.actor ?? null,
      actor_email: j.actor_email ?? null,
      actor_name: j.actor_name ?? null,
    })),
    // ONE array for everything the agent raised: `follow_ups` is gone, and
    // `blocking` is what tells a consumer whether an item gates accept.
    // `?? []` for version skew against an older daemon.
    raised_items: (raisedItems ?? []).map(r => ({
      id: r.id,
      blocking: r.blocking,
      content: r.content,
      title: r.title ?? null,
      explanation: r.explanation ?? null,
      proposed_code: r.proposed_code ?? null,
      proposed_prompt: r.proposed_prompt ?? null,
      options: r.options ?? null,
      created_at: r.created_at,
      session_id: r.session_id ?? null,
      turn_sequence: r.turn_sequence ?? null,
      status: r.status,
      resolved_at: r.resolved_at ?? null,
      resolved_by: r.resolved_by ?? null,
      resolved_by_email: r.resolved_by_email ?? null,
      resolved_by_name: r.resolved_by_name ?? null,
      resolution: r.resolution ?? null,
      comments: r.comments ?? null,
      pending_comment: r.pending_comment ?? null,
      comment_delivered_at: r.comment_delivered_at ?? null,
      delivered_turn: r.delivered_turn ?? null,
      promoted_task_id: r.promoted_task_id ?? null,
    })),
    turn_report: turnReport
      ? {
          id: turnReport.id,
          session_id: turnReport.session_id,
          turn_sequence: turnReport.turn_sequence ?? null,
          sections: turnReport.sections,
          raised_item_ids: turnReport.raised_item_ids ?? null,
          created_at: turnReport.created_at,
        }
      : null,
    file_decisions: fileDecisions.map((d) => ({
      id: d.id,
      scope: d.scope,
      target: d.target,
      decision: d.decision,
      reason: d.reason,
      created_at: d.created_at,
    })),
    // Metadata only — `lazy artifact get` is the content path. `?? []` for the
    // same version-skew reason as the text renderer above.
    artifacts: (artifacts ?? []).map(a => ({
      name: a.name,
      size: a.size,
      sha256: a.sha256,
      mime_type: a.mime_type,
      binary: a.binary,
      origin: a.origin,
      created_by: a.created_by,
      created_at: a.created_at,
    })),
    children: children.map(c => ({
      id: c.id,
      code: c.code,
      goal: c.goal,
      status: c.status,
    })),
  };

  // A scripted consumer must be able to answer "how far along is this cluster"
  // without re-deriving the rule — same derivation the text output prints.
  const clusterProgress = clusterProgressOf(task, children);
  if (clusterProgress) {
    // The same projection the `show` and `clusters` RPCs send, so a script
    // reading one surface and a client reading the other see one shape.
    //
    // Was `loop_progress` until 2026-09-20 and renamed with the Ruby client. No
    // compatibility spelling, for the reason given on `show`'s `clusterProgress`:
    // a reader that misses this key sees the same absence a non-cluster task
    // produces, which costs a progress line rather than a page.
    jsonData.cluster_progress = clusterProgressPayload(clusterProgress);
  }

  // Pencils down. Emitted even when null, unlike the optional blocks below: a
  // script must be able to tell "nobody declared this done" from "this build
  // does not report finals", and only an explicit null does that.
  jsonData.final = buildShowFinal(turns);

  if (retryStatus) {
    jsonData.retry_status = retryStatus;
  }

  // What the reconciler sees for a WORKING task, for remote diagnosis of one
  // that sits at working(not-alive) (docs/working-not-alive.md): the derived
  // label, the supervisor's last checkpoint, and the ask/review claim that
  // decides which run speaks for the task.
  if (task.status === 'working') {
    jsonData.liveness = {
      working_status: renderWorkingStatus(workingSubstate),
      supervisor_phase: supervisorStatus?.phase ?? null,
      supervisor_updated_at: supervisorStatus?.updated_at ?? null,
      in_flight_turn: task.in_flight_turn ?? null,
    };
  }

  if (autoReactStatus) {
    jsonData.auto_react_status = autoReactStatus;
  }

  // A scripted consumer must be able to see a stranded merge too — the text
  // output is not the only surface that used to lie (fix-sync-silent-conflict).
  if (mergeState && isMidMerge(mergeState)) {
    jsonData.merge_state = {
      merge_in_progress: mergeState.mergeInProgress,
      unmerged_files: mergeState.unmergedFiles,
      summary: describeMergeState(mergeState),
    };
  }

  // Same no-network line the text renderer and MCP lazy_show print.
  if (data.review) {
    jsonData.review = data.review;
  }
  if (data.upstreamLine) {
    jsonData.upstream = data.upstreamLine;
  }

  return jsonData;
}

export function showUsage(): void {
  console.log(`Usage: lazy show|view <id> [--full] [--chunks] [--flat] [--lines N..M] [--json]

Show detailed information about a task, conversation, or file.

If given a task ID or task code, shows the task with its session, turns,
commits, comments, and any child tasks (variants).

If given a conversation session ID (or prefix), shows the full interleaved
conversation transcript.

If given a file path, renders the file in a scrollable TUI viewer.
Markdown files (.md) are rendered with formatting.

Also supports viewing built-in system prompts (lazy-prompt-*).

Arguments:
  <id>         Task ID, task code, conversation session ID, file path,
               or built-in prompt code

Turn grouping:
  'lazy view' groups turns into review chunks by default (parity with the
  'lazy browse' TUI); the canonical 'lazy show' lists turns flat by default.
  Use --chunks or --flat to force either mode regardless of how it was invoked.

Options:
  --full       Show complete turn and comment content instead of truncated preview
  --chunks     Group turns into review chunks (one human/builder boundary plus its
               following agent/supervisor/system turns) instead of a flat list
  --flat       List turns flat (the default for 'lazy show'; overrides the chunked
               default of 'lazy view')
  --lines N..M Return only lines N through M of the output (1-indexed, inclusive)
               Formats: N..M (range), N.. (from N to end), ..M (start to M)
  --json       Output as structured JSON instead of human-readable text

Examples:
  lazy show abc12345                          # Show task by ID
  lazy show abc1                              # Prefix matching works
  lazy show abc1 --full                       # Show full turn and comment content
  lazy show abc1 --chunks                     # Group turns by human/builder review boundary
  lazy view abc1                              # Turns grouped into chunks by default
  lazy view abc1 --flat                       # Force the flat turn list
  lazy show abc1 --lines 10..20               # Show only lines 10-20 of output
  lazy show abc1 --lines 50..                 # Show from line 50 to end
  lazy show abc1 --json                       # Output task as JSON
  lazy show dddddddd                          # Show conversation by session ID prefix
  lazy show dddddddd --lines 1..100           # Show first 100 lines of conversation
  lazy show lazy-prompt-system-instructions   # View a built-in system prompt
  lazy show README.md                         # View a file in scrollable TUI
  lazy show src/index.ts                      # View a TypeScript file
  lazy show CLAUDE.md --lines 1..50           # Show first 50 lines of file`)
}

/**
 * The `lazy show` lines for a launch the usage pause is holding.
 *
 * INVARIANT: the override command is named only to a person at their own
 * terminal (`offerOverride`), and never for a HELD SUBTASK START, which the
 * override does not release (the replay runs as the agent that asked): that
 * one starts by itself after the reset, and says so.
 */
export function usagePauseHoldLines(
  hold: UsagePauseHold,
  opts: { heldStart: boolean; offerOverride: boolean; now?: number },
): string[] {
  const lifted = hold.resetsAt !== null && hold.resetsAt <= (opts.now ?? Date.now());
  const lines = [
    `\n  ${theme.label('Usage pause:')} ` +
      (lifted
        ? `the window has reset — the ${hold.held} goes ahead on the daemon's next pass`
        : `the ${hold.held} is waiting`),
  ];
  if (!lifted) lines.push(`    ${describeUsagePause(hold)}`);
  const next = opts.heldStart
    ? 'it starts by itself after the reset'
    : opts.offerOverride
      ? `let one turn start now: ${theme.command('lazy daemon config set usage_pause_threshold off')}`
      : 'it goes ahead by itself after the reset';
  lines.push(`    ${dim(`Details: ${theme.command('lazy doctor')} · ${next}`)}`);
  return lines;
}
