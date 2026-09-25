import { describe, test, expect } from 'bun:test';
import { commentAnchorHref, currentReviewHtml } from '../../src/server/current-review';
import { fileSectionId } from '../../src/server/review-diff';
import { taskPageHtml } from '../../src/server/task-page';
import {
  busyUnblockAcceptReason,
  reviewScript,
  type ReviewLiveState,
} from '../../src/server/review';
import { actionDialogButtonHtml } from '../../src/server/action-dialog';
import type { ReviewComment, RaisedItem, ReviewReport, Task } from '../../src/types';

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    task_id: 'task-1',
    thread_id: 'th-1',
    file: 'src/foo.ts',
    line: 4,
    side: 'new',
    role: 'human',
    content: 'rename this',
    created_at: 1,
    intent: 'comment',
    delivery_state: 'pending_delivery',
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    code: 'review-tab',
    goal: 'Ship the Current review tab',
    prompt: 'Do the work',
    type: 'task',
    status: 'blocked',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
    ...over,
  } as Task;
}

describe('commentAnchorHref', () => {
  test('diff lines go to Changes', () => {
    expect(commentAnchorHref('t1', comment())).toBe('/tasks/t1/changes#l-src%2Ffoo.ts-new-4');
  });

  test('report prose goes to Landing', () => {
    expect(commentAnchorHref('t1', comment({ file: '(report)', line: 3 }))).toBe('/tasks/t1#prose-3');
  });

  test('raised-item prose goes to the raised page', () => {
    expect(commentAnchorHref('t1', comment({ file: '(raised:abc-123)', line: 1 }))).toBe('/raised/abc-123');
    expect(commentAnchorHref('t1', comment({ file: '(followup:old)', line: 1 }))).toBe('/raised/old');
  });

  test('task-level comments stay on Current review', () => {
    expect(commentAnchorHref('t1', comment({ file: '(task)', line: 0 }))).toBe(
      '/tasks/t1/review#thread-th-1',
    );
  });
});

describe('currentReviewHtml', () => {
  const live: ReviewLiveState = {
    status: 'blocked',
    turns: 1,
    lastActiveAt: 1,
    askable: true,
    askUnavailable: null,
  };

  test('empty state still has the checklist, progress, actions, and where comments come from', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).toContain('Before you can accept');
    expect(html).toContain('0 comments queued');
    expect(html).toContain('data-lz-action-open="ask"');
    expect(html).toContain('data-lz-action-open="unblock"');
    expect(html).toContain('data-lz-action-open="accept"');
    expect(html).toContain('data-lz-action-open="submit"');
    expect(html).toContain('Unblock');
    expect(html).toContain('Accept');
    expect(html).toContain('Submit');
    expect(html).toContain('Reject');
    expect(html).toContain('Sync');
    expect(html).toContain('Comment on a line in Changes, or on the report from Summary');
    expect(html.match(/data-rv-actions/g)?.length).toBe(1);
    expect(html.match(/class="rv-actions"/g)?.length).toBe(1);
  });

  // INVARIANT: a working task must not offer Unblock/Accept — the daemon 409s,
  // and a stale Current-review page after `lazy review` used to look like a
  // silent refusal ("it refuses turns but doesn't say so"). Ask stays open so
  // a question can still be saved for later. The busy reason is VISIBLE copy
  // (data-rv-busy-reason), not only a title tooltip, and the buttons are
  // HIDDEN rather than disabled (the engineer's call: a greyed-out control
  // cannot say why it is off) while keeping data-lz-action-open so the island
  // can show them again from the live poll. Sync hides behind the same gate
  // instead of rendering as a dead button. Reject does NOT: the daemon rejects
  // a working task (it stops the runner first), so it stays offered.
  test('working status hides Unblock, Accept and Sync behind one visible reason, and keeps Reject', () => {
    const html = currentReviewHtml({
      task: task({ status: 'working' }),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live: {
        status: 'working',
        turns: 2,
        lastActiveAt: 1,
        askable: false,
        askUnavailable: 'Task is working — the agent can only answer while the task is blocked or in conflict.',
      },
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).toContain('data-lz-action-open="unblock"');
    expect(html).toContain('data-lz-action-open="accept"');
    expect(html).toContain('data-lz-action-open="ask"');
    expect(html).toContain('data-rv-busy-gate');
    expect(html).toContain('data-rv-busy="1"');
    for (const verb of ['unblock', 'accept', 'sync']) {
      expect(html).toMatch(new RegExp(`data-lz-action-open="${verb}"[^>]*data-rv-busy-gate hidden`));
    }
    expect(html).toMatch(/data-lz-action-open="reject"[^>]*>Reject<\/button>/);
    expect(html).not.toMatch(/data-lz-action-open="reject"[^>]*hidden/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled/);
    // Visible body text — not only a title tooltip.
    expect(html).toMatch(/data-rv-busy-reason[^>]*>[^<]*The agent is working/);
    // Templates stay mounted so a poll that clears the gate needs no reload.
    expect(html).toContain('data-lz-action-template="unblock"');
    expect(html).toContain('data-lz-action-template="accept"');
    // INVARIANT: noscript must not offer Unblock/Accept while busy — a no-JS
    // POST would only hit the daemon 409 (silent-refusal class for that surface).
    const noscriptBlocks = html.match(/<noscript>[\s\S]*?<\/noscript>/g) ?? [];
    const noscriptJoined = noscriptBlocks.join('\n');
    expect(noscriptJoined).not.toContain('/review/unblock');
    expect(noscriptJoined).not.toContain('/review/accept');
    // Ask may still POST without JS.
    expect(noscriptJoined).toContain('/review/ask');
  });

  test('pairing status shows the same visible busy gate as working', () => {
    const html = currentReviewHtml({
      task: task({ status: 'pairing' }),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live: {
        status: 'pairing',
        turns: 1,
        lastActiveAt: 1,
        askable: false,
        askUnavailable: 'Task is pairing — the agent can only answer while the task is blocked or in conflict.',
      },
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).toContain('data-rv-busy="1"');
    expect(html).toMatch(/data-rv-busy-reason[^>]*>[^<]*pairing on this task/);
  });

  test('idle Current review hides the busy reason and leaves Unblock enabled', () => {
    const html = currentReviewHtml({
      task: task({ status: 'blocked' }),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).toContain('data-rv-busy="0"');
    expect(html).toContain('data-rv-busy-reason hidden');
    expect(html).toContain('data-lz-action-open="unblock"');
    // Soft-disabled path is off — no disabled on the Unblock opener itself.
    expect(html).not.toMatch(/data-lz-action-open="unblock"[^>]*\sdisabled/);
    // Idle: noscript Unblock/Accept forms are restored for no-JS browsers.
    const noscriptBlocks = html.match(/<noscript>[\s\S]*?<\/noscript>/g) ?? [];
    const noscriptJoined = noscriptBlocks.join('\n');
    expect(noscriptJoined).toContain('/review/unblock');
    expect(noscriptJoined).toContain('/review/accept');
  });

  test('busyUnblockAcceptReason matches the island wording for working and pairing', () => {
    expect(busyUnblockAcceptReason('working')).toContain('The agent is working');
    expect(busyUnblockAcceptReason('pairing')).toContain('pairing on this task');
    const script = reviewScript('task-1');
    expect(script).toContain('The agent is working — the actions that change this task come back here once it pauses.');
    expect(busyUnblockAcceptReason('blocked')).toBeNull();
  });

  // INVARIANT: the live poll must flip Unblock / Accept from the same feed
  // that updates the status bar — first-paint-only disable left a mid-review
  // page offering clicks the daemon 409'd with no page-side explanation.
  test('review island refreshes the Unblock/Accept busy gate from the threads poll', () => {
    const script = reviewScript('task-1');
    expect(script).toContain('function renderActionBusy');
    expect(script).toContain('data-rv-busy-gate');
    expect(script).toContain('data-rv-busy-reason');
    expect(script).toContain('renderActionBusy(st.status)');
    // Fast poll while working/pairing so the gate flips soon after Review.
    expect(script).toContain("st.status === 'working' || st.status === 'pairing'");
  });

  test('reenableable disabled Unblock keeps data-lz-action-open for a live flip', () => {
    const html = actionDialogButtonHtml({
      verb: 'unblock',
      label: 'Unblock',
      disabledReason: 'Task is working — wait for it to finish before unblocking or accepting.',
      reenableable: true,
      extraAttrs: 'data-rv-busy-gate',
    });
    expect(html).toContain('data-lz-action-open="unblock"');
    expect(html).toContain('data-rv-busy-gate');
    expect(html).toContain('disabled');
    expect(html).toContain('wait for it to finish');
  });

  test('verify progress is on the summary when the current turn has steps', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
      verifyProgress: { verified: 2, total: 5 },
    });
    expect(html).toContain('2 of 5 steps verified');
  });

  test('checklist names a review-with-issues gate even when every Raise is non-blocking', () => {
    const item: RaisedItem = {
      id: 'raise-tidy',
      task_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      content: 'Optional tidy.',
      title: 'Optional tidy',
      blocking: false,
      created_at: 1,
      status: 'open',
    };
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [item],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
      turns: [
        { sequence: 1, role: 'agent', turn_type: 'work' },
        {
          sequence: 2,
          role: 'agent',
          turn_type: 'review',
          review: {
            verdict: 'needs_human',
            security: 'none found',
            data_integrity: 'none found',
            findings: [],
            raised_item_ids: ['raise-tidy'],
          },
        },
      ],
    });
    expect(html).toContain('Formal review (turn #2) raised 1 issue');
    expect(html).toContain('no work turn has run since');
    expect(html).toContain('→ Reviews');
    expect(html).not.toContain('Nothing is blocking accept from this tab');
  });

  test('checklist still names the review-with-issues gate after every Raise is dismissed', () => {
    const item: RaisedItem = {
      id: 'raise-done',
      task_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      content: 'Already dismissed.',
      title: 'Already dismissed',
      blocking: true,
      created_at: 1,
      status: 'dismissed',
    };
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [item],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
      turns: [
        { sequence: 1, role: 'agent', turn_type: 'work' },
        {
          sequence: 3,
          role: 'agent',
          turn_type: 'review',
          review: {
            verdict: 'needs_human',
            security: 'none found',
            data_integrity: 'none found',
            findings: [],
            raised_item_ids: ['raise-done'],
          },
        },
      ],
    });
    expect(html).toContain('Formal review (turn #3) raised 1 issue');
    expect(html).not.toContain('Already dismissed');
    expect(html).not.toContain('Nothing is blocking accept from this tab');
  });

  // INVARIANT: a FAILED review gates with nothing to COUNT — its findings list
  // may be exactly what did not parse — so the checklist must say what is
  // actually wrong. "0 issues still unaddressed" on the page that exists to
  // explain the gates would read like nothing is wrong at all.
  //
  // And it must name WHICH failure. Three land here (a reviewer that never
  // finished, unreadable sweep statements, a verdict outside the set) and the
  // reader cannot act without knowing which. For a review written under the
  // PREVIOUS contract — a real verdict, both sweeps present — the old blanket
  // "FAILED to parse" was simply untrue.
  test('checklist quotes the verdict that is not one of the three', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
      turns: [
        { sequence: 1, role: 'agent', turn_type: 'work' },
        {
          sequence: 3,
          role: 'agent',
          turn_type: 'review',
          review: {
            verdict: 'approve with nits',
            security: 'none found',
            data_integrity: 'none found',
            findings: [],
          },
        },
      ],
    });
    expect(html).toContain('Formal review (turn #3) ended with the verdict');
    expect(html).toContain('approve with nits');
    expect(html).toContain('not one of clean / needs_work / needs_human');
    expect(html).not.toContain('raised 0 issues');
    expect(html).not.toContain('Nothing is blocking accept from this tab');
  });

  test('checklist names a blocking raised item and links to Raised', () => {
    const item: RaisedItem = {
      id: 'raise-keep-flag',
      task_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      content: 'Keep the legacy flag?',
      title: 'Keep the legacy flag?',
      blocking: true,
      created_at: 1,
      status: 'open',
    };
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [item],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).toContain('Keep the legacy flag?');
    expect(html).toContain('/raised/raise-keep-flag');
    expect(html).toContain('→ Raised');
  });

  test('checklist names an undecided protected file and links to Changes', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [],
      fileViolations: [{ file: 'src/secret.ts', base_sha: 'abc', status: 'pending' }],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).toContain('src/secret.ts');
    expect(html).toContain('has no decision');
    expect(html).toContain('→ Changes');
    // Land on the file card, not the top of the Changes tab. Task links
    // carry the task's code.
    expect(html).toContain(
      `href="/tasks/review-tab/changes#${fileSectionId('src/secret.ts')}"`,
    );
    // INVARIANT (approval-happens-at-accept — move-file-approval-to-accept):
    // the Unblock dialog asks NOTHING about protected files. The checklist above
    // is disclosure for the ACCEPT gate; unblock reverts nothing, so a per-file
    // question there would be a decision with no consequence.
    expect(html).not.toContain('data-lz-unblock-pending');
    expect(html).not.toContain('name="lz_vd:src/secret.ts"');
    expect(html).not.toContain('value="revert"');
  });

  test('a rejected protected file gates accept and adds nothing to Unblock', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [],
      fileViolations: [{ file: 'src/gone.ts', base_sha: 'abc', status: 'rejected' }],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).toContain('src/gone.ts');
    expect(html).toContain('has no decision');
    // Nothing reverts it — the reviewer decides at accept.
    expect(html).not.toContain('will be reverted');
    expect(html).not.toContain('data-lz-unblock-pending');
    expect(html).not.toContain('name="lz_vd:src/gone.ts"');
  });

  test('queued comment links to its Changes line and offers withdraw', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [comment()],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: { 'src/foo.ts': 'hash' },
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).toContain('1 comment queued');
    expect(html).toContain('carrying the 1 queued comment');
    expect(html).toContain('1 file viewed');
    expect(html).toContain('/tasks/review-tab/changes#');
    expect(html).toContain('Withdraw');
    expect(html).toContain('data-lz-action-open="ask"');
  });

  test('non-askable live state still offers Ask', () => {
    const html = currentReviewHtml({
      task: task({ status: 'backlog' }),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live: {
        status: 'backlog',
        turns: 0,
        lastActiveAt: null,
        askable: false,
        askUnavailable: 'Task is backlog — the agent can only answer while the task is blocked or in conflict.',
      },
      hasOpenSession: false,
      hasCommits: false,
    });
    expect(html).toContain('data-lz-action-open="ask"');
    expect(html).toContain('Task is backlog');
  });

  test('a prose-anchored ask renders as a report conversation with its quote', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [
        comment({
          file: '(report)',
          line: 42,
          intent: 'ask',
          ask_state: 'answered',
          delivery_state: undefined,
          content: 'PROSE_Q: why?',
          anchor_snippet: 'I have completed the task. All changes have been committed.',
        }),
      ],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).toContain('rv-prose-thread');
    expect(html).toContain('I have completed the task. All changes have been committed.');
    expect(html).toContain('PROSE_Q: why?');
  });

  test('submit disclosure is a checkbox when the target is protected', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
      submitPreflight: {
        canSubmit: true,
        targetBranch: 'main',
        taskCode: 'review-tab',
        targetIsProtected: true,
        confirmationTier: 'plain',
        forgeName: 'GitHub',
      },
    });
    expect(html).toContain('name="confirm"');
    expect(html).toContain('Yes, create the PR');
    expect(html).not.toContain('name="typed_confirmation"');
  });

  // INVARIANT: a preflight refusal must not hide or disable Submit. The
  // engineer could not find the button when it was greyed out or omitted;
  // the dialog is where the reason belongs.
  test('a submit refusal stays in the dialog, and the button stays enabled', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
      submitPreflight: {
        canSubmit: false,
        refusal: 'Submit requires a remote driver (e.g., github). Local driver has no remote to create PRs on.',
        targetBranch: '',
        taskCode: 'review-tab',
        targetIsProtected: 'unknown',
        confirmationTier: 'none',
        forgeName: 'GitHub',
      },
    });
    expect(html).toContain('data-lz-action-open="submit"');
    expect(html).not.toContain('disabled title="Submit requires a remote driver');
    expect(html).toContain('Local driver has no remote');
  });

  test('submit disclosure is strong when the target is unprotected', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
      submitPreflight: {
        canSubmit: true,
        targetBranch: 'main',
        taskCode: 'review-tab',
        targetIsProtected: false,
        confirmationTier: 'strong',
        forgeName: 'GitHub',
      },
    });
    expect(html).toContain('name="typed_confirmation"');
    expect(html).toContain('not protected');
  });

  test('Summary header offers Submit on a blocked task', () => {
    const html = taskPageHtml({
      task: task(),
      session: null,
      turns: [],
      commits: [],
      comments: [],
      journal: [],
      raisedItems: [],
      children: [],
      promptVersions: [],
      tab: 'landing',
      submitPreflight: {
        canSubmit: true,
        targetBranch: 'main',
        taskCode: 'review-tab',
        targetIsProtected: true,
        confirmationTier: 'plain',
        forgeName: 'GitHub',
      },
    });
    expect(html).toContain('data-lz-action-open="submit"');
    expect(html).toContain('Yes, create the PR');
  });

  // INVARIANT: a protected-branch refusal's gate text is the failed-step
  // analogue (the Current review notice). The always-on header must not
  // repeat it — that was the double "would merge" on a noscript accept.
  test('a refused accept paints the gate text once on Current review, not also in the header', () => {
    const gate =
      'Accepting task review-tab would merge `lazy/review-tab` into `main`, which requires human approval.';
    const html = taskPageHtml({
      task: task({ status: 'conflict' }),
      session: null,
      turns: [],
      commits: [],
      comments: [],
      journal: [],
      raisedItems: [],
      children: [],
      promptVersions: [],
      tab: 'review',
      review: {
        notice: { text: `Accept failed: ${gate}`, error: true },
        remedy: {
          reason: 'approval-required',
          next: 'This merge is protected — approve it with the approval passphrase, then it proceeds.',
          command: 'lazy accept review-tab --approve-file docs/spec.md',
          uiAction: 'passphrase',
          files: ['docs/spec.md'],
        },
      },
    });
    expect(html.split('would merge').length - 1).toBe(1);
    expect(html).toContain('lz-current-review');
    expect(html).toContain('name="passphrase"');
    expect(html).toContain('Approve and accept');
  });

  // INVARIANT (this task): a missing final is NOT a gate row. Accept works from
  // any normal park — the human deciding with the open items in hand IS the
  // declaration — so a checklist row saying "nobody has said this work is
  // finished" described a refusal that does not happen, and named a command
  // (`lazy finalize`) that no longer exists.
  test('a task with no final shows no gate row for it', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).not.toContain('No final declaration');
    expect(html).not.toContain('lazy finalize');
    expect(html).not.toContain('--final<');
    // The BANNER still says whether anyone declared it — that is the part a
    // reviewer wants to know, and it is not a gate.
    expect(html).toContain('Not declared done');
    expect(html).toContain('Nothing is blocking accept from this tab');
  });

  test('a standing final is shown as declared, and still gates nothing', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
      final: {
        claim: { sha: 'abc', actor: 'agent', at: 1, wrap_up_steps: [] },
        turn_sequence: 3,
        head_sha: 'abc',
        head_moved: false,
        moved_by: [],
        head_moved_label: null,
      },
    });
    expect(html).toContain('Declared done');
    expect(html).toContain('Nothing is blocking accept from this tab');
  });
});

/**
 * The accept gate's failed-review row renders text an AGENT wrote.
 *
 * `describeReviewFailureShort`'s fallback arm quotes the reviewer's own verdict
 * string verbatim, and `parseReviewReport` takes any non-empty string as a
 * verdict — so the row carries unsanitised agent output onto a page the
 * operator opens in a browser that holds a dashboard session cookie. A
 * never-started record widens the same path: its verdict can carry a pause
 * reason somebody typed at the CLI.
 */
describe('the accept gate row escapes what it renders', () => {
  const gateHtml = (
    verdict: string,
    security = 'unparsed',
    dataIntegrity = 'unparsed',
    findings: ReviewReport['findings'] = [],
  ) =>
    currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live: {
        status: 'blocked',
        turns: 1,
        lastActiveAt: 1,
        askable: true,
      } as ReviewLiveState,
      hasOpenSession: true,
      hasCommits: true,
      turns: [
        { sequence: 1, role: 'agent', turn_type: 'work' },
        {
          sequence: 2,
          role: 'agent',
          turn_type: 'review',
          review: { verdict, security, data_integrity: dataIntegrity, findings },
        },
      ],
    });

  // INVARIANT: every dynamic value on these rows is escaped. This one was not,
  // and it is the only one whose content an agent chooses: a review returning
  // `{"verdict": "<img src=x onerror=…>"}` is 46 characters, survives the
  // 60-character quote intact, resolves `unparsed`, gates accept — and then
  // executes in the operator's browser when they open the task to find out why.
  test('a verdict carrying markup cannot execute on the page', () => {
    const html = gateHtml(
      '<img src=x onerror=alert(1)>',
      'none found',
      'none found',
    );
    // The row is rendered — this is a gating failed review…
    expect(html).toContain('Formal review (turn #2)');
    expect(html).toContain('which is not one of clean / needs_work / needs_human');
    // …and the markup arrives as text, not as a tag.
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  // The same line now carries never-started records, whose detail can include a
  // `--reason` string a human typed. The headline is fixed text, so this is
  // belt-and-braces on the shape rather than on today's values.
  test('a never-started record is escaped too', () => {
    const html = gateHtml('FAILED TO START: auto-react is paused for this task — <b>off</b>');
    expect(html).toContain('never started');
    expect(html).not.toContain('<b>off</b>');
  });

  // A never-started review has no findings to address and no agent to send them
  // to — unblocking un-finals the task and its next final meets the same
  // obstacle — so the row points at the record that says what to clear.
  test('a never-started row does not offer "Unblock to address"', () => {
    const neverRan = gateHtml('FAILED TO START: the daily auto-react budget is spent — 50/50');
    expect(neverRan).toContain('→ Reviews');
    expect(neverRan).not.toContain('Unblock to address');

    // A review that RAN and left findings still offers it.
    const ran = gateHtml('needs_work', 'none found', 'none found', [
      { severity: 'high', category: 'correctness', summary: 'the retry path swallows errors' },
    ]);
    expect(ran).toContain('Unblock to address');
  });
});

describe('Current review: queued task comments and unavailable verbs', () => {
  const live: ReviewLiveState = {
    status: 'working',
    turns: 1,
    lastActiveAt: 1,
    askable: false,
    askUnavailable: null,
  };
  const note = {
    id: 'n1',
    task_id: 'task-1',
    content: 'also handle the empty case',
    created_at: 5,
  } as unknown as import('../../src/storage').Comment;

  // INVARIANT: a task comment the agent has not been shown is QUEUED on this
  // page, counted, listed, and named in "Before you can accept". The page used
  // to read only web-review comments and told a reviewer "0 comments queued"
  // and "Nothing is blocking accept" while the Comments tab held one queued.
  test('an undelivered task comment is counted, listed and gates accept', () => {
    const html = currentReviewHtml({
      task: task({ status: 'working' }),
      comments: [],
      queuedNotes: [note],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live,
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).toContain('1 comment queued');
    expect(html).toContain('Queued comments (1)');
    expect(html).toContain('also handle the empty case');
    expect(html).not.toContain('Nothing is blocking accept from this tab');
    expect(html).toContain('1 queued comment has not reached the agent');
    // The Unblock dialog counts it too, and Accept offers the explicit override.
    expect(html).toContain('carrying the 1 queued comment');
    expect(html).toContain('name="allow_queued_comments"');
  });

  // INVARIANT: the gate row counts only what accept refuses on — HUMAN
  // feedback. A builder/agent/system comment is still listed as queued (the
  // next Unblock carries it) but never gates, or automations that write such
  // comments would wedge the tasks they steer.
  test('a queued comment nobody human wrote is listed but does not gate', () => {
    const html = currentReviewHtml({
      task: task({ status: 'blocked' }),
      comments: [],
      queuedNotes: [{ ...note, actor: 'builder' } as typeof note],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live: { ...live, status: 'blocked', askable: true },
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).toContain('1 comment queued');
    expect(html).toContain('Nothing is blocking accept from this tab');
    expect(html).not.toContain('name="allow_queued_comments"');
  });

  test('pairing hides Reject with its own reason in text', () => {
    const html = currentReviewHtml({
      task: task({ status: 'pairing' }),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live: { ...live, status: 'pairing' },
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).not.toContain('data-lz-action-open="reject"');
    expect(html).toContain('<strong>Reject</strong> — This task is locked while someone is pairing on it.');
  });

  test('the not-final banner is one plain line', () => {
    const html = currentReviewHtml({
      task: task(),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live: { ...live, status: 'blocked', askable: true },
      hasOpenSession: true,
      hasCommits: true,
    });
    expect(html).toContain('The agent has not declared its work final.');
    expect(html).not.toContain('lazy_final');
  });

  // INVARIANT: a review-end verb the task cannot take is EXPLAINED in text,
  // never drawn as a disabled button that cannot say why.
  test('a refused Reject is a line of text naming the reason', () => {
    const html = currentReviewHtml({
      task: task({ status: 'blocked' }),
      comments: [],
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live: { ...live, status: 'blocked', askable: true },
      hasOpenSession: false,
      hasCommits: true,
    });
    expect(html).not.toContain('data-lz-action-open="reject"');
    expect(html).toContain('<strong>Reject</strong> — This task has no open agent session to reject.');
    expect(html).toContain('data-lz-action-open="sync"');
    expect(html).not.toMatch(/<button[^>]*\sdisabled/);
  });
});
