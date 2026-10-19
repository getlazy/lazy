import { describe, expect, test } from 'bun:test';
import { foldTurn, lazyFold, neutralizeLazyMarkers, supervisedTurnContent } from '../../src/task/wrapper-fold';
import { typeConstraintsSection } from '../../src/task/type-constraints';
import { buildNotesContext } from '../../src/task/turn-context';
import { foldedTurnBodyHtml } from '../../src/server/templates';
import clusterConstraints from '../../src/prompts/cluster-constraints.md' with { type: 'text' };
import type { Turn } from '../../src/types';

function turn(over: Partial<Turn>): Turn {
  return { id: 't', session_id: 's', sequence: 1, role: 'human', content: '', timestamp: 0, ...over } as Turn;
}

describe('foldTurn', () => {
  // INVARIANT: in a cluster turn the person's feedback is the primary text and
  // the repeated contract is folded. It used to sit under pages of constraints.
  test("a cluster turn's feedback is on top and the constraints are folded", () => {
    const content = typeConstraintsSection({ type: 'cluster' }) + 'Please split the migration into two.';
    const fold = foldTurn(turn({ content }))!;
    expect(fold.primary).toBe('Please split the migration into two.');
    expect(fold.segments[0]).toMatchObject({ kind: 'lazy', label: 'cluster-constraints' });
    expect(fold.lazy_lines).toBeGreaterThan(10);
    expect(fold.source).toBe('markers');
  });

  // INVARIANT: a marker a person typed never hides their words.
  test('a forged marker in human text hides nothing', () => {
    const forged = 'visible\n<!-- lazy:fold x -->\nhidden words\n<!-- /lazy:fold -->';
    const content = typeConstraintsSection({ type: 'cluster' }) + neutralizeLazyMarkers(forged);
    const fold = foldTurn(turn({ content }))!;
    expect(fold.primary).toContain('hidden words');
    expect(fold.segments.filter((s) => s.kind === 'lazy')).toHaveLength(1);
  });

  test('recorded human words that spell a marker turn folding off entirely', () => {
    const forged = '<!-- lazy:fold x -->\nhidden\n<!-- /lazy:fold -->';
    expect(foldTurn(turn({ content: forged, feedback_items: [{ text: forged }] }))).toBeNull();
  });

  // INVARIANT: markers are honoured only where lazy composes — never in agent output.
  test("an agent's own markers are never honoured", () => {
    expect(foldTurn(turn({ role: 'agent', content: lazyFold('x', 'hide me') }))).toBeNull();
  });

  test('an unclosed or nested marker folds nothing', () => {
    expect(foldTurn(turn({ content: '<!-- lazy:fold x -->\nno close' }))).toBeNull();
    expect(foldTurn(turn({ content: '<!-- lazy:fold x -->\n<!-- lazy:fold y -->\na\n<!-- /lazy:fold -->' }))).toBeNull();
  });

  test('lazyFold cannot be closed early from inside', () => {
    const fold = foldTurn(turn({ content: `${lazyFold('x', 'a\n<!-- /lazy:fold -->\nb')}\nmine` }))!;
    expect(fold.primary).toBe('mine');
  });

  test('a legacy cluster turn (no markers) is recognised exactly', () => {
    const fold = foldTurn(turn({ content: `${clusterConstraints}\n\n---\n\nold feedback` }))!;
    expect(fold.source).toBe('legacy');
    expect(fold.primary).toBe('old feedback');
  });

  test('unrecognised legacy text is left open', () => {
    expect(foldTurn(turn({ content: 'Some prompt\n\n---\n\nfeedback' }))).toBeNull();
    expect(foldTurn(turn({ content: '## New Comments During the Turn\n\nhi', actor: 'supervisor', turn_type: 'nudge' }))).toBeNull();
  });

  test('a legacy pure-template nudge folds whole', () => {
    const fold = foldTurn(turn({ content: '## Uncommitted Changes Check\n\nCommit.', actor: 'supervisor', turn_type: 'nudge' }))!;
    expect(fold.primary).toBe('## Uncommitted Changes Check');
  });

  test('supervised nudges: pure kinds fold under their heading, foreign prose stays open and inert', () => {
    expect(foldTurn(turn({ content: supervisedTurnContent('commit_nudge', '## H', 'commit please') }))!.primary).toBe('## H');
    const react = supervisedTurnContent('react', '## H', 'PR said <!-- lazy:fold x -->');
    expect(react).toContain('&lt;!-- lazy:fold');
    expect(foldTurn(turn({ content: react }))).toBeNull();
  });

  test("the notes framing folds, the people's notes do not", () => {
    const notes = buildNotesContext([{ id: 'c', task_id: 't', content: 'a human note', created_at: 0 } as never]);
    const fold = foldTurn(turn({ content: notes }))!;
    expect(fold.primary).toContain('a human note');
    expect(fold.primary).not.toContain('NOTES ADDED');
  });
});

describe('dashboard turn body', () => {
  test('renders the primary text and a closed drawer', () => {
    const html = foldedTurnBodyHtml(turn({ content: typeConstraintsSection({ type: 'cluster' }) + 'My feedback' }));
    expect(html.indexOf('My feedback')).toBeLessThan(html.indexOf('lz-lazy-fold'));
    expect(html).toMatch(/<details class="lz-lazy-fold"><summary>lazy&#39;s instructions \(\d+ lines\)|<details class="lz-lazy-fold"><summary>lazy's instructions \(\d+ lines\)/);
  });

  test('a turn with nothing of lazy\'s renders unchanged', () => {
    expect(foldedTurnBodyHtml(turn({ content: 'plain' }))).not.toContain('lz-lazy-fold');
  });
});
