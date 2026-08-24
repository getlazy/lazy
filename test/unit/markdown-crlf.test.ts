import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { renderMarkdown } from '../../src/server/markdown';
import { spawn } from '../../src/utils/spawn';

/**
 * Regression suite for the CRLF hang that froze production daemons.
 *
 * renderMarkdown is synchronous and runs on the daemon's event loop, so an
 * infinite loop inside it is not a slow request — it is a dead daemon (100%
 * CPU, no logs, timers stopped, every RPC/web/health request hanging), which
 * re-wedged on restart as soon as the browser tab re-fetched the route.
 *
 * Every test here uses a short explicit per-test timeout: against the unfixed
 * code these hang forever, and the timeout is what turns that into a failure
 * rather than a wedged test run.
 */

const TIMEOUT_MS = 2000;

describe('renderMarkdown line-ending normalization', () => {
  // INVARIANT: renderMarkdown must terminate on ANY input. It runs on the
  // daemon event loop, so a non-terminating render freezes the whole daemon.
  // The original bug: outer block classifiers ended in `(.*)$`, which rejects a
  // trailing \r, while the paragraph lookahead used prefix-only copies that
  // accepted it — so a CRLF heading matched neither branch, the paragraph loop
  // consumed nothing, and the index never advanced.
  test(
    'terminates on a CRLF heading',
    () => {
      expect(renderMarkdown('# title\r\nrest')).toBe(renderMarkdown('# title\nrest'));
    },
    TIMEOUT_MS
  );

  // INVARIANT: a CRLF document renders identically to its LF twin. Line endings
  // are a transport detail (pasted transcripts, Windows clients); they must
  // never change the rendered output.
  test(
    'CRLF unordered list renders identically to LF',
    () => {
      expect(renderMarkdown('- one\r\n- two\r\ntail')).toBe(renderMarkdown('- one\n- two\ntail'));
    },
    TIMEOUT_MS
  );

  test(
    'CRLF ordered list renders identically to LF',
    () => {
      expect(renderMarkdown('1. one\r\n2. two\r\ntail')).toBe(
        renderMarkdown('1. one\n2. two\ntail')
      );
    },
    TIMEOUT_MS
  );

  test(
    'mixed CRLF/LF document renders identically to the LF-normalized document',
    () => {
      const lf = [
        '# Heading',
        '',
        'A paragraph line',
        'continued here',
        '',
        '- bullet one',
        '  - nested bullet',
        '',
        '1. first',
        '2. second',
        '',
        '> quoted line',
        '',
        '---',
        '',
        '```ts',
        'const x = 1;',
        '```',
        '',
        'Trailing paragraph',
      ].join('\n');

      // Mix: every other newline is a CRLF, the rest stay LF.
      let n = 0;
      const mixed = lf.replace(/\n/g, () => (n++ % 2 === 0 ? '\r\n' : '\n'));
      expect(mixed).toContain('\r\n');

      expect(renderMarkdown(mixed)).toBe(renderMarkdown(lf));
      expect(renderMarkdown(lf.replace(/\n/g, '\r\n'))).toBe(renderMarkdown(lf));
    },
    TIMEOUT_MS
  );

  test(
    'CRLF blockquote and fenced code render identically to LF',
    () => {
      expect(renderMarkdown('> quoted\r\n> more\r\n')).toBe(renderMarkdown('> quoted\n> more\n'));
      expect(renderMarkdown('```ts\r\nconst x = 1;\r\n```\r\n')).toBe(
        renderMarkdown('```ts\nconst x = 1;\n```\n')
      );
    },
    TIMEOUT_MS
  );

  // A classic-Mac lone CR is the same failure mode with the same cost.
  test(
    'terminates on lone-CR line endings',
    () => {
      expect(renderMarkdown('# title\rrest')).toBe(renderMarkdown('# title\nrest'));
    },
    TIMEOUT_MS
  );
});

describe('renderMarkdown termination under a real wall clock', () => {
  // INVARIANT: renderMarkdown must terminate under a HARD, out-of-process
  // deadline.
  //
  // Why a subprocess rather than bun's per-test timeout: the bug is a
  // synchronous, allocation-free spin, so it blocks the event loop the timer
  // itself lives on. `test(name, fn, ms)` can never fire against it — the tests
  // above do not fail cleanly on the unfixed renderer, they wedge the whole
  // `bun test` process. That is the same property that made the production
  // symptom a dead daemon rather than a slow page, so the regression guard has
  // to live outside the process it is guarding. Verified: this test reports a
  // clean failure against the pre-fix renderer, where the in-process ones hang.
  test(
    'a CRLF document renders to completion in a subprocess with a hard kill deadline',
    async () => {
      const modulePath = join(import.meta.dir, '..', '..', 'src', 'server', 'markdown.ts');
      const script = `
        const { renderMarkdown } = await import(${JSON.stringify(modulePath)});
        renderMarkdown('# title\\r\\nrest');
        renderMarkdown('- one\\r\\n- two\\r\\ntail');
        renderMarkdown('1. one\\r\\n2. two\\r\\ntail');
        renderMarkdown('# h\\rlone cr');
        console.log('DONE');
      `;

      const proc = spawn([process.execPath, '-e', script], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      expect(stdout).toContain('DONE');
      expect(exitCode).toBe(0);
    },
    30_000
  );
});

describe('renderMarkdown LF baseline (no rendering regressions)', () => {
  test(
    'headings, lists, quotes, rules, code and paragraphs render as before',
    () => {
      expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>');
      expect(renderMarkdown('###### Six')).toBe('<h6>Six</h6>');
      expect(renderMarkdown('one\ntwo')).toBe('<p>one\ntwo</p>');
      expect(renderMarkdown('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
      expect(renderMarkdown('- a\n  - b')).toBe(
        '<ul>\n<li>a</li>\n<ul>\n<li>b</li>\n</ul>\n</ul>'
      );
      expect(renderMarkdown('1. a\n2. b')).toBe('<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
      expect(renderMarkdown('---')).toBe('<hr>');
      expect(renderMarkdown('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
      expect(renderMarkdown('```ts\nconst x = 1;\n```')).toBe(
        '<pre><code class="language-ts">const x = 1;</code></pre>'
      );
      expect(renderMarkdown('**b** *i* `c` [t](u)')).toBe(
        '<p><strong>b</strong> <em>i</em> <code>c</code> <a href="u">t</a></p>'
      );
      expect(renderMarkdown('<script>&"\'')).toBe(
        '<p>&lt;script&gt;&amp;&quot;&#39;</p>'
      );
      expect(renderMarkdown('')).toBe('');
    },
    TIMEOUT_MS
  );

  // INVARIANT: `#hashtag` (no space) is not a heading — it is paragraph text.
  // The classifier and the paragraph lookahead must agree on that; they are the
  // two halves that drifted apart and caused the hang.
  test(
    'non-block lines that merely look like blocks stay paragraphs',
    () => {
      expect(renderMarkdown('#hashtag')).toBe('<p>#hashtag</p>');
      expect(renderMarkdown('-nodash')).toBe('<p>-nodash</p>');
      expect(renderMarkdown('1.nospace')).toBe('<p>1.nospace</p>');
    },
    TIMEOUT_MS
  );
});
