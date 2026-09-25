/**
 * Unit tests for the "How to verify" review block (src/server/review-verify.ts).
 *
 * The split runs on the markdown SOURCE, mirroring the fence rule of the one
 * markdown renderer (src/server/markdown.ts) — these tests pin the ordered
 * prose/code decomposition, the console `$ `-prefix copy semantics, and the
 * block's rendered contract (copyable panels, honest empty state).
 */

import { describe, test, expect } from 'bun:test';
import {
  splitVerifySteps,
  copyTextFor,
  isPromptPrefixed,
  perLineCommands,
  stripVerifySections,
  verifyReportBlockHtml,
  verifyRunScript,
  verifyTabHtml,
  partitionVerifyReports,
  countVerifiedSteps,
  verifyTickKey,
  howToVerifySource,
  stepSource,
  isRunnableLang,
} from '../../src/server/review-verify';
import { shortHash } from '../../src/server/viewed-cards';
import type { TurnReport } from '../../src/types';

function report(
  sections: Array<{ kind: string; body: string }>,
  extra: Partial<TurnReport> = {},
): TurnReport {
  return {
    id: 'r1',
    task_id: 't1',
    session_id: 's1',
    sections: sections as TurnReport['sections'],
    created_at: Date.now(),
    ...extra,
  };
}

describe('splitVerifySteps', () => {
  test('mixed prose and code splits in order', () => {
    const steps = splitVerifySteps(
      'Start the daemon:\n\n```bash\nbun run ./src/index.ts daemon start\n```\n\nThen open the page.\n\n```\ncurl localhost:8080\n```',
    );
    expect(steps.map((s) => s.kind)).toEqual(['prose', 'code', 'prose', 'code']);
    expect(steps[1]).toEqual({
      kind: 'code',
      lang: 'bash',
      code: 'bun run ./src/index.ts daemon start',
    });
    expect(steps[3]).toEqual({ kind: 'code', lang: '', code: 'curl localhost:8080' });
  });

  test('nested lists and headings stay in one prose step', () => {
    const steps = splitVerifySteps(
      '## Steps\n\n- outer\n  - nested\n- another\n\n```sh\nls\n```',
    );
    expect(steps.map((s) => s.kind)).toEqual(['prose', 'code']);
    expect((steps[0] as { markdown: string }).markdown).toContain('- nested');
  });

  test('an unterminated fence takes the rest as code rather than dropping it', () => {
    const steps = splitVerifySteps('Run this:\n\n```bash\necho one\necho two');
    expect(steps.map((s) => s.kind)).toEqual(['prose', 'code']);
    expect((steps[1] as { code: string }).code).toBe('echo one\necho two');
  });

  test('CRLF input splits identically to its LF twin', () => {
    const lf = splitVerifySteps('a\n\n```\nb\n```\n');
    const crlf = splitVerifySteps('a\r\n\r\n```\r\nb\r\n```\r\n');
    expect(crlf).toEqual(lf);
  });

  test('code-only and prose-only bodies work', () => {
    expect(splitVerifySteps('```\nx\n```').map((s) => s.kind)).toEqual(['code']);
    expect(splitVerifySteps('just words').map((s) => s.kind)).toEqual(['prose']);
    expect(splitVerifySteps('   \n\n')).toEqual([]);
  });

  test('an indented fence (inside a list) still opens a code step', () => {
    // Mirrors markdown.ts's classifier: any line whose trimmed start is ```.
    const steps = splitVerifySteps('- step\n  ```bash\n  ls\n  ```');
    expect(steps.map((s) => s.kind)).toEqual(['prose', 'code']);
    expect((steps[1] as { lang: string }).lang).toBe('bash');
  });
});

describe('console $-prefix copy semantics', () => {
  test('a fully $-prefixed block copies with the prompt markers stripped', () => {
    const code = '$ bun test\n$ bun run typecheck';
    expect(isPromptPrefixed(code)).toBe(true);
    expect(copyTextFor(code)).toBe('bun test\nbun run typecheck');
    expect(perLineCommands(code)).toEqual(['bun test', 'bun run typecheck']);
  });

  test('an unprefixed block copies verbatim and offers no per-line copy', () => {
    // A multi-line command (backslash continuation) must never be split.
    const code = 'docker run \\\n  -p 8080:8080 image';
    expect(isPromptPrefixed(code)).toBe(false);
    expect(copyTextFor(code)).toBe(code);
    expect(perLineCommands(code)).toEqual([]);
  });

  test('a mixed block (only some lines $-prefixed) copies verbatim', () => {
    const code = '$ echo hi\nhi';
    expect(isPromptPrefixed(code)).toBe(false);
    expect(copyTextFor(code)).toBe(code);
  });

  test('a single $-prefixed command strips on whole copy but skips per-line', () => {
    const code = '$ bun test';
    expect(copyTextFor(code)).toBe('bun test');
    expect(perLineCommands(code)).toEqual([]);
  });
});

describe('verifyReportBlockHtml', () => {
  test('renders each fence as a copyable panel with a language label', () => {
    const html = verifyReportBlockHtml(
      report([
        {
          kind: 'how_to_verify',
          body: 'Run the suite:\n\n```bash\nbun test test/unit/review-verify.test.ts\n```',
        },
      ]),
    );
    expect(html).toContain('data-viewed-key="card:how-to-verify"');
    expect(html).toContain('rv-cmd-panel');
    expect(html).toContain('rv-cmd-lang">bash<');
    expect(html).toContain('data-copy="bun test test/unit/review-verify.test.ts"');
    // Copy buttons ship hidden — the island unhides them when clipboard exists.
    expect(html).toMatch(/class="rv-cmd-copy" data-copy="[^"]*" hidden/);
    // Prose went through the markdown renderer.
    expect(html).toContain('<p>Run the suite:</p>');
    expect(html).toContain('1 command block');
  });

  test('code content and copy payloads are HTML-escaped', () => {
    const html = verifyReportBlockHtml(
      report([{ kind: 'how_to_verify', body: '```\ncurl "http://x?a=1&b=<c>"\n```' }]),
    );
    expect(html).toContain('&quot;http://x?a=1&amp;b=&lt;c&gt;&quot;');
    expect(html).not.toContain('<c>');
  });

  test('no how_to_verify section renders the honest empty state', () => {
    const html = verifyReportBlockHtml(report([{ kind: 'what_was_done', body: 'work' }]));
    expect(html).toContain('The agent gave no verification steps.');
    expect(html).toContain('data-viewed-key="card:how-to-verify"');
    const noReport = verifyReportBlockHtml(null);
    expect(noReport).toContain('The agent gave no verification steps.');
  });

  test('duplicate how_to_verify sections concatenate in order', () => {
    const html = verifyReportBlockHtml(
      report([
        { kind: 'how_to_verify', body: 'First step.' },
        { kind: 'what_was_done', body: 'work' },
        { kind: 'how_to_verify', body: 'Second step.' },
      ]),
    );
    expect(html.indexOf('First step.')).toBeGreaterThan(-1);
    expect(html.indexOf('First step.')).toBeLessThan(html.indexOf('Second step.'));
  });

  test('per-line copy buttons appear only on multi-command $-prefixed blocks', () => {
    const multi = verifyReportBlockHtml(
      report([{ kind: 'how_to_verify', body: '```console\n$ bun test\n$ bun run typecheck\n```' }]),
    );
    expect(multi).toContain('rv-cmd-copy-line');
    expect(multi).toContain('data-copy="bun test"');
    const single = verifyReportBlockHtml(
      report([{ kind: 'how_to_verify', body: '```\nbun test\n```' }]),
    );
    expect(single).not.toContain('rv-cmd-copy-line');
  });
});

describe('Run in the task container', () => {
  const verifyBody = (lang: string, code = 'bun test'): TurnReport =>
    report([{ kind: 'how_to_verify', body: '```' + lang + '\n' + code + '\n```' }]);

  test('untagged and shell-like tags are runnable; data/source tags are not', () => {
    for (const lang of ['', 'bash', 'sh', 'zsh', 'console', 'shell-session', 'fish']) {
      expect(isRunnableLang(lang)).toBe(true);
    }
    for (const lang of ['json', 'toml', 'ts', 'tsx', 'yaml', 'diff', 'markdown', 'text']) {
      expect(isRunnableLang(lang)).toBe(false);
    }
    // Info strings carry more than the tag; only the tag decides.
    expect(isRunnableLang('JSON title="lazy.toml"')).toBe(false);
    expect(isRunnableLang('  Bash  ')).toBe(true);
  });

  test('a runnable block gets a Run button carrying the copy payload', () => {
    const html = verifyReportBlockHtml(verifyBody('bash'), { available: true });
    // Run sends exactly what Copy would put on the clipboard.
    expect(html).toContain('class="rv-cmd-run" data-run="bun test"');
    // Like Copy, it ships hidden — the island unhides it.
    expect(html).toMatch(/class="rv-cmd-run" data-run="[^"]*"[^>]*hidden/);
  });

  test('the $-prefix stripping is reused for the run payload', () => {
    const html = verifyReportBlockHtml(
      report([{ kind: 'how_to_verify', body: '```console\n$ bun test\n$ bun run typecheck\n```' }]),
      { available: true },
    );
    expect(html).toContain('data-run="bun test&#10;bun run typecheck"');
  });

  test('a non-shell language gets no Run button at all', () => {
    const html = verifyReportBlockHtml(verifyBody('json', '{"a": 1}'), { available: true });
    expect(html).toContain('rv-cmd-copy');
    expect(html).not.toContain('rv-cmd-run');
  });

  test('an unavailable shell disables Run with the same reason the Shell button shows', () => {
    const html = verifyReportBlockHtml(verifyBody('bash'), {
      available: false,
      reason: 'Container for this task is not running.',
    });
    expect(html).toContain('class="rv-cmd-run" disabled title="Container for this task is not running."');
    expect(html).not.toContain('data-run=');
  });

  test('no shell surface on the page renders no Run control', () => {
    // The task page/review page pass null when the project root cannot be
    // resolved: no Shell button, so no Run either.
    const html = verifyReportBlockHtml(verifyBody('bash'), null);
    expect(html).not.toContain('rv-cmd-run');
    expect(html).toContain('rv-cmd-copy');
  });

  test('the run island unhides the buttons and sends the block with a trailing newline', () => {
    const script = verifyRunScript();
    expect(script).toContain("querySelectorAll('.rv-cmd-run')");
    expect(script).toContain('buttons[i].hidden = false');
    expect(script).toContain('if (!btn || btn.disabled) return;');
    expect(script).toContain("window.lzShellRun(text.replace(/\\n+$/, '') + '\\n', null, btn.dataset.runLabel");
  });

  // INVARIANT: a Run opens a shell of its own. The label is what the reviewer
  // reads on the tab, so several blocks in flight stay tellable apart.
  test('each block carries its own tab label, numbered in report order', () => {
    const html = verifyReportBlockHtml(
      report([
        {
          kind: 'how_to_verify',
          body: '```bash\nbun test a\n```\n\nthen\n\n```bash\nbun test b\n```',
        },
      ]),
      { available: true },
    );
    expect(html).toContain('data-run-label="Verify 1"');
    expect(html).toContain('data-run-label="Verify 2"');
    expect(html.indexOf('Verify 1')).toBeLessThan(html.indexOf('Verify 2'));
  });

  // The affordance is the point of the change: the button has to say that a
  // click opens a shell, not that it types into the one already on the page.
  test('the button says it opens a shell', () => {
    const html = verifyReportBlockHtml(verifyBody('bash'), { available: true });
    expect(html).toContain('>Run in shell</button>');
    expect(html).toContain('title="Run these commands in a new shell (Verify 1)');
    expect(verifyRunScript()).toContain("btn.dataset.runLabel");
  });

  // The reason renders once at the top of the card — not beside each Run button.
  test('an unavailable shell states the reason once, above the steps', () => {
    const html = verifyReportBlockHtml(
      report([
        { kind: 'how_to_verify', body: '```bash\nbun test a\n```\n\n```bash\nbun test b\n```' },
      ]),
      { available: false, reason: 'This task has no session yet.', code: 'no-session' },
    );
    expect(html.split('rv-verify-shell-down').length - 1).toBe(1);
    expect(html).toContain('This task has no session yet.');
    expect(html.indexOf('rv-verify-shell-down')).toBeLessThan(html.indexOf('rv-cmd-panel'));
  });

  // INVARIANT: the verify card offers no Start container button. Running a step
  // starts the container itself, so a second control here was one of the several
  // "Start container" buttons a page used to sprout.
  test('no Start container control is rendered next to the reason', () => {
    const html = verifyReportBlockHtml(
      report([
        { kind: 'how_to_verify', body: '```bash\nbun test a\n```' },
      ]),
      { available: false, reason: 'This task has no session yet.', code: 'no-session' },
    );
    expect(html).not.toContain('container/start');
    expect(html).not.toContain('Start container');
  });

  test('the reason is not rendered when a shell is available or there is nothing to run', () => {
    const available = verifyReportBlockHtml(verifyBody('bash'), { available: true });
    expect(available).not.toContain('rv-verify-shell-down');
    const proseOnly = verifyReportBlockHtml(
      report([{ kind: 'how_to_verify', body: 'Just look at the page.' }]),
      { available: false, reason: 'This task has no session yet.', code: 'no-session' },
    );
    expect(proseOnly).not.toContain('rv-verify-shell-down');
  });
});

describe('stripVerifySections', () => {
  test('removes only how_to_verify, preserving the agent order of the rest', () => {
    const r = report([
      { kind: 'commentary', body: 'a' },
      { kind: 'how_to_verify', body: 'v' },
      { kind: 'what_was_done', body: 'b' },
    ]);
    const stripped = stripVerifySections(r)!;
    expect(stripped.sections.map((s) => s.kind)).toEqual(['commentary', 'what_was_done']);
    // The original is not mutated.
    expect(r.sections.length).toBe(3);
  });

  test('returns the same report when nothing to strip, and null for null', () => {
    const r = report([{ kind: 'what_was_done', body: 'b' }]);
    expect(stripVerifySections(r)).toBe(r);
    expect(stripVerifySections(null)).toBeNull();
  });
});

describe('partitionVerifyReports', () => {
  const older = report([{ kind: 'how_to_verify', body: 'old command' }], {
    id: 'old',
    session_id: 'sess-old',
    turn_sequence: 3,
    created_at: 1000,
  });
  const current = report([{ kind: 'how_to_verify', body: 'new command' }], {
    id: 'new',
    session_id: 'sess-new',
    turn_sequence: 7,
    created_at: 2000,
  });

  test('the latest agent turn is current; earlier sessions with steps are superseded', () => {
    const parts = partitionVerifyReports([older, current], {
      session_id: 'sess-new',
      sequence: 7,
    });
    expect(parts.current?.id).toBe('new');
    expect(parts.currentSequence).toBe(7);
    expect(parts.earlier).toHaveLength(1);
    expect(parts.earlier[0]!.turnSequence).toBe(3);
    expect(howToVerifySource(parts.earlier[0]!.report)).toBe('old command');
  });

  // INVARIANT: an older how_to_verify is instructions for a branch that may
  // no longer exist in that shape. Presenting it as current is a falsehood.
  test('a new session with no report yet does not inherit the previous session as current', () => {
    const parts = partitionVerifyReports([older], {
      session_id: 'sess-new',
      sequence: 7,
    });
    expect(parts.current).toBeNull();
    expect(parts.currentSequence).toBe(7);
    expect(parts.earlier).toHaveLength(1);
    expect(parts.earlier[0]!.report.id).toBe('old');
  });

  test('a current session with no how_to_verify is still current (honest empty)', () => {
    const empty = report([{ kind: 'what_was_done', body: 'work' }], {
      id: 'empty',
      session_id: 'sess-new',
      turn_sequence: 7,
      created_at: 2000,
    });
    const parts = partitionVerifyReports([older, empty], {
      session_id: 'sess-new',
      sequence: 7,
    });
    expect(parts.current?.id).toBe('empty');
    expect(parts.earlier.map((e) => e.report.id)).toEqual(['old']);
  });
});

describe('countVerifiedSteps', () => {
  test('counts only matching hashes for the current turn', () => {
    const steps = splitVerifySteps('First.\n\n```\nbun test\n```');
    expect(steps).toHaveLength(2);
    const k0 = verifyTickKey(7, 0);
    const k1 = verifyTickKey(7, 1);
    const viewed = {
      [k0]: shortHash(stepSource(steps[0]!)),
      [k1]: 'stale',
      [verifyTickKey(3, 0)]: shortHash(stepSource(steps[0]!)),
    };
    expect(countVerifiedSteps(viewed, 7, steps)).toEqual({ verified: 1, total: 2 });
  });
});

describe('verifyTabHtml', () => {
  test('current steps are numbered and ticked; earlier ones are collapsed superseded history', () => {
    const current = report(
      [{ kind: 'how_to_verify', body: 'Open the page.\n\n```bash\nbun test\n```' }],
      { session_id: 's-now', turn_sequence: 7, created_at: Date.UTC(2026, 8, 8) },
    );
    const earlier = report(
      [{ kind: 'how_to_verify', body: '```\nold\n```' }],
      { id: 'r-old', session_id: 's-old', turn_sequence: 5, created_at: Date.UTC(2026, 8, 5) },
    );
    const html = verifyTabHtml({
      current,
      currentSequence: 7,
      earlier: [{ turnSequence: 5, createdAt: earlier.created_at, report: earlier }],
      shell: { available: true },
      taskCode: 'fix-hub',
    });
    expect(html).toContain('turn #7');
    expect(html).toContain('data-verify-current');
    expect(html).toContain('data-viewed-key="verify:7:0"');
    expect(html).toContain('data-lz-shell-mount');
    expect(html).toContain('data-lz-shell-origin="Verification, step 1"');
    expect(html).toContain('>Run in shell</button>');
    expect(html).toContain('>Open</button>');
    expect(html).toContain('>Re-run</button>');
    expect(html).toContain('Earlier verification steps (1)');
    expect(html).toContain('Turn #5 · superseded · 2026-09-05');
    expect(html).toContain("written against that turn's branch");
    // History is not runnable — those commands belong to a different branch.
    const history = html.slice(html.indexOf('lz-verify-history'));
    expect(history).not.toContain('rv-cmd-run');
    expect(html).toContain('<noscript>');
    expect(html).toContain('lazy shell fix-hub');
  });

  test('no current steps still render the honest empty state', () => {
    const html = verifyTabHtml({
      current: null,
      currentSequence: 0,
      earlier: [],
      shell: null,
      taskCode: 'fix-hub',
    });
    expect(html).toContain('The agent gave no verification steps.');
    expect(html).toContain('data-viewed-key="card:how-to-verify"');
  });
});

// INVARIANT: whether a verification block may be RUN is answered on the wire
// (`runnable`), so a remote surface (Lazy Teams) offers "Run in shell" by the
// same rule as the dashboard instead of keeping its own copy of the denylist.
describe('verify wire: runnable', () => {
  test('a shell block is runnable and a data block is not', async () => {
    const { buildVerifyState } = await import('../../src/review/verify-state');
    const report = {
      session_id: 's', turn_sequence: 1, created_at: 1,
      sections: [{ kind: 'how_to_verify', body: 'Run:\n\n```bash\nbun test\n```\n\nExpect:\n\n```json\n{"ok":true}\n```\n' }],
    } as never;
    const state = buildVerifyState([report], { session_id: 's', sequence: 1 }, {}) as unknown as {
      current: { steps: Array<{ kind: string; lang?: string; runnable?: boolean }> } | null;
    };
    const code = (state.current?.steps ?? []).filter((s) => s.kind === 'code');
    expect(code.map((s) => [s.lang, s.runnable])).toEqual([['bash', true], ['json', false]]);
  });
});
