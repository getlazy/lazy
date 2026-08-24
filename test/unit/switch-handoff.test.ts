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
import { buildTurnHistoryContext } from '../../src/cli/commands/shared';
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

  test('omits a conflict-free merge whose tree equals a parent', async () => {
    // Create a side branch and merge it with no conflicts (FF or tree-equivalent).
    git(dir, 'checkout', '-b', 'side');
    await writeFile(join(dir, 'side.ts'), 'side\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'side work');
    git(dir, 'checkout', '-'); // back to previous branch
    // Non-FF merge so we get a merge commit; content comes entirely from the side parent
    // when merging into a branch that has no divergent changes… actually after
    // checkout - we are on the original branch which has 'add feature'. Side has
    // that plus side.ts. Merge creates a merge commit whose tree equals side's tip.
    git(dir, 'merge', '--no-ff', '-m', 'Merge side', 'side');

    const text = await buildTaskOrientationContext({
      branchName: 'lazy/example',
      gitStartSha: baseSha,
      worktreePath: dir,
    });
    // The tree-equivalent merge should be omitted; side work + feature remain.
    expect(text).toMatch(/Conflict-free merge commits omitted from the list below: [1-9]/);
    expect(text).toContain('side work');
    expect(text).toContain('add feature');
    expect(text).not.toContain('Merge side');
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
