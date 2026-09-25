/**
 * Auto-review catchup — final-turn design §8.
 *
 * Declaring a task done starts a review of it automatically. The dispatch is
 * DURABLE and fully DERIVED: once per reconcile tick, every parked task whose
 * latest standing final claim has no review turn after it is owed one, and
 * this phase dispatches it — whatever path parked the task (a work turn
 * paused mid-round, a turn whose wrap-up chain ran after the claim, a daemon
 * that died between the final claim and the review launch).
 *
 * Daemon-dispatched only, never via a comment signal: a comment is delivered
 * into the target's next `lazy unblock` prompt (CLAUDE.md invariant), and a
 * review is not feedback — it is the daemon's own accounting turn, budgeted
 * and attributed like every other daemon-started turn.
 *
 * The round accounting (cap, blocking findings, the driver hand-back) lives at
 * the SETTLE side, in task-lifecycle.ts `settleAutoReviewRound`. This module
 * only decides whether to dispatch.
 */
import { join } from 'path';

import type { Storage } from '../storage';
import type { Task } from '../types';
import type { ResolvedConfig } from '../config/types';

import { isClusterTask } from '../types';
import { parentTaskIdOf } from '../task-target';
import { resolveFinalState } from '../task/final-state';
import { taskRef, getWorktreePathForRef, shortId } from '../task/identity';
import { pathExists } from '../utils/fs';
import { checkLock } from '../utils/lock';
import { logger } from '../utils/logger';
import { createRecoveredAgentTurn } from './turn-owner';
import { loadConfig } from '../config/loader';
import { REVIEW_UNPARSED } from '../review/parse-report';
import { isSelfReview, reviewSettingsOf, reviewSettingsStatedBy } from '../review/mode';
import {
  reviewNotRunHeadline,
  reviewWasNeverDispatched,
  undispatchedReviewVerdict,
} from '../review/verdict';
import { isTurnInFlight } from './in-flight-turn';
import { isTaskBusyRefusal } from './rpc-error';
import { supervisorStillOwnsTurn } from './supervisor-handback';
import { systemTurnBlock } from './turn-credentials';
import { usagePauseHold } from './usage-pause';
import {
  FINAL_REVIEW_CAP,
  getFinalReviewRound,
  recordAutoReact,
  shouldAutoReact,
  type AutoReactDecision,
} from './auto-react-budget';
import { REVIEWABLE_STATUSES, launchReviewTask } from './task-lifecycle';

/**
 * A parked task with a standing final claim and no review turn after it is
 * owed a review. Checked per reconcile tick, so the guards are cheap and the
 * dedup is content-derived — there is no "dispatched" marker to lose.
 */
export async function runAutoReviewCatchup(
  storage: Storage,
  lazyRoot: string,
): Promise<void> {
  try {
    const allTasks = await storage.listTasks();
    const parked = allTasks.filter((t) => REVIEWABLE_STATUSES.has(t.status));
    if (parked.length === 0) return;

    logger.debug(`Auto-review catchup: ${parked.length} parked task(s)`);

    for (const task of parked) {
      try {
        await maybeAutoReview(storage, lazyRoot, task);
      } catch (err) {
        // launchReviewTaskRun preflights (worktree, lock, runner, pairing
        // credential) and throws refusals; one task's refusal must not stop
        // the others, and the review turn is already durable if one ran.
        logger.debug(
          `Auto-review: task ${shortId(task.id)} not dispatched: ` +
            `${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (err) {
    logger.debug(
      `Auto-review catchup failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * WHY a review was not run, in the three voices the record needs.
 *
 * One shape for every way a reviewer never started — a dispatch that threw, and
 * the gates that return before the dispatch is even attempted (auto-react
 * paused, the daily budget spent, no credential to run a system turn). They
 * produce the SAME record, because from the reader's side they are the same
 * fact: nothing has read this work.
 *
 * Split into fields rather than one paragraph because they land in places with
 * different readers and different lengths — a one-clause verdict the accept
 * refusal and the web gate row render, the sentence a journal entry completes,
 * and the paragraph saying how it gets unstuck.
 */
export interface AutoReviewNotRunCause {
  /**
   * WHAT KIND of obstacle, in one clause with NO variable text in it.
   *
   * Two things key on it being stable. It is what a refusal shows when it has
   * room for one clause, and it is this record's IDENTITY: a second record is
   * written when the headline changes and not otherwise, so a budget count
   * ticking or an error string flapping must not read as a different obstacle.
   */
  headline: string;
  /** The specifics: an error message, a budget count, the pause reason. */
  detail: string;
  /** Completes "…declared final at `abc12345`, but <this>" — a full sentence. */
  what: string;
  /** Its own paragraph: what makes the review appear, and who has to act. */
  recovery: string;
  /**
   * True when WAITING is the right action — the obstacle lifts on its own (a
   * transient dispatch failure, a budget that resets at local midnight) and the
   * next tick dispatches.
   *
   * False when somebody has to do something. The boilerplate around
   * {@link recovery} is written from this, because a fixed "the dispatch is
   * re-tried on every reconcile tick" tail sat directly under a paragraph
   * saying "nothing dispatches while the pause stands" and contradicted it —
   * and of the two sentences, the boilerplate is the one that reads like the
   * system's own promise. An operator who believes it waits, which is the exact
   * wait this record exists to prevent.
   */
  clearsItself: boolean;
}

/** The verdict line this cause records, in the format `verdict.ts` owns. */
function verdictFor(cause: AutoReviewNotRunCause): string {
  return undispatchedReviewVerdict(cause.headline, cause.detail);
}

/**
 * A review that could not even START is RECORDED as a failed review, and it
 * gates accept.
 *
 * A dispatch failure unwinds completely — no claim, no turn — so without this
 * the task just sits parked with no review and no error, and a driver waiting
 * on that child waits forever. That is what a dead provider looked like in the
 * first driver to run under this flow.
 *
 * A SKIP LEAVES THE SAME HOLE AS A FAILURE, and this function records both
 * (engineer decision via raised item `a30bbb3d`). `maybeAutoReview` returns
 * before dispatching on several gates, and three of them can stand for hours:
 * auto-react paused for the task or the project, the daily auto-react budget
 * spent, and no service credential for a system turn. Nothing threw on those
 * paths, so nothing was recorded, so accept had nothing to hold the merge on —
 * while both the journal entry below and the design doc told the reader that an
 * un-run review gates. Two doors into one hole; this closes the second.
 *
 * IT GATES, like every other way a review fails (engineer decision, second
 * pass). An earlier draft left it ungated on the argument that "this dispatch
 * failed" is not knowable to be persistent at the moment it happens — but a
 * task nobody reviewed is a task nobody reviewed, and accepting it silently is
 * the one shape this whole flow exists to close. A crashed reviewer already
 * lands as a failed review turn (`recordReviewErrorTurn`); this is the same
 * outcome reached through the other door, so the record reads the same way to
 * every surface: the Reviews list, the accept gate, and a driver's step 5.
 *
 * THE RETRY SURVIVES THE GATE, which is what makes gating cheap. The recorded
 * turn is marked `FAILED TO START:` (`reviewWasNeverDispatched`), and the
 * dispatch side does NOT count such a turn as "this final has been reviewed" —
 * so a docker daemon restarting still self-heals: the next tick dispatches, the
 * real review lands after this turn, and the gate reads the newest review.
 * Nothing but a persistent failure ever reaches a human, and when one does,
 * `lazy accept --allow-review-issues` is the override, exactly as for every other failed
 * review.
 *
 * WHERE THE JOURNALS LAND. On the task's OWN journal always, and additionally
 * on a cluster parent's when there is one. The task's own entry is what a person
 * opening a task of any other type sees; the cluster's is the §8.2 hand-back, so
 * a driver waiting on the child reads why it is parked instead of waiting.
 *
 * Both journals are keyed on the final's SHA AND the obstacle's headline, so
 * they are written once per obstacle rather than once per reconcile tick: the
 * catchup re-tries the dispatch every tick by design, and a per-tick journal
 * entry would bury the driver's own notes. Keying on the SHA alone pinned the
 * record to whichever obstacle came first, so an operator who cleared it was
 * still being told to clear it while a different one now held the review.
 */
const NOT_RUN_MARKER_KEY = 'auto_review_launch_failed_sha';

/** The cause for a dispatch that was attempted and threw. */
export function launchFailureCause(err: unknown): AutoReviewNotRunCause {
  const message = err instanceof Error ? err.message : String(err);
  return {
    headline: 'the reviewer could not be launched',
    detail: message,
    what: `launching its reviewer failed: ${message}.`,
    recovery:
      `The daemon retries on every reconcile tick, so a transient failure (a provider ` +
      `outage, a busy runner, a restarting container runtime) clears itself and a real ` +
      `review appears. If this keeps repeating, the reviewer is broken in the ENVIRONMENT ` +
      `rather than in this task's code.`,
    clearsItself: true,
  };
}

/** The cause for a project with no credential to run a system turn on. */
export function systemCredentialCause(block: string): AutoReviewNotRunCause {
  return {
    headline: 'the daemon had no credential to run a review on',
    detail: block.replace(/\.$/, ''),
    what: `the daemon had no credential to run its reviewer on: ${block.replace(/\.$/, '')}.`,
    recovery:
      `Nothing clears this by itself. The daemon re-checks on every tick, so the review ` +
      `dispatches the moment this project has a credential for turns it starts on its own — ` +
      `and until then every task that declares final parks here, unreviewed.`,
    clearsItself: false,
  };
}

/**
 * The cause for a review the usage pause is holding ([usage_pause]): the
 * credential it would spend is past its threshold. It lifts by itself when the
 * window resets, and the catchup dispatches on the first tick after that.
 */
export function usagePauseCause(pause: string, task: Task): AutoReviewNotRunCause {
  const ref = task.code ?? shortId(task.id);
  return {
    headline: 'new turns on its credential are paused',
    detail: pause,
    what: `the daemon did not dispatch its reviewer: new turns on its credential are paused. ${pause}`,
    // Names no override command: this record is stored on the task, where the
    // task's agent can read it, and the override is the human's alone
    // (src/daemon/usage-pause.ts).
    recovery:
      `The pause lifts by itself when the usage window resets, and the review dispatches on ` +
      `the first tick after that — no review round and no auto-react budget is spent while ` +
      `it waits. To have it reviewed sooner, a person can let one launch through from their own ` +
      `terminal (\`lazy doctor\` says how) and then run \`lazy review ${ref}\`.`,
    clearsItself: true,
  };
}

/**
 * The cause for an auto-react gate that refused the dispatch, or `null` when
 * the gate is not worth recording.
 *
 * `backoff` is the one that is not: it is seconds long by construction
 * (`EXPONENTIAL_DELAYS_MS` tops out at five minutes and applies only after a
 * repeat), so the dispatch it delays arrives while the same person is still
 * looking at the task. A record for it would be a gate that flickers on and
 * off, which teaches a reader to ignore the ones that mean something.
 *
 * Read from `decision.gate`, never from `decision.reason` — the reason is prose
 * written for a person, and a rule that parses it is a rule any reword breaks.
 */
export function autoReactSkipCause(
  decision: AutoReactDecision,
  task: Task,
): AutoReviewNotRunCause | null {
  // The gate's reason is a sentence in its own right and some spellings end in
  // a full stop; every use below puts it inside one of ours.
  const reason = (decision.reason ?? 'auto-react refused the turn').replace(/\.$/, '');
  const ref = task.code ?? shortId(task.id);
  switch (decision.gate) {
    case 'backoff':
      return null;
    case 'daily_budget':
      // A CONFIGURED ZERO IS NOT A SPENT BUDGET, and telling an operator to
      // wait for midnight is false there: the reset zeroes `used`, not the
      // limit, so `0 >= 0` refuses again on the first tick of the new day and
      // every tick after it. A today-only override of 0 is a different thing —
      // it expires and the configured value comes back — so the CONFIGURED
      // value is what decides, never the effective one.
      //
      // Its own headline, so it is its own obstacle: a task parked under an
      // ordinary spent budget when somebody sets the allowance to zero gets a
      // fresh record with the true story, rather than keeping the old promise.
      if (decision.dailyBudget?.configured === 0) {
        return {
          headline: 'self-started turns are switched off for this project',
          detail: `${reason} — \`[daemon] auto_react_daily_budget\` is 0`,
          what:
            `the daemon did not dispatch its reviewer: the project's allowance for turns it ` +
            `starts by itself is set to zero, so no review can run.`,
          recovery:
            `Waiting changes nothing here: local midnight resets the COUNT, not the limit, ` +
            `so a configured allowance of zero refuses every tick of every day. Raise ` +
            `\`[daemon] auto_react_daily_budget\` in lazy.toml, or lift it for today only ` +
            `with \`lazy daemon auto-budget update =50\`. If the zero is deliberate and you ` +
            `want this work in anyway, \`lazy accept ${ref} --allow-review-issues\` merges it without a ` +
            `review — that is the choice this record exists to put in front of you, not to ` +
            `take away from you.`,
          clearsItself: false,
        };
      }
      return {
        headline: 'the daily auto-react budget is spent',
        detail: reason,
        what: `the daemon did not dispatch its reviewer: ${reason}.`,
        recovery:
          `The budget resets at local midnight and the catchup dispatches on the next tick ` +
          `after that, so this one does clear itself — late rather than never. To get the ` +
          `review sooner, raise today's cap with \`lazy daemon auto-budget update +10\`; ` +
          `\`lazy daemon auto-budget list\` shows what spent it.`,
        clearsItself: true,
      };
    case 'global_pause':
      return {
        headline: 'auto-react is paused for this project',
        detail: reason,
        what: `the daemon did not dispatch its reviewer: auto-react is paused for the whole project (${reason}).`,
        recovery:
          `Nothing dispatches while the pause stands. A pause set with \`lazy daemon ` +
          `auto-budget pause\` lifts itself at local midnight, or early with \`lazy daemon ` +
          `auto-budget resume\`; an indefinite one is lifted with \`lazy config set ` +
          `auto_react on\`. The review dispatches on the first tick after that. ` +
          // The pause was somebody's deliberate act, so "undo it" is the one
          // remedy they may not want: a project-wide pause holds acceptance on
          // EVERY task finalised while it stands. Naming the one-flag route
          // that keeps the pause is what makes the gate a choice rather than
          // an obstruction.
          `If the pause is deliberate and you want this work in anyway, ` +
          `\`lazy accept ${ref} --allow-review-issues\` merges it without a review — pausing says "do ` +
          `not spend tokens without me", not "this work has been read", so the decision ` +
          `stays yours to make per task.`,
        clearsItself: false,
      };
    case 'task_paused':
    case 'auto_turn_budget':
    case 'trigger_limit':
      return {
        headline: 'auto-react is paused for this task',
        detail: reason,
        what: `the daemon did not dispatch its reviewer: auto-react is paused for this task (${reason}).`,
        recovery:
          `Nothing dispatches while the pause stands — it holds whether a person set it or ` +
          `the daemon did after its retries ran out. Resume with \`lazy config set ` +
          `auto_react on --task ${ref}\`; a human \`lazy unblock ${ref}\` clears it too, ` +
          `along with every other auto-react counter. The review dispatches on the first ` +
          `tick after that.`,
        clearsItself: false,
      };
    default:
      // A gate added without a cause: record it plainly rather than skip it.
      // The direction this must not fail in is the silent one. `clearsItself`
      // is false because nobody has said it does — the tail then tells the
      // reader to act rather than to wait for something that may never happen.
      return {
        headline: 'the review was not dispatched',
        detail: reason,
        what: `the daemon did not dispatch its reviewer: ${reason}.`,
        recovery:
          `The daemon re-checks on every tick and dispatches as soon as what stopped it ` +
          `clears.`,
        clearsItself: false,
      };
  }
}

/** Kept for the dispatch path's callers: a throw, described and recorded. */
export async function reportAutoReviewLaunchFailure(
  storage: Storage,
  task: Task,
  finalSha: string,
  /** Sequence of the turn carrying the final claim — the dedupe window for the turn. */
  finalTurnSequence: number,
  err: unknown,
): Promise<void> {
  await reportAutoReviewNotRun(storage, task, finalSha, finalTurnSequence, launchFailureCause(err));
}

export async function reportAutoReviewNotRun(
  storage: Storage,
  task: Task,
  finalSha: string,
  /** Sequence of the turn carrying the final claim — the dedupe window for the turn. */
  finalTurnSequence: number,
  cause: AutoReviewNotRunCause,
): Promise<void> {
  try {
    // The failed review TURN first: it is the gate, and it is the part a
    // journal cannot substitute for. Deduped against the record itself (the
    // newest review turn after the final already names this obstacle), never
    // against the marker below — the two guards are independent so a failure of
    // either still leaves the other's work to be retried on the next tick.
    await recordUndispatchedReviewTurn(storage, task, finalSha, finalTurnSequence, cause);

    // ONCE PER OBSTACLE, not once per final. The marker carries the headline
    // with the SHA, so a final whose blocker changes — the credential is
    // restored overnight and the day's budget is gone by morning — journals the
    // new one instead of leaving the operator acting on a message about
    // something they already fixed. A stable obstacle still writes exactly one
    // entry however many ticks pass, which is what the dedupe is for.
    const marker = `${finalSha}|${cause.headline}`;
    const seen = await storage.getTaskMetadata(task.id, NOT_RUN_MARKER_KEY);
    if (seen === marker) return;

    logger.warn(
      `Auto-review ${shortId(task.id)}: no review ran for the final at ` +
        `${finalSha.substring(0, 8)} — ${cause.headline}: ${cause.detail}. The task stays ` +
        `parked and accept is gated on the failed review; ` +
        (cause.clearsItself
          ? `the dispatch is re-tried on every tick.`
          : `it dispatches once that is dealt with, not before.`),
    );

    // The task's OWN journal first — that is the entry a person opening a
    // task of any other type sees, and without it a persistently broken runner leaves a
    // task whose only record of the problem is one line on a review turn.
    await storage.appendJournalEntry(
      task.id,
      `## The automatic review could not START\n\n` +
        `This task declared final at \`${finalSha.substring(0, 8)}\`, but ${cause.what}\n\n` +
        `${cause.recovery}\n\n` +
        `Accept IS gated on the failed review meanwhile: this work ` +
        `has not been reviewed, so merging it is a decision a person makes explicitly with ` +
        `\`lazy accept --allow-review-issues\`.`,
      'system',
    );

    const parentId = parentTaskIdOf(task);
    const parent = parentId ? await storage.getTask(parentId) : null;
    if (parentId && parent && isClusterTask(parent)) {
      // WRITTEN FOR A READER THAT CANNOT ACCEPT. The ordinary §8.2 hand-back
      // offers step 5's menu, and accepting is on it — but not here: the failed
      // review gates accept, and the only override (`lazy accept
      // --allow-review-issues`) is CLI/TTY-only by design, with no MCP surface.
      // A driver pointed at that menu spends turns discovering accept is
      // refused, or keeps retrying it, while the one action that gets a broken
      // reviewer FIXED — telling the operator — goes unfiled. So this entry
      // names the two routes that actually work for a driver, and says plainly
      // that accepting is not one.
      await storage.appendJournalEntry(
        parentId,
        `## Auto-review could not START on \`${task.code ?? shortId(task.id)}\`\n\n` +
          `The child declared final at \`${finalSha.substring(0, 8)}\`, but ${cause.what}\n\n` +
          `${cause.recovery}\n\n` +
          `**You cannot accept this child while that stands.** The failed review gates ` +
          `accept (\`review-issues-unaddressed\`), and the override — \`lazy accept --allow-review-issues\` ` +
          `— is CLI-only, so only the operator can use it. Do not retry accept; it will ` +
          `keep being refused. Your two routes are: RAISE one blocking item saying the ` +
          `review will not run, naming the reason above, so the operator can clear it ` +
          `(this is the action that ends it) — or CLOSE/defer the child if its ` +
          `work should not land. Unblocking the child changes nothing here: a work turn ` +
          `un-finals it, and the next final meets the same obstacle.`,
        'system',
      );
    }

    // INVARIANT: the dedupe marker is written LAST, after the report it
    // suppresses has actually landed. Written first, a single storage hiccup on
    // the journal write silenced this mechanism permanently for that SHA — and
    // a driver waiting on that child would then wait forever, which is
    // indistinguishable from the bug §8.3 exists to close.
    //
    // The failure mode this ordering chooses instead is a DUPLICATE journal
    // line on the next tick after a partial failure. That is strictly the
    // better one: a driver can read past a repeated note, but it cannot read one
    // that was never written.
    await storage.updateTaskMetadata(task.id, NOT_RUN_MARKER_KEY, marker);
  } catch (journalErr) {
    logger.warn(
      `Auto-review ${shortId(task.id)}: could not record the un-run review — ` +
        `${journalErr instanceof Error ? journalErr.message : journalErr}. ` +
        `It will be reported again on the next tick.`,
    );
  }
}

/**
 * Record a review that never ran — a dispatch that threw, or a gate that
 * stopped it being dispatched at all — as a FAILED review turn on the task.
 *
 * Deliberately shaped like `recordReviewErrorTurn`'s crashed-reviewer turn: an
 * agent review turn carrying an unparsed report, which every surface already
 * knows how to read — it gates accept (`reviewIssuesAwaitingWork`), it shows in
 * Reviews with the failure banner, and `describeFailedReview` tells a driver
 * which of the three failures this was.
 *
 * Written once per OBSTACLE, and the dedupe is DERIVED — there is no marker to
 * lose. Three cases, in order:
 *
 *   - A review turn after the final that actually RAN (crashed or replied)
 *     means this final has been looked at. Nothing more is recorded, whatever
 *     the gates say now.
 *   - The NEWEST never-started record already names this obstacle: the same
 *     wall, one tick later. Nothing to add.
 *   - A DIFFERENT obstacle now holds the review, so a fresh record supersedes
 *     the old one. The gate and the Reviews tab both read the newest review, so
 *     that is what makes them name the wall that is actually standing. Keyed on
 *     the HEADLINE, not the whole verdict, so a budget count ticking or an
 *     error string flapping is the same obstacle and writes nothing.
 *
 * Superseding rather than editing is deliberate: turns are append-only, the
 * sequence of records is a true history of what blocked this final and for how
 * long, and every record gates identically so the accumulation costs nothing at
 * the gate.
 *
 * Never throws: it runs inside the catchup's per-task loop, and one task's
 * bookkeeping must not stop the others being dispatched.
 */
async function recordUndispatchedReviewTurn(
  storage: Storage,
  task: Task,
  finalSha: string,
  finalTurnSequence: number,
  cause: AutoReviewNotRunCause,
): Promise<void> {
  try {
    const session = await storage.getSessionByTaskId(task.id);
    if (!session) return;
    const turns = await storage.getSessionTurns(session.id);
    const reviewsAfterFinal = turns.filter(
      (t) =>
        t.role === 'agent'
        && (t.turn_type ?? 'work') === 'review'
        && t.sequence > finalTurnSequence,
    );
    if (reviewsAfterFinal.some((t) => !reviewWasNeverDispatched(t.review))) return;
    const newest = reviewsAfterFinal[reviewsAfterFinal.length - 1];
    if (newest && reviewNotRunHeadline(newest.review) === cause.headline) return;

    const sequence = await storage.reserveTurnSequences(session.id, 1);
    // NO PERSON, deliberately. Nobody asked for this row: the reconciler
    // noticed that no reviewer ever ran and is recording that fact. The
    // session's own owner is whoever asked for the WORK turn, and stamping
    // them here would put the daemon's observation on a row naming somebody
    // who did not cause it — so it names nobody, which is correctable later
    // in a way a wrong name is not.
    await createRecoveredAgentTurn(storage, {
      sessionId: session.id,
      sequence,
      role: 'agent',
      content:
        `[Review not started]\n\n` +
        `No reviewer ran for the final claim at ${finalSha.substring(0, 8)}: ${cause.what}\n\n` +
        `${cause.recovery}\n\n` +
        `No reviewer process ever existed, so nothing has read this work. ` +
        (cause.clearsItself
          // Said only where it is true. Under a pause this sentence sat
          // directly beneath "nothing dispatches while the pause stands" and
          // contradicted it — and it is the one that reads like a promise from
          // the system, so a reader waits for a dispatch that is not coming.
          ? `The dispatch is re-tried on every reconcile tick; a review that succeeds ` +
            `later supersedes this record. Until one does, accept is gated — override `
          : `The review dispatches on the first tick after the obstacle above is dealt ` +
            `with, and not before; whatever lands then supersedes this record. Until ` +
            `something does, accept is gated — override `) +
        `with \`lazy accept --allow-review-issues\` if you have decided the work is done.`,
      turnType: 'review',
      // Always 'auto': this record exists only because the DAEMON's own
      // dispatch could not start. Nobody asked for this review, so it follows
      // the mode rule like the review it stands in for.
      reviewDispatch: 'auto',
      review: {
        verdict: verdictFor(cause),
        security: REVIEW_UNPARSED,
        data_integrity: REVIEW_UNPARSED,
        findings: [],
      },
    }, null);
  } catch (err) {
    logger.warn(
      `Auto-review ${shortId(task.id)}: could not record the failed review turn for the ` +
        `dispatch failure — ${err instanceof Error ? err.message : err}. ` +
        `It will be retried on the next tick.`,
    );
  }
}

/** Clear the not-run marker once a review actually starts for this final. */
async function clearAutoReviewLaunchFailure(storage: Storage, taskId: string): Promise<void> {
  try {
    await storage.updateTaskMetadata(taskId, NOT_RUN_MARKER_KEY, '');
  } catch (err) {
    logger.debug(
      `Auto-review ${shortId(taskId)}: could not clear the not-run marker — ` +
        `${err instanceof Error ? err.message : err}`,
    );
  }
}

async function maybeAutoReview(
  storage: Storage,
  lazyRoot: string,
  task: Task,
): Promise<void> {
  const sess = await storage.getSessionByTaskId(task.id);
  if (!sess) return; // Never started — no turns, so no standing final claim.

  // INVARIANT: only `separate` mode dispatches a reviewer, and the mode is the
  // TASK's (pinned on its first launch), never re-derived from config here.
  // Engineer decision 2026-09-21, reversing the 2026-09-19 default: a cluster
  // running 8–12 children under this cycle spent every child three or more
  // ~30-minute review+fix rounds, hit the org spend limit twice, and landed 2
  // of 13 in four hours. `off` and `low_high` return BEFORE anything is
  // recorded, so nothing gates accept either — there is no review to gate on.
  //
  // Read-only: a dispatch decision may not move a task between arms, so this
  // reads what the task RECORDED and never the persisting twin.
  //
  // THE TASK'S OWN VALUE IS READ FIRST, AND CONFIG IS NOT LOADED AT ALL WHEN IT
  // ANSWERS. This runs for every reviewable task on every reconcile tick, and a
  // launched task always has its mode pinned — so parsing lazy.toml here was a
  // file read per task per tick to answer a question the task had already
  // answered. The load stays for the un-pinned case (a task from before the
  // setting existed), and the one further down for the auto-react budget.
  let config: ResolvedConfig | undefined;
  let mode = reviewSettingsStatedBy(task.metadata).mode;
  if (!mode) {
    config = await loadConfig(lazyRoot);
    mode = config.review.mode;
  }
  if (mode !== 'separate') return;

  const turns = await storage.getSessionTurns(sess.id);

  // §3.3: the trigger is derived, not remembered. A task whose latest final
  // claim has no review turn after it is owed one.
  const finalState = resolveFinalState(turns);
  if (!finalState) return;
  //
  // A turn recording a failed DISPATCH does not count as a review: it says the
  // reviewer never ran, and the retry is what makes a transient docker or
  // provider failure self-heal. It gates accept meanwhile
  // (`recordUndispatchedReviewTurn`), so retrying costs nothing that a person
  // has to undo, and a review that succeeds later supersedes it.
  //
  // AN IN-SESSION SELF-REVIEW IS NOT "this final has been reviewed" EITHER, and
  // that exclusion is what makes the documented escalation route work. A task
  // that ran under `low_high` records a self-review above its final claim; a
  // driver then escalates it to `separate` precisely BECAUSE it wants a cold
  // second read. Counting the self-review here skipped the dispatch, so nothing
  // ran — while the gate, under `always`, started holding accept on that same
  // old self-review. The escalation is a request for a different KIND of
  // review, and this dedup is about whether that kind has happened.
  const reviewed = turns.some(
    (t) =>
      t.role === 'agent' &&
      (t.turn_type ?? 'work') === 'review' &&
      t.sequence > finalState.turn_sequence &&
      !isSelfReview(t) &&
      !reviewWasNeverDispatched(t.review),
  );
  if (reviewed) return;

  // §8.1: open blocking Raises park the task for a decision — no further
  // rounds run until a human (or the driver, for its child) answers them.
  // Blocking-ness and open-ness come from the stored rows, the same rows the
  // accept gate reads, never re-derived from report text.
  const raised = await storage.getTaskRaisedItems(task.id);
  if (raised.some((r) => r.blocking && r.status === 'open')) return;

  // §8.1: the cap governs only the daemon's own rounds. A human unblock, a
  // driver hand-back or a re-final resets the counter (the reset sites in
  // auto-react-budget.ts / task-lifecycle.ts), so a cap here always means
  // THIS cycle of daemon rounds is exhausted — not an old one's.
  if ((await getFinalReviewRound(storage, task.id)) >= FINAL_REVIEW_CAP) return;

  // INVARIANT (from autoUnblockTask, final-turn design §8): never write a
  // command into a protocol dir a synchronous daemon turn is waiting on — the
  // status gate alone is insufficient, a `working` task can be mid-settle.
  if (await isTurnInFlight(storage, task.id)) return;

  // INVARIANT (engineer rule, 2026-09-20): the daemon does not act on a task
  // before the supervisor has returned control. `REVIEWABLE_STATUSES` above is
  // a status read, and a status alone cannot say that — the settle parks the
  // task before it consumes the response, and a launch in progress has written
  // its command but not yet flipped the status. A skip here is a per-tick skip
  // and records NOTHING: a review the daemon chose not to start yet is not a
  // review that failed.
  const owner = await supervisorStillOwnsTurn(lazyRoot, task, sess);
  if (owner) {
    logger.debug(
      `Auto-review ${shortId(task.id)}: not dispatching — ${owner}. Retrying on a later tick.`,
    );
    return;
  }

  const worktreePath = getWorktreePathForRef(lazyRoot, taskRef(task));
  if (!(await pathExists(worktreePath))) return;
  if (await checkLock(worktreePath)) return;

  // FROM HERE ON, A SKIP IS RECORDED. Everything above this line clears within
  // a tick or two by itself (an in-flight turn ends, a lock is released, a
  // worktree reappears) or is a §8 design park with its own record — the gates
  // below can stand for hours, so a task skipped by one of them would otherwise
  // sit with a standing final, no review, and nothing holding accept.
  const systemBlock = await systemTurnBlock(lazyRoot);
  if (systemBlock) {
    logger.warn(
      `Auto-review ${shortId(task.id)}: skipped — ${systemBlock}`,
    );
    await reportAutoReviewNotRun(
      storage, task, finalState.claim.sha, finalState.turn_sequence,
      systemCredentialCause(systemBlock),
    );
    return;
  }

  // INVARIANT ([usage_pause]): a review on a paused credential is HELD, never
  // dropped and never counted. Checked BEFORE the auto-react budget, so a held
  // dispatch takes no budget turn and no backoff step, and it never reaches
  // the settle, which is where a review round is counted. Nothing has to
  // remember it: this catchup re-derives "a final with no review after it" on
  // every tick, so the first tick after the window resets dispatches it. It is
  // RECORDED meanwhile like every other skip that can stand for hours, so
  // accept is gated on the unread work rather than open to it.
  const usageHold = await usagePauseHold(lazyRoot, storage, task, 'auto-review');
  if (usageHold) {
    logger.info(`Auto-review ${shortId(task.id)}: held by usage pause — ${usageHold}`);
    await reportAutoReviewNotRun(
      storage, task, finalState.claim.sha, finalState.turn_sequence,
      usagePauseCause(usageHold, task),
    );
    return;
  }

  const dataDir = join(lazyRoot, '.lazy');
  // Loaded here when the mode came off the task above — the budget gate and
  // `auto_fix` both need the real config, and by this point the dispatch is
  // actually going to be attempted, so the read is paid for at most once per
  // task that is genuinely owed a review.
  config ??= await loadConfig(lazyRoot);
  const decision = await shouldAutoReact(
    storage,
    task.id,
    'auto_review',
    config,
    dataDir,
  );
  if (!decision.allowed) {
    logger.info(
      `Auto-review ${shortId(task.id)}: blocked by budget (${decision.reason}) — ` +
        `it will dispatch once the budget or backoff clears.`,
    );
    const cause = autoReactSkipCause(decision, task);
    if (cause) {
      await reportAutoReviewNotRun(
        storage, task, finalState.claim.sha, finalState.turn_sequence, cause,
      );
    }
    return;
  }

  try {
    await launchReviewTask(lazyRoot, {
      taskId: task.id,
      // `auto_fix` is its OWN switch and defaults to FALSE: a review that
      // found something parks the task with its findings attached instead of
      // spending another ~30-minute round on the daemon's own initiative.
      // Whether a round is worth it is a judgement made by whoever can see the
      // whole board — the human, or a cluster's driver — and the run that
      // produced this default spent most of its four hours on rounds nobody
      // asked for.
      //
      // Read from the TASK, like the mode: a cluster that turned auto-fix on
      // for itself means its children to have it too, and a child that turned
      // it off means that to hold against the project default.
      autoFix: reviewSettingsOf(task.metadata, config.review).auto_fix,
      autoReview: true,
      actor: 'system',
    });
  } catch (err) {
    // A RACE LOST IS NOT A REVIEW THAT FAILED.
    //
    // Everything above this dispatch is a read, so between the last gate and
    // the launch another writer can take the task — a driver's own
    // `lazy_review` on its child, an unblock, a sync. The launch refuses that
    // correctly (`task_busy`, decided under the task lifecycle lock), and the
    // right response is the next tick: the other turn either IS the review this
    // task was owed, or it parks the task again and the catchup dispatches.
    //
    // Recording a FAILED TO START review here instead gated a child whose real
    // review was starting at that very instant, and the only override is
    // CLI-only — so a driver could neither accept it nor get it reviewed.
    // 2026-09-20, `teams-raised-cluster-row-one-size`.
    if (isTaskBusyRefusal(err)) {
      logger.info(
        `Auto-review ${shortId(task.id)}: another turn took the task first ` +
          `(${err instanceof Error ? err.message : err}). Not recording a failed review — ` +
          `the dispatch is re-tried on a later tick.`,
      );
      return;
    }
    // §6 of the second pass: a review that cannot START is reported, once per
    // final, instead of vanishing into a debug line. Re-thrown so the caller's
    // per-task catch keeps its own logging and the loop over parked tasks
    // carries on.
    await reportAutoReviewLaunchFailure(
      storage, task, finalState.claim.sha, finalState.turn_sequence, err,
    );
    throw err;
  }
  await clearAutoReviewLaunchFailure(storage, task.id);

  // Recorded AFTER the launch succeeded, exactly like autoUnblockTask — the
  // turn is running either way, so only a failure here is worth logging.
  try {
    await recordAutoReact(storage, task.id, 'auto_review', dataDir);
  } catch (err) {
    logger.warn(
      `Auto-review ${shortId(task.id)}: could not record the budget turn: ` +
        `${err instanceof Error ? err.message : err}`,
    );
  }
}