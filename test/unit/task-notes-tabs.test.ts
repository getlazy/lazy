/**
 * The task page's Comments and Journal tabs.
 *
 * Both surfaces existed in the domain model and nowhere in the web UI. What is
 * pinned here is the part a reader depends on and a refactor could silently
 * change: WHICH comments are shown as still queued for the agent, and the fact
 * that adding one from this page cannot start a turn.
 */

import { describe, test, expect } from 'bun:test';
import {
  taskCommentsTabHtml,
  taskJournalTabHtml,
  queuedComments,
  commentSaveFailedHtml,
} from '../../src/server/task-notes';
import type { Comment, JournalEntry, Session, TaskStatus, Turn } from '../../src/types';

const T0 = new Date('2026-09-02T10:00:00Z').getTime();

function comment(id: string, atMinutes: number, content = `body ${id}`): Comment {
  return {
    id,
    task_id: 'task-1',
    content,
    created_at: T0 + atMinutes * 60_000,
    actor: 'human',
  };
}

function journal(id: string, atMinutes: number, content = `entry ${id}`): JournalEntry {
  return { id, task_id: 'task-1', content, created_at: T0 + atMinutes * 60_000, actor: 'agent' };
}

function session(deliveredThrough: number | null): Session {
  return {
    id: 's-1',
    task_id: 'task-1',
    agent_id: 'claude-code',
    git_branch: 'lazy/task-1',
    started_at: T0,
    ended_at: null,
    outcome: null,
    notes_delivered_through: deliveredThrough,
  } as unknown as Session;
}

function agentTurn(atMinutes: number): Turn {
  return {
    id: 't-1',
    session_id: 's-1',
    sequence: 1,
    role: 'agent',
    content: 'done',
    timestamp: T0 + atMinutes * 60_000,
  } as unknown as Turn;
}

function renderComments(opts: {
  comments: Comment[];
  session?: Session | null;
  turns?: Turn[];
  status?: TaskStatus;
}): string {
  return taskCommentsTabHtml({
    taskId: 'task-1',
    taskStatus: opts.status ?? 'blocked',
    comments: opts.comments,
    session: opts.session ?? null,
    turns: opts.turns ?? [],
  });
}

describe('Comments tab', () => {
  // INVARIANT: the delivered/queued split is `resolveNotesCutoff` — the same
  // cutoff the next unblock's prompt uses. Any other rule (e.g. "since the last
  // agent turn") tells the human something different from what will happen.
  test('splits on notes_delivered_through, not on the last agent turn', () => {
    const comments = [comment('c1', 5), comment('c2', 30)];
    // An agent turn ran at +20 (an ask, say) but delivery only reached +10.
    const html = renderComments({
      comments,
      session: session(T0 + 10 * 60_000),
      turns: [agentTurn(20)],
    });
    expect(html).toContain('Seen by the agent (1)');
    expect(html).toContain('Queued for the next turn (1)');
    expect(queuedComments(comments, session(T0 + 10 * 60_000), [agentTurn(20)]).map((c) => c.id))
      .toEqual(['c2']);
  });

  // INVARIANT: only a comment the agent has NOT seen offers an edit; a seen
  // one is history the agent may have acted on, and the daemon refuses it.
  test('queued comments get an edit form, seen comments do not', () => {
    const html = renderComments({
      comments: [comment('c1', 5), comment('c2', 30)],
      session: session(T0 + 10 * 60_000),
    });
    expect(html).toContain('action="/tasks/task-1/comments/c2/edit"');
    expect(html).not.toContain('/comments/c1/edit');
    expect(html).toContain('can no longer be edited');
  });

  test('nothing delivered yet means every comment is queued', () => {
    const comments = [comment('c1', 5), comment('c2', 30)];
    const html = renderComments({ comments, session: null });
    expect(html).toContain('Queued for the next turn (2)');
    expect(html).not.toContain('Seen by the agent');
  });

  test('counts every comment in the heading and renders markdown', () => {
    const html = renderComments({ comments: [comment('c1', 5, '# Heading\n\n- one')] });
    expect(html).toContain('Comments (1)');
    expect(html).toContain('<h1');
    expect(html).toContain('<li>one</li>');
  });

  // INVARIANT (CLAUDE.md, "A lazy comment never starts a turn"): the composer
  // posts to a route that only persists. It must not target a lifecycle verb.
  test('the composer posts to the inert add route and says so', () => {
    const html = renderComments({ comments: [] });
    expect(html).toContain('action="/tasks/task-1/comments/add"');
    expect(html).not.toContain('/actions/');
    expect(html).toContain('prompt of the next unblock');
  });

  // INVARIANT: the composer is offered in EVERY status, terminal included.
  // Annotating a finished task ("Superseded by task xyz") is the documented
  // main use of `lazy comment`, and the CLI accepts one whatever the status;
  // hiding the box on the web would be an undocumented asymmetry on exactly
  // the tasks where the feature is used most. A comment is inert in every
  // status, so nothing about the never-starts-a-turn rule depends on this.
  //
  // This replaces an earlier assertion that a terminal task got NO composer.
  test('a terminal task still gets a composer, with honest wording', () => {
    const html = renderComments({ comments: [comment('c1', 5)], status: 'complete' });
    expect(html).toContain('action="/tasks/task-1/comments/add"');
    expect(html).toContain('This task has ended');
    expect(html).toContain('unless the task is reopened');
  });

  // "Never delivered" was false on a surface whose job is telling the truth
  // about delivery: this same page can reopen or redo the task, and the next
  // unblock then carries these comments like any other queued one.
  test('queued comments on a terminal task are undelivered, not undeliverable', () => {
    const html = renderComments({
      comments: [comment('c1', 30)],
      session: session(T0 + 10 * 60_000),
      turns: [agentTurn(20)],
      status: 'complete',
    });
    expect(html).toContain('Queued for the next turn (1)');
    expect(html).toContain('reopened or redone');
    expect(html).not.toContain('Never delivered');
  });

  test('the empty case explains what a comment is', () => {
    const html = renderComments({ comments: [] });
    expect(html).toContain('Comments (0)');
    expect(html).toContain('never starts a turn');
  });
});

describe('a comment that could not be saved', () => {
  // INVARIANT (CLAUDE.md, "Never Lose Human Feedback"): a failed write must not
  // swallow what someone typed. The browser has already discarded the textarea
  // by the time this page renders, so the text is echoed back verbatim.
  test('carries the submitted text back verbatim and names what failed', () => {
    const typed = '## Superseded\n\nBy task `fix-retry` — see the PR.';
    const html = commentSaveFailedHtml('task-1', typed, 'ENOSPC: no space left on device');

    expect(html).toContain('ENOSPC: no space left on device');
    // Verbatim: the markdown source, not a rendered version of it.
    expect(html).toContain('## Superseded');
    expect(html).toContain('By task `fix-retry` — see the PR.');
    expect(html).toContain('lz-kept-text');
    // And a second route to safety that does not go through the web layer.
    expect(html).toContain('lazy comment task-1');
    expect(html).toContain('/tasks/task-1/comments');
  });

  test('the echoed text is escaped, never re-injected as markup', () => {
    const html = commentSaveFailedHtml('task-1', '<img src=x onerror=alert(1)>', 'boom');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('Journal tab', () => {
  test('newest first, with counts and markdown', () => {
    const html = taskJournalTabHtml([journal('j1', 5, 'oldest'), journal('j2', 30, 'newest')]);
    expect(html).toContain('Journal (2)');
    expect(html.indexOf('newest')).toBeLessThan(html.indexOf('oldest'));
  });

  test('the empty case teaches what the journal is for', () => {
    const html = taskJournalTabHtml([]);
    expect(html).toContain('Journal (0)');
    expect(html).toContain('out-of-prompt record');
    expect(html).toContain('lazy journal');
  });

  test('entry content is escaped, not injected as HTML', () => {
    const html = taskJournalTabHtml([journal('j1', 5, '<script>alert(1)</script>')]);
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
