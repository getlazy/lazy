export { parseQuery, isStructuredQuery, QueryParseError } from './parser';
export type { QueryNode, AndNode, OrNode, NotNode, FieldNode, InNode, HasNode, DateNode, TextNode } from './parser';
export { evaluateQuery, buildSearchResults } from './evaluator';
export type { TaskData } from './evaluator';
export { getAllSearchableContent, FUZZY_SEARCH_OPTIONS } from './searchable';
export type { SearchableItem } from './searchable';
export { structuredSearch, buildTagHint } from './structured';
export { executeSearch, SearchPatternError } from './run';
export type { SearchRequest, SearchOutcome } from './run';
export {
  GRAMMAR_SECTIONS,
  GRAMMAR_NOTES,
  GRAMMAR_EXAMPLES,
  FIELD_FILTERS,
  SCOPE_FILTERS,
  EXISTENCE_FILTERS,
  DATE_FILTERS,
  BOOLEAN_OPERATORS,
  grammarFieldNames,
  renderGrammarText,
  renderGrammarNotesText,
} from './grammar';
export type { GrammarEntry, GrammarSection, GrammarExample } from './grammar';
export { BoundedTextMatcher, SEARCH_REGEX_DEADLINE_MS } from './text-matcher';
