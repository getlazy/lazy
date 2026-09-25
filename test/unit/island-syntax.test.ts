/**
 * Every inline island the dashboard emits has to PARSE, and the list of
 * islands is DISCOVERED, not maintained by hand.
 *
 * INVARIANT: an island's source is a TypeScript template literal, so every
 * backslash the browser must see has to be doubled. `/^\/raised\/[^/]+$/`
 * written with single backslashes reached the browser as `/^/raised/[^/]+$/` —
 * a syntax error that killed the ENTIRE tab-switching island: no in-place tab
 * switching, no `window.lzSwitchTaskTab`, no per-tab body cache. The only
 * evidence was one line in a browser console nobody was reading.
 *
 * The class of bug is invisible to the type checker and to every test that
 * asserts on an island's TEXT — the broken script still contains all the right
 * substrings. Only parsing it catches it, so parse them all.
 *
 * WHY THE SCAN. This guard exists because a bug shipped that nobody noticed,
 * so it must not itself depend on someone noticing. A hand-kept array would be
 * exactly that: the next island would be added to `src/server/` and silently
 * not covered. So {@link discoverIslands} reads `src/server/*.ts` and finds
 * every function that returns a `<script>` literal; a discovered island with
 * no entry in {@link ISLANDS} fails the coverage test BY NAME. Same shape as
 * `cli-flag-alias-coverage`, `cli-subcommand-usage-coverage` and
 * `daemon-cli-decoupling`: mechanical, because the drift never arrives as one
 * reviewable omission.
 *
 * Private islands are reached through the public renderer that emits them
 * (`layoutHtml` ships the nav islands, `subtasksSectionHtml` the filter one, …),
 * so nothing is exported purely for this test.
 *
 * `new Function(src)` compiles without executing: no DOM is touched, and a
 * reference to `document` inside the body is never evaluated.
 */

import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

import { taskTabSwitchScript } from '../../src/server/task-tabs';
import { reviewNavigationScript } from '../../src/server/review-navigation';
import { viewedStateScript } from '../../src/server/viewed-cards';
import { reviewDraftScript } from '../../src/server/review-draft-script';
import { raisedDialogScript } from '../../src/server/raised-dialog';
import { raisedDecideScript } from '../../src/server/raised-decide';
import { actionDialogScript } from '../../src/server/action-dialog';
import { verifyCopyScript, verifyRunScript } from '../../src/server/review-verify';
import { taskLiveStatusScript } from '../../src/server/task-live-status';
import { domMorphScript } from '../../src/server/dom-morph';
import { commandPaletteScript } from '../../src/server/command-palette';
import { reviewScript } from '../../src/server/review';
import { containerEnsureClientScript } from '../../src/server/container-ensure-client';
import { watchClientScript } from '../../src/server/watch-ui';
import { shellClientScript } from '../../src/server/shell-ui';
import { mermaidEnhanceScript } from '../../src/server/mermaid';
import { changesViewScript } from '../../src/server/review-presentation';
import { doctorDialogScript } from '../../src/server/settings';
import { diffViewScript } from '../../src/server/review-diff';
import { relativeTimeScript } from '../../src/server/timestamps';
import { modifierKeyScript } from '../../src/server/modifier-key';
import { screenshotLightboxScript } from '../../src/server/screenshot-lightbox';
import { layoutHtml } from '../../src/server/templates';
import { subtasksSectionHtml } from '../../src/server/subtasks';
import { servicesCardHtml } from '../../src/server/services-card';
import type { Task } from '../../src/types';

const SERVER_DIR = join(import.meta.dir, '../../src/server');

export interface DiscoveredIsland {
  /** The enclosing top-level function's name. */
  fn: string;
  /** File it lives in, for the failure message. */
  file: string;
}

/**
 * Every function under `src/server/` that returns an inline `<script>`.
 *
 * Deliberately a source scan and not a module walk: an island is identified by
 * the shape of what it RETURNS, and several are not exported. Comments are
 * blanked first so a `` `<script>` `` mentioned in a doc comment is not
 * mistaken for one; the enclosing function is the last one declared at column
 * zero, so a nested helper inside an island is attributed to the island.
 */
export async function discoverIslands(dir = SERVER_DIR): Promise<DiscoveredIsland[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
  const found: DiscoveredIsland[] = [];
  for (const file of files.sort()) {
    const raw = await readFile(join(dir, file), 'utf8');
    // Blank block comments, preserving newlines so offsets still line up.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    for (const match of src.matchAll(/`<script>/g)) {
      const before = src.slice(0, match.index);
      const fn = [...before.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm)].pop();
      if (!fn) continue;
      if (found.some((f) => f.fn === fn[1] && f.file === file)) continue;
      found.push({ fn: fn[1]!, file });
    }
  }
  return found;
}

function task(): Task {
  return {
    id: 'abc12345-0000-0000-0000-000000000000',
    code: 'island-demo',
    goal: 'islands',
    prompt: 'islands',
    type: 'task',
    status: 'blocked',
    created_at: 1_700_000_000_000,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    runner_type: null,
    metadata: null,
    tags: [],
    pending_sync: 0,
  };
}

/**
 * How to make each discovered island emit its script. Directly where the
 * function is exported; through the public renderer that ships it where it is
 * not. The key is the DISCOVERED function name — that is what the coverage
 * test matches against.
 */
const ISLANDS: Record<string, () => string> = {
  taskTabSwitchScript: () => taskTabSwitchScript(),
  reviewNavigationScript: () => reviewNavigationScript(),
  viewedStateScript: () => viewedStateScript('task-1'),
  reviewDraftScript: () => reviewDraftScript('task-1'),
  raisedDialogScript: () => raisedDialogScript(),
  raisedDecideScript: () => raisedDecideScript(),
  actionDialogScript: () => actionDialogScript(),
  verifyCopyScript: () => verifyCopyScript(),
  verifyRunScript: () => verifyRunScript(),
  taskLiveStatusScript: () => taskLiveStatusScript(),
  domMorphScript: () => domMorphScript(),
  commandPaletteScript: () => commandPaletteScript(),
  reviewScript: () => reviewScript('task-1'),
  containerEnsureClientScript: () => containerEnsureClientScript(),
  watchClientScript: () => watchClientScript(),
  shellClientScript: () => shellClientScript(),
  mermaidEnhanceScript: () => mermaidEnhanceScript(),
  changesViewScript: () => changesViewScript(),
  doctorDialogScript: () => doctorDialogScript(),
  diffViewScript: () => diffViewScript('#rv-root', '/expand'),
  relativeTimeScript: () => relativeTimeScript(),
  modifierKeyScript: () => modifierKeyScript(),
  screenshotLightboxScript: () => screenshotLightboxScript(),
  // Private islands, reached through what ships them.
  navBadgeScript: () => layoutHtml('t', '<p>body</p>'),
  navProgressScript: () => layoutHtml('t', '<p>body</p>'),
  // Defined as the very first thing in <body>, before any tab body script —
  // see the comment on lzOnceScriptHtml for why the order is load-bearing.
  lzOnceScriptHtml: () => layoutHtml('t', '<p>body</p>'),
  subtasksFilterScript: () => subtasksSectionHtml({ parentId: 'p', children: [task()] }),
  // Needs a service with a live binding: the card ships no island when there
  // is nothing to copy.
  servicesCopyScript: () => servicesCardHtml(task(), {
    declared: [{ name: 'web', port: 3000 }],
    services: [{
      name: 'web',
      port: 3000,
      binding: { containerPort: 3000, hostPort: 39000, hostAddress: '127.0.0.1' },
      url: 'http://127.0.0.1:39000',
      listening: true,
    }],
    unavailable: null,
    containerName: 'lazy-island-demo',
    runnerType: 'docker',
  }),
};

export interface EatenEscape {
  file: string;
  line: number;
  /** The character the lone backslash was attached to, e.g. `d`, `+`, `/`. */
  escape: string;
  /** The source line, trimmed — enough to find it without opening the file. */
  source: string;
}

/**
 * Every backslash inside an island's template literal that the literal will
 * CONSUME before the browser ever sees it.
 *
 * A template literal resolves `\d` to `d`, `\+` to `+`, `\/` to `/`. So a
 * backslash meant for the browser must be written `\\`, ALWAYS, whatever it
 * sits in — a regex, a string, or a comment. Two exceptions, both intentional
 * and both of which must NOT be doubled:
 *
 *   - `\$` before `{`, which emits a literal `${` instead of interpolating.
 *   - `` \` ``, which emits a backtick instead of closing the literal.
 *
 * Scanned regions are the island literals themselves (`` `<script> `` up to
 * ``</script>` ``) plus the body of every script FRAGMENT — a `*Script`
 * function that returns bare JS for an island to interpolate, today only
 * `presentedViewScript`. Fragments are derived, not listed, so a new one
 * cannot be forgotten.
 */
export async function findEatenEscapes(dir = SERVER_DIR): Promise<EatenEscape[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
  const found: EatenEscape[] = [];

  const scan = (file: string, whole: string, region: string, offset: number): void => {
    const base = whole.slice(0, offset).split('\n').length;
    for (const m of region.matchAll(/(?<!\\)\\(?!\\)([\s\S])/g)) {
      const escape = m[1]!;
      if (escape === '$' || escape === '`') continue;
      const upto = region.slice(0, m.index);
      const line = base + upto.split('\n').length - 1;
      const lineText = (region.slice(0, m.index).split('\n').pop() ?? '')
        + (region.slice(m.index).split('\n')[0] ?? '');
      found.push({ file, line, escape, source: lineText.trim() });
    }
  };

  for (const file of files.sort()) {
    const raw = await readFile(join(dir, file), 'utf8');

    // Island literals.
    let i = 0;
    for (;;) {
      const start = raw.indexOf('`<script>', i);
      if (start < 0) break;
      const end = raw.indexOf('</script>`', start);
      if (end < 0) break;
      scan(file, raw, raw.slice(start, end), start);
      i = end + 1;
    }

    // Script fragments: a `*Script` function with no `<script>` of its own.
    // Its output lands inside an island, so the same rule applies to it.
    const commentless = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    for (const m of commentless.matchAll(/^(?:export\s+)?function\s+([A-Za-z0-9_]+Script)\s*\(/gm)) {
      const start = m.index!;
      const close = commentless.indexOf('\n}\n', start);
      const body = raw.slice(start, close < 0 ? raw.length : close);
      if (body.includes('`<script>')) continue;
      scan(file, raw, body, start);
    }
  }
  return found;
}

/** Every `<script>` body in a chunk of HTML. Skips `src=` tags, which have none. */
function scriptBodies(html: string): string[] {
  const bodies: string[] = [];
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1] ?? '';
    if (/\ssrc\s*=/.test(attrs)) continue;
    const body = (m[2] ?? '').trim();
    if (body) bodies.push(body);
  }
  return bodies;
}

describe('inline islands are syntactically valid JavaScript', () => {
  // The mechanical half: nobody has to remember to extend ISLANDS.
  test('every island under src/server/ is covered by this suite', async () => {
    const discovered = await discoverIslands();
    // Sanity: a scan that finds nothing would pass every check vacuously.
    expect(discovered.length).toBeGreaterThan(15);
    const uncovered = discovered
      .filter((d) => !(d.fn in ISLANDS))
      .map((d) => `${d.file}:${d.fn}`);
    expect(uncovered).toEqual([]);
  });

  // …and nothing lingers in ISLANDS for a function that no longer exists.
  test('this suite lists no island that src/server/ no longer has', async () => {
    const discovered = new Set((await discoverIslands()).map((d) => d.fn));
    const stale = Object.keys(ISLANDS).filter((name) => !discovered.has(name));
    expect(stale).toEqual([]);
  });

  for (const [name, produce] of Object.entries(ISLANDS)) {
    test(`${name} parses`, () => {
      const bodies = scriptBodies(produce());
      // A producer that emits no script is a wrong entry, not a pass.
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(() => new Function(body)).not.toThrow();
      }
    });
  }

  // The specific regression: the raised-permalink guard in the tab island.
  // A single-backslash `\/` in a template literal is silently eaten.
  test('the tab island emits an escaped raised-permalink pattern', () => {
    expect(taskTabSwitchScript()).toContain('/^\\/raised\\/[^/]+$/');
  });
});

/**
 * INVARIANT: no island may contain a backslash its own template literal will
 * eat. Parsing is only half the guard, and this is the half that was missing.
 *
 * `new Function(body)` proves an island is syntactically valid. It cannot see
 * an eaten escape that leaves something valid-but-WRONG, and that is the more
 * common shape: `/of \+(\d+)/` reached the browser as `/of +(d+)/` — a perfect
 * regex that can never match, so a fully-expanded file went on telling the
 * reviewer there was more to see. Nothing threw, nothing looked odd, and every
 * text assertion still passed.
 *
 * Both halves of the class were found in one task. A guard that catches only
 * the syntactic half lets the next one through.
 */
describe('no island contains an escape its template literal will eat', () => {
  test('every backslash bound for the browser is doubled', async () => {
    const eaten = await findEatenEscapes();
    // Fail with the fix in the message: the answer is always "double it",
    // in a regex, a string or a comment alike.
    const report = eaten.map(
      (e) => `${e.file}:${e.line} — \\${e.escape} is eaten by the template literal; write \\\\${e.escape}\n    ${e.source}`,
    );
    expect(report).toEqual([]);
  });

  // Sanity: a scanner that inspects nothing would pass this suite vacuously,
  // exactly as a discovery scan that finds no islands would.
  test('the scan actually reads the island literals', async () => {
    const escapes = await findEatenEscapes();
    expect(Array.isArray(escapes)).toBe(true);
    // The correctly-doubled forms are present in the source and must NOT be
    // flagged — proof the scan distinguishes `\\d` from `\d` rather than
    // returning empty because it matched nothing at all.
    const tabs = await readFile(join(SERVER_DIR, 'task-tabs.ts'), 'utf8');
    expect(tabs).toContain('/^\\\\/raised\\\\/[^/]+$/');
    const diff = await readFile(join(SERVER_DIR, 'review-diff.ts'), 'utf8');
    expect(diff).toContain('/of \\\\+(\\\\d+)/');
  });

  /**
   * INVARIANT: an island escaping a double quote for a CSS attribute selector
   * writes FOUR backslashes, not two.
   *
   * The scan above cannot catch this one, and that is the point of a second
   * test rather than a smarter first one: it flags a LONE backslash, and both
   * the right and the wrong form here are doubled. Which doubling is correct
   * depends on what the browser is meant to receive — a regex wants `\d`, so
   * two; a selector wants `\"`, so four — and no scanner can read that
   * intent.
   *
   * What it CAN read is the one call shape where the answer is never in
   * doubt: a `.replace(/"/g, …)` INSIDE AN ISLAND whose replacement is itself
   * a backslash escape. That exists for exactly one reason — quoting a value
   * into `[attr="…"]`. Written with two, it resolves to a replace of `"` with
   * `"` (a no-op), and the selector it builds throws on the first path
   * containing a quote, which from a click escapes the delegated listener and
   * kills that control for the whole file.
   *
   * Scoped to island regions and to replacements CONTAINING a backslash on
   * purpose: the same call with `&quot;` is server-side HTML escaping, a
   * different and correct thing, and this must not drag those in.
   */
  test('a selector-quote escape in an island is doubled for the browser, not just for TypeScript', async () => {
    // Spelled without escapes of its own: this test is about miscounting
    // backslashes, so it must not depend on getting its own count right.
    const BACKSLASH = String.fromCharCode(92);
    const CORRECT = BACKSLASH.repeat(4) + '"';
    const files = (await readdir(SERVER_DIR)).filter((f) => f.endsWith('.ts'));
    const wrong: string[] = [];
    for (const file of files.sort()) {
      const raw = await readFile(join(SERVER_DIR, file), 'utf8');
      // Island literals only — same region walk findEatenEscapes does.
      let i = 0;
      for (;;) {
        const start = raw.indexOf('`<script>', i);
        if (start < 0) break;
        const end = raw.indexOf('</script>`', start);
        if (end < 0) break;
        const region = raw.slice(start, end);
        for (const m of region.matchAll(/\.replace\(\/"\/g,\s*'([^']*)'\)/g)) {
          const replacement = m[1] ?? '';
          if (!replacement.includes(BACKSLASH)) continue;
          if (replacement === CORRECT) continue;
          const line = raw.slice(0, start + (m.index ?? 0)).split('\n').length;
          wrong.push(`${file}:${line} — replacement is '${replacement}', must be '${CORRECT}'`);
        }
        i = end + 1;
      }
    }
    expect(wrong).toEqual([]);
  });
});
