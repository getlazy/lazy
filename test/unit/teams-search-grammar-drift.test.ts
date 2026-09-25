/**
 * The Rails app's copy of the search grammar, held against this one.
 *
 * WHY A COPY EXISTS AT ALL. lazy has one description of its query language,
 * `src/search/grammar.ts`, and every surface renders THAT data — `lazy search
 * --help`, the dashboard's Query syntax panel, the `lazy_search` tool schema.
 * Lazy Teams is a client over RPC and cannot import a TypeScript module, and the
 * grammar is not on the wire: the daemon exposes `search` (run a query) and
 * nothing that says what a query may contain. So `lazy-teams/app/services/
 * search_grammar.rb` restates it, in exactly one place, with a comment pointing
 * back here.
 *
 * A RESTATEMENT IS A DRIFT RISK, so it is checked mechanically. The failure this
 * catches is the one that reaches users: a field advertised in a browser under a
 * name the parser rejects. The `code:` → `task:` rename is precisely that — five
 * prose copies, and `code:<value>` now throws rather than searching for literal
 * text, so a stale sixth copy in Rails would send readers to a query that errors.
 *
 * Comparing the SYNTAX STRINGS only, not the prose: the two audiences differ (a
 * Rails page has no shell to quote things in) and identical wording is not what
 * makes a description correct. Which fields exist, under which names, is.
 *
 * Retire this whole file the day a `searchGrammar` RPC lands and Teams renders
 * the daemon's answer — there is then nothing to drift.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { GRAMMAR_SECTIONS } from '../../src/search/grammar';

const RUBY_GRAMMAR = join(import.meta.dir, '..', '..', 'lazy-teams', 'app', 'services', 'search_grammar.rb');

/**
 * `test/**` ships in the public release; `lazy-teams/` does not
 * (`.releaseinclude` matches neither the app nor this guard's subject). So in a
 * clone of the published repo the Ruby file is absent, and a hard failure there
 * would be a red suite nobody who sees it can fix. Gate on the file, and SAY so
 * — a skip is not a pass.
 */
let ruby: string | null = null;
try {
  ruby = await readFile(RUBY_GRAMMAR, 'utf-8');
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT') throw new Error(`failed to read ${RUBY_GRAMMAR}: ${String(err)}`);
  console.log(
    'skipped: lazy-teams/app/services/search_grammar.rb is not in this checkout ' +
      '(the Rails app does not ship in a public release) — nothing to compare',
  );
}

/** Every `entry("<syntax>", "…")` the Ruby module declares. */
function rubySyntaxes(source: string): string[] {
  return [...source.matchAll(/^\s*entry\("((?:[^"\\]|\\.)*)"/gm)].map(m => m[1]);
}

/**
 * The module with its comment lines removed.
 *
 * The retired-spelling scan below has to read the DECLARATIONS, not the prose:
 * the file's own header explains the `code:` → `task:` rename by name, and a
 * scan that tripped on that would forbid documenting why the rule exists.
 */
function rubyDeclarations(source: string): string {
  return source
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
}

describe('Lazy Teams search-grammar copy', () => {
  // INVARIANT: the Rails app documents exactly the fields this module does —
  // no field missing (a capability nobody in a browser is told about) and none
  // extra (a spelling the parser will refuse). The set, not the order: the two
  // surfaces are free to lay the same fields out differently.
  test.skipIf(ruby === null)('documents exactly the fields this module does', () => {
    const ours = GRAMMAR_SECTIONS.flatMap(section => section.entries.map(e => e.syntax));
    const theirs = rubySyntaxes(ruby!);

    expect(theirs.length).toBeGreaterThan(0);
    expect([...theirs].sort()).toEqual([...ours].sort());
  });

  // INVARIANT: the retired spelling appears in neither description. `code:` is
  // not an alias — the parser throws a QueryParseError naming `task:` — so a
  // surface still advertising it is advertising an error message.
  test.skipIf(ruby === null)('advertises no retired field spelling', () => {
    const ours = GRAMMAR_SECTIONS.flatMap(section => section.entries.map(e => e.syntax));

    expect(ours.some(syntax => syntax.startsWith('code:'))).toBe(false);
    expect(rubySyntaxes(ruby!).some(syntax => syntax.startsWith('code:'))).toBe(false);
    // Not just the field list: a summary, a note or an example naming `code:`
    // teaches it too. Comments are exempt — see rubyDeclarations.
    expect(rubyDeclarations(ruby!)).not.toMatch(/\bcode:/);
  });
});
