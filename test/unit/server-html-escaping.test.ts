/**
 * The dashboard escapes every dynamic value it renders — mechanically checked.
 *
 * WHY THIS EXISTS: a stored XSS shipped in the accept-gate row on the review
 * page. It interpolated a failed review's description — which quotes the review
 * AGENT's own verdict string — into HTML with no `escapeHtml`. Nothing
 * sanitises agent text or a human's free text on the way IN, and the dashboard
 * origin is the one holding the session cookie that authorizes every daemon
 * write route, so one bare `${…}` is enough to act as the human.
 *
 * Three sibling renderers were read by hand at the time and were fine. Reading
 * by hand does not scale to ~3000 interpolations across ~78 files and does not
 * survive the next release, so the rule is a SCAN: every `${…}` inside an HTML
 * template under `src/server/` must be provably unable to carry markup. The
 * scanner (`test/helpers/html-interpolation-scan.ts`) parses with the pinned
 * typescript and a real type checker; what it cannot prove, it reports.
 *
 * Adding a bare interpolation now fails this test instead of waiting for a
 * reviewer to notice it.
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { readFile } from 'fs/promises';
import ts from 'typescript';
import { HtmlInterpolationScanner, inSingleQuotedAttribute } from '../helpers/html-interpolation-scan';
import { escapeHtml, scriptJson } from '../../src/server/escape';
import { reviewsTabHtml } from '../../src/server/reviews-tab';
import { taskTabStripHtml } from '../../src/server/task-tabs';
import { viewedCardHtml } from '../../src/server/viewed-cards';
import { taskForgeLinkHtml, taskForgeIconHtml } from '../../src/task-forge-link';
import { diffViewScript, diffViewOptionsHtml } from '../../src/server/review-diff';
import { settingsTabsHtml } from '../../src/server/settings';
import { actionDialogButtonHtml } from '../../src/server/action-dialog';
import type { ReviewTurnLike } from '../../src/review/success';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** The payload every renderer test feeds in. */
const PAYLOAD = `<script>alert('xss')</script>`;

/** A payload that also closes an inline <script> element. */
const SCRIPT_PAYLOAD = `</script><img src=x onerror=alert(1)>`;

/**
 * The output must not contain the payload's opening tag verbatim anywhere.
 *
 * Asserting "no `<` at all" is not possible — the output IS markup — so the
 * assertion is the one that matters: the injected tag did not survive as a tag.
 */
function expectEscaped(html: string, payload = PAYLOAD): void {
  expect(html).not.toContain(payload);
  expect(html).not.toContain('<script>alert');
  expect(html).not.toContain('<img src=x');
  // And the value is still THERE, escaped — dropping it silently would pass an
  // assertion about `<` while losing the reader's text.
  expect(html).toContain(escapeHtml(payload).slice(0, 20));
}

/**
 * Interpolations the scan cannot prove safe, each pinned with the reason it is
 * nonetheless safe. A pin is a claim someone checked by hand — keep it small.
 *
 * `expression` is matched exactly against the scanner's rendering of the
 * expression, so a pin cannot silently cover a DIFFERENT hole that appears in
 * the same file later. A pin matching nothing fails the test below: a stale
 * exception is how an allowlist turns into a blindfold.
 */
interface PinnedException {
  file: string;
  expression: string;
  reason: string;
}

const PINNED: PinnedException[] = [
  // renderInline() escapes the WHOLE text first and then transforms the escaped
  // string: every one of these is a slice of, or a match within, output that
  // already went through escapeHtml. Escaping them again would double-escape
  // the reader's text (`&amp;lt;`), which is why these are pinned rather than
  // "fixed".
  { file: 'src/server/markdown.ts', expression: 'label', reason: 'slice of the already-escaped text (renderInline escapes first, transforms after)' },
  { file: 'src/server/markdown.ts', expression: 'href', reason: 'slice of the already-escaped text, further restricted by safeLinkHref' },
  { file: 'src/server/markdown.ts', expression: 'inner', reason: 'inline-code body, taken from the already-escaped text' },
  { file: 'src/server/markdown.ts', expression: 'match', reason: 'regex match within the already-escaped text' },
  { file: 'src/server/markdown.ts', expression: 'raw', reason: 'inline-code body, taken from the already-escaped text' },
  { file: 'src/server/markdown.ts', expression: 'safe', reason: 'the link href after safeLinkHref, taken from the already-escaped text' },

  // Pre-rendered ATTRIBUTE TEXT, which is a real thing a caller passes and no
  // longer trusted by name (see `Attrs` in the scanner). `extraAttrs` is
  // documented as caller-escaped and every call site passes a literal; it
  // cannot be escaped here without destroying what it is for — the `=` and the
  // quotes are its content.
  { file: 'src/server/action-dialog.ts', expression: 'extra', reason: 'pre-rendered attribute text (opts.extraAttrs), documented caller-escaped, literal at every call site' },

  // Not markup at all: a plain sentence that happens to contain `<name>`, which
  // is what makes the scanner read the template as HTML. It reaches the page as
  // `notice.text`, which taskEditHtml renders through escapeHtml.
  { file: 'src/server/index.ts', expression: 'task.model', reason: 'plain-text notice, escaped by taskEditHtml as notice.text' },
  { file: 'src/server/index.ts', expression: 'task.code ?? task.id', reason: 'plain-text notice, escaped by taskEditHtml as notice.text' },
];

describe('src/server HTML templates escape every dynamic value', () => {
  const scanner = new HtmlInterpolationScanner(REPO_ROOT);
  const findings = scanner.scan();

  // INVARIANT: no `${…}` in an HTML template under src/server/ may carry a
  // value the scan cannot prove is non-markup. The dashboard origin holds the
  // session cookie authorizing every daemon write route, and neither agent
  // output nor human free text is sanitised on the way in.
  test('no bare interpolation outside the pinned exceptions', () => {
    const unpinned = findings.filter(
      (f) => !PINNED.some((p) => p.file === f.file && p.expression === f.expression),
    );
    const report = unpinned
      .map((f) => `  ${f.file}:${f.line}  \${${f.expression}}   …${f.context}`)
      .join('\n');
    expect(
      report === '' ? '' : `bare interpolation in an HTML template:\n${report}\n\n` +
        'Wrap the value in escapeHtml (or encodeURIComponent for a URL path segment),\n' +
        'name it `…Html` if it really is pre-rendered markup, or pin it in PINNED with a reason.',
    ).toBe('');
  });

  // INVARIANT: a pinned exception that no longer matches anything is removed,
  // not left behind. An allowlist nobody prunes stops describing the code and
  // starts hiding it.
  test('every pinned exception still matches a real finding', () => {
    const stale = PINNED.filter(
      (p) => !findings.some((f) => f.file === p.file && f.expression === p.expression),
    );
    expect(stale.map((p) => `${p.file}: \${${p.expression}}`)).toEqual([]);
  });

  // INVARIANT: no module under src/server/ writes its own escaping body. The
  // scan trusts `escapeHtml` / `escapeAttr` / `escapeText` BY NAME, so a local
  // function under one of those names that escapes less would be believed —
  // which is not hypothetical: of the nine copies this sweep removed, three had
  // already drifted (two left `'` raw, one left every quote raw). A wrapper
  // that DELEGATES to the shared escaper is fine, and is how the two remaining
  // `escapeAttr`s work; starting from `.replace(/&/g` is not.
  //
  // MODULE-LEVEL only, and the anchor is the whole boundary: an escaper
  // declared at column 0 is this repo's server code, while an indented one is
  // browser code inside an island's template string. Two of those exist today
  // (`settings.ts` and `action-dialog.ts`, both missing `'`, both duplicating
  // the `ESCAPE_HTML_JS` that `escape.ts` ships for exactly this) and they are
  // NOT covered here: the island sinks are a separate follow-up, and pretending
  // this test covers them would be the more dangerous lie. See
  // docs/dashboard-html-escaping.md.
  test('no module re-implements an escaper under a trusted name', async () => {
    const offenders: string[] = [];
    for (const rel of scanner.scannedFiles()) {
      if (rel === join('src', 'server', 'escape.ts')) continue; // the one home
      const source = await readFile(join(REPO_ROOT, rel), 'utf-8');
      const declarations = source.matchAll(
        /^(?:function|const)\s+(escapeHtml|escapeAttr|escapeText)\b[\s\S]{0,400}?(?:\n\}|;\n)/gm,
      );
      for (const match of declarations) {
        if (/\.replace\(\/&\/g/.test(match[0])) offenders.push(`${rel}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // INVARIANT: `encodeURIComponent` is trusted only OUTSIDE a single-quoted
  // attribute. It deliberately leaves `'` unencoded (with `!~*()`), so in
  // `href='${encodeURIComponent(x)}'` it escapes nothing that matters and the
  // value breaks out of the attribute. Every other name on the escaping list
  // covers the apostrophe; this is the one whose trust is POSITIONAL, and the
  // tree having no single-quoted attribute today is what this keeps true.
  test('encodeURIComponent is not trusted inside a single-quoted attribute', () => {
    const inSingleQuotes = (src: string): boolean => {
      const sf = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true);
      let span: ts.TemplateSpan | undefined;
      const visit = (n: ts.Node): void => {
        if (!span && ts.isTemplateSpan(n)) span = n;
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (!span) throw new Error(`no template span in probe: ${src}`);
      return inSingleQuotedAttribute(span.expression);
    };

    expect(inSingleQuotes("const h = `<a href='${u}'>x</a>`;")).toBe(true);
    expect(inSingleQuotes('const h = `<a href="${u}">x</a>`;')).toBe(false);
    // A single-quoted attribute that already CLOSED does not trap what follows.
    expect(inSingleQuotes("const h = `<a rel='x' href=\"${u}\">y</a>`;")).toBe(false);
    // Outside any attribute at all.
    expect(inSingleQuotes('const h = `<p>${u}</p>`;')).toBe(false);
  });

  test('the scan actually covers the tree', () => {
    const files = scanner.scannedFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('src/server/current-review.ts');
    expect(files).toContain('src/server/templates.ts');
  });
});

describe('renderers that were fixed by this sweep', () => {
  // A review verdict is the agent's own string, which is exactly the value the
  // original XSS carried. reviews-tab kept a hand-rolled escaper that left `'`
  // raw; it now uses the one in src/server/escape.ts.
  test('the Reviews tab escapes an agent verdict', () => {
    const turns: ReviewTurnLike[] = [
      {
        sequence: 3,
        role: 'agent',
        turn_type: 'review',
        created_at: 1_700_000_000_000,
        review: {
          verdict: PAYLOAD,
          security: 'none found',
          data_integrity: 'none found',
          findings: [],
        } as ReviewTurnLike['review'],
      },
    ];
    const html = reviewsTabHtml('task-id', turns);
    expectEscaped(html);
    expect(html).not.toContain(`'xss'`);
  });

  test('the task tab strip escapes a badge label and its tooltip', () => {
    const html = taskTabStripHtml({
      taskId: 'task-id',
      current: 'landing',
      badges: { raised: { text: PAYLOAD, title: PAYLOAD } },
    } as Parameters<typeof taskTabStripHtml>[0]);
    expectEscaped(html);
  });

  test('a viewed card escapes the DOM id it is given', () => {
    const html = viewedCardHtml({
      key: 'turn:1',
      content: 'body',
      headHtml: '<span>head</span>',
      bodyHtml: '<p>body</p>',
      id: `x" onload="alert(1)`,
    });
    expect(html).not.toContain('onload="alert(1)"');
    expect(html).toContain('&quot;');
  });

  test('the forge link escapes a URL and a label', () => {
    const link = { url: `https://example.com/"><script>alert(1)</script>`, kind: 'pr' as const, forge: 'github' as const, id: PAYLOAD };
    expect(taskForgeLinkHtml(link)).not.toContain('<script>alert(1)');
    expect(taskForgeIconHtml(link)).not.toContain('<script>alert(1)');
  });

  test('the diff view script seeds its values through scriptJson', () => {
    const script = diffViewScript('#rv-root', `/tasks/x/expand${SCRIPT_PAYLOAD}`);
    // The HTML parser looks for `</script` before the JS parser sees anything,
    // so an unescaped one ends the island early and the rest parses as HTML.
    expect(script).not.toContain('</script><img');
    expect(script).toContain('\\u003c/script');
  });

  test('scriptJson keeps the value intact while neutralising the sink', () => {
    expect(JSON.parse(scriptJson(SCRIPT_PAYLOAD))).toBe(SCRIPT_PAYLOAD);
  });

  test('the diff view options escape their mode names', () => {
    expect(diffViewOptionsHtml()).not.toContain('<script');
  });

  test('the settings tab strip escapes its hrefs and labels', () => {
    const html = settingsTabsHtml('memory');
    expect(html).toContain('/settings/memory');
    expect(html).not.toContain('<script');
  });

  test('an action button escapes the extra class it is handed', () => {
    const html = actionDialogButtonHtml({
      verb: 'accept',
      label: 'Accept',
      extraClass: `x" onmouseover="alert(1)`,
    } as Parameters<typeof actionDialogButtonHtml>[0]);
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain('&quot;');
  });
});
