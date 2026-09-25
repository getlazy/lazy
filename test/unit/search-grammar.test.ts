/**
 * The anti-drift half of src/search/grammar.ts.
 *
 * The grammar is documented in one place and rendered by `lazy search --help`,
 * the dashboard search page and the MCP tool schema. That removes copy drift
 * between the surfaces; this suite removes drift between the documentation and
 * the PARSER, which is the failure that actually reached users — a field
 * advertised under a name the parser rejects.
 */

import { describe, test, expect } from 'bun:test';
import {
  GRAMMAR_SECTIONS,
  GRAMMAR_EXAMPLES,
  GRAMMAR_NOTES,
  FIELD_FILTERS,
  renderGrammarText,
  renderGrammarNotesText,
} from '../../src/search/grammar';
import { parseQuery, isStructuredQuery } from '../../src/search/parser';

const allEntries = GRAMMAR_SECTIONS.flatMap(s => s.entries);

describe('search grammar', () => {
  // INVARIANT: every syntax the grammar advertises is accepted by the parser.
  // Documenting a field the parser rejects is the bug the `code:` -> `task:`
  // rename was cleaning up; this makes the next such rename fail loudly here
  // instead of quietly in a tool description.
  test('every documented entry parses', () => {
    for (const entry of allEntries) {
      const query = entry.example ?? entry.syntax;
      expect(() => parseQuery(query)).not.toThrow();
    }
  });

  // INVARIANT: every documented entry ROUTES to the structured parser. A field
  // that isStructuredQuery does not recognise is searched as a literal regex
  // instead, which is how a documented filter silently becomes plain text.
  test('every documented entry is recognised as structured', () => {
    for (const entry of allEntries) {
      const query = entry.example ?? entry.syntax;
      expect(isStructuredQuery(query)).toBe(true);
    }
  });

  test('every documented example parses', () => {
    for (const example of GRAMMAR_EXAMPLES) {
      expect(() => parseQuery(example.query)).not.toThrow();
    }
  });

  test('task: is documented, code: is not', () => {
    const syntaxes = FIELD_FILTERS.map(e => e.syntax);
    expect(syntaxes.some(s => s.startsWith('task:'))).toBe(true);
    expect(syntaxes.some(s => s.startsWith('code:'))).toBe(false);
  });

  test('the documented matching semantics name substring and exact', () => {
    const notes = GRAMMAR_NOTES.join(' ');
    expect(notes).toContain('SUBSTRING');
    expect(notes).toContain('status: and tag: are exact');
  });

  test('the plain-text renderers produce every entry', () => {
    const text = renderGrammarText();
    for (const entry of allEntries) {
      expect(text).toContain(entry.syntax);
    }
    for (const section of GRAMMAR_SECTIONS) {
      expect(text).toContain(`${section.title}:`);
    }
    const notes = renderGrammarNotesText();
    // Wrapping breaks lines, so check a distinctive unbroken fragment.
    expect(notes).toContain('case-sensitive');
    expect(notes).toContain('BYPASSES');
  });
});
