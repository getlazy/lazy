/**
 * The one description of lazy's search grammar.
 *
 * `lazy search --help`, the dashboard's search page, the `lazy_search` MCP tool
 * schema and public-docs all describe the same query language. Written out by
 * hand in each place, those copies drift — the `code:` → `task:` rename touched
 * five of them, and a field advertised under a name the parser rejects is worse
 * than no documentation at all. So every surface renders THIS data instead.
 *
 * `test/unit/search-grammar.test.ts` holds the anti-drift half: every `syntax`
 * example below is fed to the real parser, so a field documented here that the
 * parser does not accept (or the reverse) fails the build.
 */

export interface GrammarEntry {
  /** The syntax, exactly as a user would type it. */
  syntax: string;
  /** One line saying what it matches. */
  summary: string;
  /**
   * A concrete, parseable query used to verify this entry against the parser.
   * Present only where `syntax` itself is a placeholder form.
   */
  example?: string;
}

export interface GrammarSection {
  title: string;
  entries: GrammarEntry[];
}

/** Boolean structure — how terms combine. */
export const BOOLEAN_OPERATORS: GrammarEntry[] = [
  { syntax: 'A AND B', summary: 'Both must match (also the implicit operator between two adjacent terms)', example: 'status:working AND has:commits' },
  { syntax: 'A OR B', summary: 'Either matches', example: 'status:working OR status:blocked' },
  { syntax: 'NOT A', summary: 'Negation', example: 'NOT status:abandoned' },
  { syntax: '(A OR B) AND C', summary: 'Parentheses group; AND binds tighter than OR', example: '(status:working OR status:blocked) AND has:commits' },
];

/** Per-field filters over a task's own record. */
export const FIELD_FILTERS: GrammarEntry[] = [
  { syntax: 'task:<text>', summary: 'Task code CONTAINS this text (case-insensitive)', example: 'task:spike' },
  { syntax: 'status:<value>', summary: 'Task status, exact (working, blocked, backlog, complete, abandoned, ...)', example: 'status:blocked' },
  { syntax: 'goal:<text>', summary: 'Task goal contains this text (case-insensitive)', example: 'goal:memory' },
  { syntax: 'tag:<value>', summary: 'Task carries this tag, exact after normalization', example: 'tag:onboarding' },
  { syntax: '#<value>', summary: 'Shorthand for tag:<value>, also matching the literal text "#value"', example: '#onboarding' },
];

/** Text search scoped to one kind of associated content. */
export const SCOPE_FILTERS: GrammarEntry[] = [
  { syntax: 'in:tasks <text>', summary: 'Across tasks and all content attached to them', example: 'in:tasks reconciler' },
  { syntax: 'in:active <text>', summary: 'Within working, interrupted, or blocked tasks', example: 'in:active authentication' },
  { syntax: 'in:backlog <text>', summary: 'Within backlog tasks', example: 'in:backlog authentication' },
  { syntax: 'in:finished <text>', summary: 'Within accepted, closed, or rejected tasks', example: 'in:finished authentication' },
  { syntax: 'in:turns <text>', summary: 'Within turn content', example: 'in:turns reconciler' },
  { syntax: 'in:commits <text>', summary: 'Within commit messages', example: 'in:commits wip' },
  { syntax: 'in:comments <text>', summary: 'Within comments', example: 'in:comments rebase' },
  { syntax: 'in:raised <text>', summary: 'Within raised items (blocking and non-blocking alike)', example: 'in:raised default' },
  { syntax: 'in:followups <text>', summary: 'Alias for in:raised (the pre-unification spelling)', example: 'in:followups default' },
  { syntax: 'in:conversations <text>', summary: 'Within captured builder conversations', example: 'in:conversations design' },
  { syntax: 'in:memories <text>', summary: 'Within shared memory records', example: 'in:memories credentials' },
  { syntax: 'in:scratch <text>', summary: 'Within captured builder scratch files', example: 'in:scratch handoff' },
];

/** Existence checks — does the task have any of this kind of content. */
export const EXISTENCE_FILTERS: GrammarEntry[] = [
  { syntax: 'has:commits', summary: 'Task has commits' },
  { syntax: 'has:turns', summary: 'Task has turns' },
  { syntax: 'has:comments', summary: 'Task has comments' },
  { syntax: 'has:raised', summary: 'Task has raised items' },
  { syntax: 'has:followups', summary: 'Alias for has:raised' },
];

/** Date range filters. */
export const DATE_FILTERS: GrammarEntry[] = [
  { syntax: 'created:>YYYY-MM-DD', summary: 'Created after (also created:< for before)', example: 'created:>2026-01-01' },
  { syntax: 'updated:>YYYY-MM-DD', summary: 'Last updated after (also updated:< for before)', example: 'updated:<2026-01-01' },
];

export const GRAMMAR_SECTIONS: GrammarSection[] = [
  { title: 'Boolean operators', entries: BOOLEAN_OPERATORS },
  { title: 'Field filters', entries: FIELD_FILTERS },
  { title: 'Scoped text search', entries: SCOPE_FILTERS },
  { title: 'Existence checks', entries: EXISTENCE_FILTERS },
  { title: 'Date filters', entries: DATE_FILTERS },
];

/**
 * The behaviour that is not visible in a field list — matching semantics, mode
 * selection, and the two traps (fuzzy bypassing the grammar, unquoted
 * multi-word tags).
 */
export const GRAMMAR_NOTES: string[] = [
  'Boolean operators are case-sensitive: AND, not and. AND binds tighter than OR, and two adjacent terms with no operator are an implicit AND.',
  'task:, goal: and every in: scope are case-insensitive SUBSTRING matches — task:spike finds spike-vm-isolation and publish-runner-spike alike. status: and tag: are exact.',
  'A query with no operator, no field: term and no #tag is a case-insensitive REGEX over all content.',
  'Fuzzy matching (--fuzzy, or fuzzy=true over MCP) BYPASSES the query language: it looks for the literal text you typed, so tag:launch --fuzzy searches for "tag:launch".',
  'Tags are normalized identically on write and on query — lowercased, runs of non-alphanumerics collapsed to hyphens, a leading # stripped. Quote a multi-word tag: tag:"My Feature Work", or only its first word counts.',
  'In a shell, wrap the whole query in single quotes: # starts a comment, and an unquoted multi-word value is split into separate terms.',
];

export interface GrammarExample {
  query: string;
  summary: string;
}

export const GRAMMAR_EXAMPLES: GrammarExample[] = [
  { query: 'auth', summary: 'Regex search over everything' },
  { query: 'task:spike', summary: 'Every task whose code contains "spike"' },
  { query: 'status:blocked AND in:turns "reconciler"', summary: 'Blocked tasks whose turns mention a reconciler' },
  { query: 'goal:memory AND status:backlog', summary: 'Combine a goal substring with a status' },
  { query: 'has:commits AND NOT in:commits "wip"', summary: 'Existence check plus a negation' },
  { query: 'created:>2026-02-15 AND status:working', summary: 'Date range plus a status' },
  { query: 'tag:"My Feature Work"', summary: 'A multi-word tag — quote it' },
  { query: '#onboarding', summary: 'Tag, using the spelling lazy prints' },
  { query: 'in:memories "credentials"', summary: 'Search shared memory records' },
];

/**
 * The field-name list, comma-separated — for prose that names the fields
 * without laying out a table (the MCP tool schema).
 */
export function grammarFieldNames(): string {
  return [...FIELD_FILTERS, ...SCOPE_FILTERS]
    .map(e => e.syntax.split(/[<\s]/)[0])
    .filter(s => s.endsWith(':'))
    .join(', ');
}

/**
 * Render the grammar as plain text for CLI help.
 * `indent` prefixes every line; `width` is the column the summary starts at.
 */
export function renderGrammarText(indent = '  ', width = 26): string {
  const lines: string[] = [];
  for (const section of GRAMMAR_SECTIONS) {
    lines.push(`${indent}${section.title}:`);
    for (const entry of section.entries) {
      lines.push(`${indent}  ${entry.syntax.padEnd(width)}${entry.summary}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** Render the behavioural notes as a wrapped plain-text list for CLI help. */
export function renderGrammarNotesText(indent = '  ', width = 78): string {
  const lines: string[] = [];
  for (const note of GRAMMAR_NOTES) {
    const words = note.split(' ');
    let line = `${indent}- `;
    for (const word of words) {
      if (line.length + word.length + 1 > width && line.trim() !== '-') {
        lines.push(line.trimEnd());
        line = `${indent}  `;
      }
      line += `${word} `;
    }
    lines.push(line.trimEnd());
  }
  return lines.join('\n');
}
