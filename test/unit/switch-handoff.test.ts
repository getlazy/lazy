/**
 * Unit tests for distilled agent-switch handoff (turn history + orientation).
 *
 * INVARIANT: when an agent session cannot be resumed, the next prompt must
 * announce truncation honestly and must not claim the prior session was
 * specifically a "Claude Code" session. See
 * docs/spikes/cross-agent-context-handoff.md.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { buildTurnHistoryContext } from '../../src/task/turn-context';
import {
  buildAgentSwitchHandoffContext,
  buildTaskOrientationContext,
  countCleanSyncTurns,
} from '../../src/agent/switch-handoff';
import type { Turn } from '../../src/types';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString()}`);
  }
  return result.stdout?.toString().trim() ?? '';
}

function makeTurn(partial: Partial<Turn> & Pick<Turn, 'sequence' | 'role' | 'content'>): Turn {
  return {
    id: `turn-${partial.sequence}`,
    session_id: 'sess',
    timestamp: Date.now(),
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    ...partial,
  };
}

describe('buildTurnHistoryContext', () => {
  test('uses agent-neutral wording (not Claude Code–specific)', () => {
    const text = buildTurnHistoryContext([
      makeTurn({ sequence: 1, role: 'human', content: 'do the thing' }),
      makeTurn({ sequence: 2, role: 'agent', content: 'done' }),
    ]);
    expect(text).toContain('previous agent session');
    expect(text).not.toContain('Claude Code session');
    expect(text).toContain('distilled');
  });

  test('announces truncation when the budget drops older turns', () => {
    // Tiny budget so only the newest turn fits.
    const turns = [
      makeTurn({ sequence: 1, role: 'human', content: 'ORIGINAL PROMPT ' + 'x'.repeat(200) }),
      makeTurn({ sequence: 2, role: 'agent', content: 'first reply ' + 'y'.repeat(200) }),
      makeTurn({ sequence: 3, role: 'human', content: 'latest feedback ' + 'z'.repeat(200) }),
    ];
    const text = buildTurnHistoryContext(turns, 250);
    expect(text).toContain('NOTE: History is truncated');
    expect(text).toContain('of 3 turns');
    expect(text).toContain('latest feedback');
    expect(text).not.toContain('ORIGINAL PROMPT');
    expect(text).toContain('including possibly the original task prompt');
  });

  test('omits the truncation notice when everything fits', () => {
    const text = buildTurnHistoryContext([
      makeTurn({ sequence: 1, role: 'human', content: 'short' }),
    ]);
    expect(text).not.toContain('NOTE: History is truncated');
    expect(text).toContain('short');
  });
});

describe('countCleanSyncTurns', () => {
  test('counts supervisor sync turns without merge conflicts', () => {
    const turns = [
      makeTurn({ sequence: 1, role: 'human', content: 'go', actor: 'human' }),
      makeTurn({
        sequence: 2,
        role: 'human',
        content: 'Merged upstream.',
        actor: 'supervisor',
        turn_type: 'sync',
      }),
      makeTurn({
        sequence: 3,
        role: 'human',
        content: 'Conflict merge.',
        actor: 'supervisor',
        turn_type: 'sync',
        merge_conflicts: [{ path: 'a.ts', content: '<<<<<<', merge_source: 'main' }],
      }),
    ];
    expect(countCleanSyncTurns(turns)).toBe(1);
  });
});

describe('buildTaskOrientationContext / handoff', () => {
  let dir: string;
  let baseSha: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-handoff-orient-'));
    git(dir, 'init');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    await writeFile(join(dir, 'README.md'), 'base\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'initial');
    baseSha = git(dir, 'rev-parse', 'HEAD');

    await writeFile(join(dir, 'feature.ts'), 'export const x = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'add feature');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('lists non-merge commits and a file stat since base', async () => {
    const text = await buildTaskOrientationContext({
      branchName: 'lazy/example',
      gitStartSha: baseSha,
      worktreePath: dir,
      cleanSyncTurnCount: 2,
    });
    expect(text).toContain('## Branch orientation');
    expect(text).toContain('lazy/example');
    expect(text).toContain('add feature');
    expect(text).toContain('feature.ts');
    expect(text).toContain('2 conflict-free upstream sync turn(s)');
  });

  test('a merge is represented by its merge commit, never by the line it merged', async () => {
    // INVARIANT: orientation walks first-parent, and every commit on that walk
    // is listed. A merge therefore contributes exactly one line — the merge
    // commit — and the commits it brought in are not listed as this branch's
    // work. This replaced a filter that DROPPED merges whose tree equalled a
    // parent. That filter was written against a reachability walk, where the
    // merged-in commits appeared individually and the merge line was pure
    // noise. Under first-parent the merge commit is the only thing standing
    // for that line, so omitting it silently erased the work from the handoff
    // — a fresh agent was briefed on a branch with a hole in it.
    git(dir, 'checkout', '-b', 'side');
    await writeFile(join(dir, 'side.ts'), 'side\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'side work');
    git(dir, 'checkout', '-'); // back to the original branch
    // --no-ff so there is a real merge commit. Its tree equals side's tip,
    // because this branch had nothing of its own to combine — exactly the
    // shape the old filter dropped.
    git(dir, 'merge', '--no-ff', '-m', 'Merge side', 'side');

    const text = await buildTaskOrientationContext({
      branchName: 'lazy/example',
      gitStartSha: baseSha,
      worktreePath: dir,
    });

    // The merge stands for what it brought in...
    expect(text).toContain('Merge side');
    // ...and this branch's own commit is still listed.
    expect(text).toContain('add feature');
    // The merged-in branch's commits are NOT this branch's work.
    expect(text).not.toContain('side work');
    // The old filter's accounting line is gone with it.
    expect(text).not.toContain('omitted from the list below');
  });

  test('buildAgentSwitchHandoffContext wraps template + history + orientation', async () => {
    const text = await buildAgentSwitchHandoffContext({
      turns: [
        makeTurn({ sequence: 1, role: 'human', content: 'original goal prompt' }),
        makeTurn({ sequence: 2, role: 'agent', content: 'I did the work' }),
      ],
      branchName: 'lazy/example',
      gitStartSha: baseSha,
      worktreePath: dir,
    });
    expect(text).toContain('Agent switch — distilled handoff');
    expect(text).toContain('## Branch orientation');
    expect(text).toContain('PREVIOUS CONVERSATION HISTORY');
    expect(text).toContain('original goal prompt');
    expect(text).toContain('add feature');
  });
});
