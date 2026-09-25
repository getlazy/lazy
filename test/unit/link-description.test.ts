import { describe, test, expect } from 'bun:test';
import {
  buildLinkDescriptionPrompt,
  parseLinkDescription,
  COMMENT_BUDGET,
  COMMENTS_TOTAL_BUDGET,
  DIFF_BUDGET,
  PR_DESCRIPTION_BUDGET,
  GENERATED_GOAL_MAX_CHARS,
} from '../../src/task/link-description';

describe('buildLinkDescriptionPrompt', () => {
  const base = {
    goal: 'Add retry to the uploader',
    branch: 'feature/retry',
    baseBranch: 'main',
  };

  test('carries the PR body, its comments and the branch material', () => {
    const prompt = buildLinkDescriptionPrompt({
      ...base,
      prUrl: 'https://github.com/org/repo/pull/7',
      prState: 'OPEN',
      prDescription: 'Retries uploads on 5xx.',
      comments: ['[reviewer] cover 429 too', '[author] will do'],
      commitLog: '- abc123 Ada, 2026-09-01: add retry loop',
      diffStat: ' src/upload.ts | 20 +++',
      diffPatch: '--- a/src/upload.ts\n+++ b/src/upload.ts',
    });

    expect(prompt).toContain('Add retry to the uploader');
    expect(prompt).toContain('feature/retry');
    expect(prompt).toContain('Base branch: main');
    expect(prompt).toContain('https://github.com/org/repo/pull/7 (OPEN)');
    expect(prompt).toContain('Retries uploads on 5xx.');
    expect(prompt).toContain('[reviewer] cover 429 too');
    expect(prompt).toContain('[author] will do');
    expect(prompt).toContain('add retry loop');
    expect(prompt).toContain('src/upload.ts | 20 +++');
    expect(prompt).toContain('+++ b/src/upload.ts');
  });

  test('a branch with no PR says so instead of leaving the sections blank', () => {
    // INVARIANT: every section of the prompt is either filled or explicitly
    // marked empty. A blank section reads to the model as material it failed to
    // notice, and it invents the missing half rather than reporting a thin
    // branch as thin.
    const prompt = buildLinkDescriptionPrompt({
      ...base,
      goal: 'feature/retry',
      commitLog: '- abc123 Ada, 2026-09-01: add retry loop',
    });

    expect(prompt).toContain('none — this is a branch with no pull request');
    expect(prompt).toContain('_(no pull request description)_');
    expect(prompt).toContain('_(no comments)_');
    expect(prompt).toContain('_(no diff readable against the base branch)_');
    expect(prompt).toContain('add retry loop');
  });

  test('truncates an oversized PR body, comment set and diff', () => {
    const prompt = buildLinkDescriptionPrompt({
      ...base,
      prDescription: 'd'.repeat(PR_DESCRIPTION_BUDGET * 2),
      comments: Array.from({ length: 40 }, (_, i) => `[reviewer${i}] ${'c'.repeat(COMMENT_BUDGET * 2)}`),
      diffStat: ' src/upload.ts | 20 +++',
      diffPatch: 'p'.repeat(DIFF_BUDGET * 2),
    });

    expect(prompt).toContain('truncated');
    expect(prompt).toContain('further comment(s) omitted');
    // Budgets are per-section, so the whole prompt stays within their sum plus
    // the template — the point of bounding is that a huge PR still gets a call.
    expect(prompt.length).toBeLessThan(
      PR_DESCRIPTION_BUDGET + COMMENTS_TOTAL_BUDGET + COMMENT_BUDGET + DIFF_BUDGET + 20_000,
    );
    // The stat survives the patch being cut: it is the only input that still
    // describes the SHAPE of a change too big to show.
    expect(prompt).toContain('src/upload.ts | 20 +++');
  });

  test('stamps the stage marker the one-shot mock and audit path dispatch on', () => {
    expect(buildLinkDescriptionPrompt(base)).toContain('LAZY_LINK_DESCRIBE');
  });

  test('PR text containing replacement patterns or a placeholder survives intact', () => {
    // INVARIANT: substitution is ONE pass with a replacer FUNCTION. The values
    // are a stranger's PR body, comments and diff: a replacement STRING would
    // treat `$'`, `$&` and `$1` as instructions and splice the prompt into
    // itself, and a per-key chain would let material containing the literal text
    // `{{comments}}` consume the real comments placeholder — deleting that whole
    // section with nothing in the output saying so.
    const prompt = buildLinkDescriptionPrompt({
      ...base,
      prUrl: 'https://github.com/org/repo/pull/7',
      prDescription: "Uses $' and $& in a sed call; see {{comments}} and $1 below",
      comments: ['[reviewer] the $`-quoting needs a test'],
      commitLog: '- abc123 Ada, 2026-09-01: quote $& correctly',
      diffPatch: "-  sed \"s/x/$'y'/\"\n+  printf '%s' \"$1\"",
    });

    expect(prompt).toContain("Uses $' and $& in a sed call; see {{comments}} and $1 below");
    expect(prompt).toContain('the $`-quoting needs a test');
    expect(prompt).toContain('quote $& correctly');
    expect(prompt).toContain("+  printf '%s' \"$1\"");
    // The comments section is still its own section, not consumed by the body.
    expect(prompt).not.toContain('_(no comments)_');
    // Every placeholder got filled: none survives as literal template text
    // outside the PR body that legitimately mentions one.
    expect(prompt).not.toContain('{{description}}');
    expect(prompt).not.toContain('{{diff}}');
    expect(prompt.match(/\{\{comments\}\}/g)?.length).toBe(1);
  });

  test('marks a patch the reader cut off at the byte cap', () => {
    // INVARIANT: the daemon stops READING a huge diff rather than buffering it,
    // so the text can be incomplete while sitting inside the budget. Without
    // this marker the prompt would look complete and the model would describe a
    // partial diff as the whole change.
    const prompt = buildLinkDescriptionPrompt({
      ...base,
      diffStat: ' src/a.ts | 900 +++',
      diffPatch: 'p'.repeat(100),
      diffTruncated: true,
    });
    expect(prompt).toContain(`[… truncated, the diff is larger than ${DIFF_BUDGET} characters]`);
  });
});

describe('parseLinkDescription', () => {
  test('splits the GOAL line from the description body', () => {
    const parsed = parseLinkDescription('GOAL: Add retry to the uploader\n---\nThe branch adds a retry loop.');
    expect(parsed?.goal).toBe('Add retry to the uploader');
    expect(parsed?.prompt).toBe('The branch adds a retry loop.');
  });

  test('accepts an answer wrapped in a code fence', () => {
    const parsed = parseLinkDescription('```\nGOAL: Add retry\n---\nBody here.\n```');
    expect(parsed?.goal).toBe('Add retry');
    expect(parsed?.prompt).toBe('Body here.');
  });

  test('an answer with no GOAL line still yields the description', () => {
    // INVARIANT: the description is the valuable half. A task linked from a PR
    // already has a goal, so a missing GOAL line must not throw away a usable
    // body — only an EMPTY answer is a failure.
    const parsed = parseLinkDescription('The branch adds a retry loop.');
    expect(parsed?.goal).toBeUndefined();
    expect(parsed?.prompt).toBe('The branch adds a retry loop.');
  });

  test('an empty or whitespace answer is a failure, not an empty prompt', () => {
    expect(parseLinkDescription('')).toBeNull();
    expect(parseLinkDescription('   \n  ')).toBeNull();
    expect(parseLinkDescription('GOAL: only a goal, no body')).toBeNull();
  });

  test('bounds a runaway goal line', () => {
    const parsed = parseLinkDescription(`GOAL: ${'g'.repeat(500)}\n---\nBody.`);
    expect(parsed?.goal?.length).toBe(GENERATED_GOAL_MAX_CHARS);
  });

  test('tolerates a bolded goal label', () => {
    const parsed = parseLinkDescription('**GOAL**: Add retry\n---\nBody.');
    expect(parsed?.goal).toBe('Add retry');
    expect(parsed?.prompt).toBe('Body.');
  });
});
