/**
 * Unit tests for review-session preamble assembly.
 *
 * INVARIANT: the preamble is mechanistic context — section presence, explicit
 * truncation markers, and hard-cap trimming are all load-bearing for the
 * builder review session (docs/reviews/ui-builder-review-session.md §3).
 */

import { describe, test, expect } from 'bun:test';
import type { RaisedItem, ReviewComment, Session, Task, Turn } from '../../src/types';
import {
  REPORT_BUDGET,
  DIFF_INLINE_BUDGET,
  PREAMBLE_HARD_CAP,
  KEY_FILES_N,
  truncateWithMarker,
  utf8ByteLength,
  parseNumstatChurn,
  parseDiffStatFileLines,
  buildReviewPreambleSections,
  applyPreambleHardCap,
  assembleReviewPreambleFromInputs,
  type ReviewPreambleGitOps,
  type ReviewPreambleInputs,
} from '../../src/daemon/review-session-preamble';

function mockTask(over: Partial<Task> = {}): Task {
  return {
    id: 'abc123456789',
    code: 'demo-task',
    goal: 'Ship the review preamble assembler',
    prompt: 'Build assembleReviewPreamble',
    type: 'task',
    status: 'blocked',
    created_at: 1_700_000_000_000,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: 'opus',
    agent_id: 'claude-code',
    runner_type: null,
    metadata: { effort: 'high' },
    tags: [],
    pending_sync: 0,
    ...over,
  } as Task;
}

function mockSession(over: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    task_id: 'abc123456789',
    agent_id: 'claude-code',
    started_at: 1_700_000_000_000,
    ended_at: null,
    outcome: null,
    git_branch: 'lazy/demo-task',
    git_start_sha: 'deadbeef',
    agent_session_id: null,
    last_interaction_at: null,
    total_duration_ms: 0,
    total_usage: null,
    container_name: null,
    container_agent_id: null,
    runner_type: null,
    interrupt_reason: null,
    interrupt_exit_code: null,
    interrupt_at: null,
    interrupt_logs: null,
    consecutive_interruptions: 0,
    auto_resumed: false,
    user_stopped: false,
    upstream_merge_sha: null,
    ...over,
  };
}

let seq = 0;
function turn(role: Turn['role'], content: string, extra: Partial<Turn> = {}): Turn {
  return {
    id: `t${seq}`,
    session_id: 'sess-1',
    sequence: seq++,
    role,
    content,
    timestamp: 1_700_000_000_000 + seq,
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    ...extra,
  };
}

function baseInput(over: Partial<ReviewPreambleInputs> = {}): ReviewPreambleInputs {
  seq = 0;
  return {
    task: mockTask(),
    session: mockSession(),
    parentTask: null,
    raisedItems: [],
    pendingAsks: [],
    turns: [
      turn('human', 'Please implement the preamble', { actor: 'human' }),
      turn('agent', 'Implemented assembleReviewPreamble with budgets.', { model: 'opus', effort: 'high' }),
    ],
    worktreePath: '/tmp/wt',
    parentBranch: 'main',
    fromRef: 'main',
    useTwoDotDiff: false,
    parentTipSha: 'a1b2c3d',
    ...over,
  };
}

function mockGit(over: Partial<ReviewPreambleGitOps> = {}): ReviewPreambleGitOps {
  return {
    getDiffStat: async () => ' src/foo.ts | 10 +++++-----\n 1 file changed, 7 insertions(+), 3 deletions(-)',
    getDiffFull: async () => 'diff --git a/src/foo.ts b/src/foo.ts\n+new line\n',
    getDiffNumstat: async () => '7\t3\tsrc/foo.ts\n',
    resolveParentTipSha: async () => 'a1b2c3d',
    branchExists: async () => true,
    ...over,
  };
}

describe('review-session-preamble helpers', () => {
  test('truncateWithMarker appends an explicit marker when over budget', () => {
    const body = 'x'.repeat(REPORT_BUDGET);
    const { text, truncated } = truncateWithMarker(body, 100, '[truncated — use lazy_show sections=turns]');
    expect(truncated).toBe(true);
    expect(text).toContain('[truncated — use lazy_show sections=turns]');
    expect(utf8ByteLength(text)).toBeLessThanOrEqual(100 + 64);
  });

  test('parseNumstatChurn ranks paths by insertions + deletions', () => {
    const ranked = parseNumstatChurn('1\t1\ta.ts\n10\t5\tb.ts\n2\t0\tc.ts\n');
    expect(ranked.map(f => f.path)).toEqual(['b.ts', 'a.ts', 'c.ts']);
    expect(ranked[0].churn).toBe(15);
  });

  test('parseDiffStatFileLines skips the summary row', () => {
    const lines = parseDiffStatFileLines(
      ' src/foo.ts | 3 ++-\n README.md | 1 +\n 2 files changed, 4 insertions(+), 1 deletion(-)\n',
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('src/foo.ts');
  });
});

describe('buildReviewPreambleSections', () => {
  test('includes header, identity, latest report, diff overview, how-to, and closer', async () => {
    const md = (await buildReviewPreambleSections(baseInput(), mockGit())).join('\n\n');
    expect(md).toContain('## Review session — demo-task (abc12345)');
    expect(md).toContain('do NOT spend a turn rediscovering');
    expect(md).toContain('### Identity');
    expect(md).toContain('**goal:** Ship the review preamble assembler');
    expect(md).toContain('**parent:** top-level');
    expect(md).toContain('### Latest agent report');
    expect(md).toContain('Implemented assembleReviewPreamble');
    expect(md).toContain('### Diff overview');
    expect(md).toContain('### How to use this session');
    expect(md).toContain('Open items and initial read first; then wait for the human.');
  });

  // INVARIANT: Open items is omitted entirely when there is nothing open —
  // an empty heading would invite the builder to hunt for phantom blockers.
  test('omits Open items when there are no raised items or pending asks', async () => {
    const md = (await buildReviewPreambleSections(baseInput(), mockGit())).join('\n\n');
    expect(md).not.toContain('### Open items');
  });

  // INVARIANT: Open items lists BOTH flags, blocking first — the reviewer must
  // see what accept will refuse on before the orthogonal notes, but a
  // non-blocking item is still an open item and must not be dropped.
  test('includes raised items of either flag and pending ask previews when present', async () => {
    const raisedItems: RaisedItem[] = [
      {
        id: 'f1', task_id: 'abc123456789', content: 'Retry path swallows errors',
        created_at: 1_700_000_100_000, status: 'open', blocking: false,
      },
      {
        id: 'b1', task_id: 'abc123456789', content: 'Should the new flag default on?',
        created_at: 1_700_000_150_000, status: 'open', blocking: true,
      },
    ];
    const pendingAsks: ReviewComment[] = [
      {
        id: 'c1',
        task_id: 'abc123456789',
        thread_id: 'c1',
        file: 'src/foo.ts',
        line: 12,
        side: 'new',
        role: 'human',
        content: 'Why drop the retry here?',
        created_at: 1_700_000_200_000,
        ask_state: 'pending',
      },
    ];
    const md = (await buildReviewPreambleSections(
      baseInput({ raisedItems, pendingAsks }),
      mockGit(),
    )).join('\n\n');
    expect(md).toContain('### Open items');
    expect(md).toContain('Retry path swallows errors');
    expect(md).toContain('Should the new flag default on?');
    // Blocking is listed first and says what it costs.
    expect(md).toContain('blocking — accept refuses while open');
    expect(md.indexOf('Should the new flag default on?'))
      .toBeLessThan(md.indexOf('Retry path swallows errors'));
    expect(md).toContain('pending review-ask threads:** 1');
    expect(md).toContain('Why drop the retry here?');
  });

  test('truncates an oversized latest agent report with an explicit marker', async () => {
    seq = 0;
    const huge = 'A'.repeat(REPORT_BUDGET + 500);
    const md = (await buildReviewPreambleSections(
      baseInput({ turns: [turn('agent', huge)] }),
      mockGit(),
    )).join('\n\n');
    expect(md).toContain('[truncated — use lazy_show sections=turns]');
    expect(md).not.toContain(huge);
  });

  test('omits inline diff and names byte count when the patch exceeds DIFF_INLINE_BUDGET', async () => {
    const bigDiff = '+\n'.repeat(DIFF_INLINE_BUDGET + 100);
    const md = (await buildReviewPreambleSections(baseInput(), mockGit({
      getDiffFull: async () => bigDiff,
      getDiffNumstat: async () => '500\t400\tsrc/huge.ts\n10\t5\tsrc/small.ts\n',
    }))).join('\n\n');
    expect(md).toContain('Full diff omitted (');
    expect(md).toContain('bytes)');
    expect(md).not.toContain('```diff');
    expect(md).toContain('**Top');
    expect(md).toContain('src/huge.ts');
  });

  test('inlines the full diff when under DIFF_INLINE_BUDGET', async () => {
    const small = 'diff --git a/x b/x\n+line\n';
    const md = (await buildReviewPreambleSections(baseInput(), mockGit({
      getDiffFull: async () => small,
    }))).join('\n\n');
    expect(md).toContain('**Full diff (inline):**');
    expect(md).toContain('```diff');
    expect(md).toContain('+line');
  });
});

describe('applyPreambleHardCap', () => {
  test('drops chunks then key-file detail with explicit markers', async () => {
    const raisedItems: RaisedItem[] = Array.from({ length: 60 }, (_, i) => ({
      id: `f${i}`,
      task_id: 'abc123456789',
      content: `Raised note ${i}: ${'detail '.repeat(400)}`,
      created_at: 1_700_000_000_000 + i,
      status: 'open' as const,
      blocking: false,
    }));
    const input = baseInput({ raisedItems });
    const git = mockGit({
      getDiffFull: async () => '+\n'.repeat(DIFF_INLINE_BUDGET + 1),
      getDiffNumstat: async () =>
        Array.from({ length: KEY_FILES_N + 5 }, (_, i) => `${i + 1}\t${i + 1}\tsrc/f${i}.ts`).join('\n'),
    });
    const sections = await buildReviewPreambleSections(input, git);
    expect(utf8ByteLength(sections.join('\n\n'))).toBeGreaterThan(PREAMBLE_HARD_CAP);

    const markdown = applyPreambleHardCap(sections);
    expect(markdown).toContain('### Identity');
    expect(markdown).toContain('### Open items');
    expect(markdown).toContain('### Diff overview');
    expect(markdown).not.toContain('### Recent review chunks');
    expect(markdown).toContain('[truncated — recent chunks omitted');
    expect(markdown).toContain('[truncated — key-file list omitted');
    expect(utf8ByteLength(markdown)).toBeLessThan(utf8ByteLength(sections.join('\n\n')));
  });

  test('always keeps identity and diff overview header under pressure', async () => {
    const sections = await buildReviewPreambleSections(baseInput(), mockGit());
    const padded = [...sections, 'z'.repeat(PREAMBLE_HARD_CAP)];
    const markdown = applyPreambleHardCap(padded);
    expect(markdown).toContain('### Identity');
    expect(markdown).toContain('### Diff overview');
  });
});

describe('assembleReviewPreambleFromInputs', () => {
  test('produces a single markdown document end-to-end', async () => {
    const md = await assembleReviewPreambleFromInputs(baseInput(), mockGit());
    expect(md.startsWith('## Review session —')).toBe(true);
    expect(md.endsWith('Open items and initial read first; then wait for the human.')).toBe(true);
  });
});
