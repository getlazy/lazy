/**
 * Lucene-style query parser for lazy search.
 *
 * Grammar (AND binds tighter than OR):
 *   query     → or_expr EOF
 *   or_expr   → and_expr (OR and_expr)*
 *   and_expr  → term (AND term)*
 *   term      → NOT? atom
 *   atom      → '(' or_expr ')' | field_expr | text_match
 *   field_expr→ FIELD ':' VALUE
 *   text_match→ QUOTED_STRING | BARE_WORD
 *
 * Tokens: AND, OR, NOT, LPAREN, RPAREN, FIELD_VALUE, QUOTED_STRING, BARE_WORD
 */

// ─── AST Types ───────────────────────────────────────────

export type QueryNode =
  | AndNode
  | OrNode
  | NotNode
  | FieldNode
  | InNode
  | HasNode
  | DateNode
  | TextNode;

export interface AndNode {
  type: 'and';
  left: QueryNode;
  right: QueryNode;
}

export interface OrNode {
  type: 'or';
  left: QueryNode;
  right: QueryNode;
}

export interface NotNode {
  type: 'not';
  operand: QueryNode;
}

/** Field match: status:working, goal:"some text", code:fix-reconciler */
export interface FieldNode {
  type: 'field';
  field: 'status' | 'goal' | 'code';
  value: string;
}

/** Scoped search: in:turns "reconciler", in:commits "wip", in:conversations "design" */
export interface InNode {
  type: 'in';
  scope: 'turns' | 'commits' | 'comments' | 'conversations';
  value: string;
}

/** Existence check: has:commits, has:turns, has:comments */
export interface HasNode {
  type: 'has';
  scope: 'commits' | 'turns' | 'comments';
}

/** Date range: created:>2026-02-15, updated:<2026-01-01 */
export interface DateNode {
  type: 'date';
  field: 'created' | 'updated';
  op: '>' | '<';
  value: string; // ISO date string YYYY-MM-DD
}

/** Free-text search (unfielded) */
export interface TextNode {
  type: 'text';
  value: string;
}

// ─── Token Types ─────────────────────────────────────────

type TokenType =
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'LPAREN'
  | 'RPAREN'
  | 'QUOTED'
  | 'WORD'
  | 'EOF';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

// ─── Tokenizer ───────────────────────────────────────────

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) {
      i++;
      continue;
    }

    // Parentheses
    if (input[i] === '(') {
      tokens.push({ type: 'LPAREN', value: '(', pos: i });
      i++;
      continue;
    }
    if (input[i] === ')') {
      tokens.push({ type: 'RPAREN', value: ')', pos: i });
      i++;
      continue;
    }

    // Quoted string
    if (input[i] === '"') {
      const start = i;
      i++; // skip opening quote
      let value = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
        } else {
          value += input[i];
          i++;
        }
      }
      if (i < input.length) {
        i++; // skip closing quote
      }
      tokens.push({ type: 'QUOTED', value, pos: start });
      continue;
    }

    // Word (includes field:value patterns)
    const start = i;
    let word = '';
    while (i < input.length && !/[\s()":]/.test(input[i])) {
      word += input[i];
      i++;
    }

    // Check for field:value pattern
    if (i < input.length && input[i] === ':') {
      // This is a field prefix, consume the colon and value
      const fieldName = word;
      i++; // skip colon

      let fieldValue = '';
      if (i < input.length && input[i] === '"') {
        // Quoted value
        i++; // skip opening quote
        while (i < input.length && input[i] !== '"') {
          if (input[i] === '\\' && i + 1 < input.length) {
            fieldValue += input[i + 1];
            i += 2;
          } else {
            fieldValue += input[i];
            i++;
          }
        }
        if (i < input.length) {
          i++; // skip closing quote
        }
      } else {
        // Bare value
        while (i < input.length && !/[\s()"]/.test(input[i])) {
          fieldValue += input[i];
          i++;
        }
      }

      // Emit field:value as a single WORD token with the colon preserved
      tokens.push({ type: 'WORD', value: `${fieldName}:${fieldValue}`, pos: start });
      continue;
    }

    if (word.length === 0) {
      // Single colon or unexpected character, skip
      i++;
      continue;
    }

    // Check for boolean operators (case-sensitive)
    if (word === 'AND') {
      tokens.push({ type: 'AND', value: word, pos: start });
    } else if (word === 'OR') {
      tokens.push({ type: 'OR', value: word, pos: start });
    } else if (word === 'NOT') {
      tokens.push({ type: 'NOT', value: word, pos: start });
    } else {
      tokens.push({ type: 'WORD', value: word, pos: start });
    }
  }

  tokens.push({ type: 'EOF', value: '', pos: input.length });
  return tokens;
}

// ─── Parser ──────────────────────────────────────────────

export class QueryParseError extends Error {
  constructor(message: string, public pos: number) {
    super(message);
    this.name = 'QueryParseError';
  }
}

/**
 * Parse a Lucene-style query string into an AST.
 * Returns null if the input is a simple text query (no operators or field syntax).
 */
export function parseQuery(input: string): QueryNode {
  const tokens = tokenize(input);
  let current = 0;

  function peek(): Token {
    return tokens[current];
  }

  function advance(): Token {
    const tok = tokens[current];
    current++;
    return tok;
  }

  function expect(type: TokenType): Token {
    const tok = peek();
    if (tok.type !== type) {
      throw new QueryParseError(
        `Expected ${type} but got ${tok.type} ("${tok.value}")`,
        tok.pos
      );
    }
    return advance();
  }

  function parseOr(): QueryNode {
    let left = parseAnd();

    while (peek().type === 'OR') {
      advance();
      const right = parseAnd();
      left = { type: 'or', left, right };
    }

    return left;
  }

  function parseAnd(): QueryNode {
    let left = parseTerm();

    while (peek().type === 'AND') {
      advance();
      const right = parseTerm();
      left = { type: 'and', left, right };
    }

    return left;
  }

  function parseTerm(): QueryNode {
    if (peek().type === 'NOT') {
      advance();
      const operand = parseAtom();
      return { type: 'not', operand };
    }
    return parseAtom();
  }

  function parseAtom(): QueryNode {
    const tok = peek();

    // Parenthesized expression
    if (tok.type === 'LPAREN') {
      advance();
      const expr = parseOr();
      expect('RPAREN');
      return expr;
    }

    // Quoted string = text search
    if (tok.type === 'QUOTED') {
      advance();
      return { type: 'text', value: tok.value };
    }

    // Word — could be a field:value or bare text
    if (tok.type === 'WORD') {
      advance();
      return parseFieldOrText(tok.value, tok.pos);
    }

    throw new QueryParseError(
      `Unexpected token ${tok.type} ("${tok.value}")`,
      tok.pos
    );
  }

  function parseFieldOrText(word: string, pos: number): QueryNode {
    const colonIdx = word.indexOf(':');
    if (colonIdx === -1) {
      return { type: 'text', value: word };
    }

    const field = word.substring(0, colonIdx).toLowerCase();
    const value = word.substring(colonIdx + 1);

    // status:value
    if (field === 'status') {
      if (!value) {
        throw new QueryParseError('status: requires a value', pos);
      }
      return { type: 'field', field: 'status', value: value.toLowerCase() };
    }

    // goal:value or goal:"multi word"
    if (field === 'goal') {
      if (!value) {
        throw new QueryParseError('goal: requires a value', pos);
      }
      return { type: 'field', field: 'goal', value };
    }

    // code:value
    if (field === 'code') {
      if (!value) {
        throw new QueryParseError('code: requires a value', pos);
      }
      return { type: 'field', field: 'code', value: value.toLowerCase() };
    }

    // in:scope — the next token is the search text
    if (field === 'in') {
      const scope = value.toLowerCase();
      if (scope !== 'turns' && scope !== 'commits' && scope !== 'comments' && scope !== 'conversations') {
        throw new QueryParseError(
          `in: scope must be "turns", "commits", "comments", or "conversations" (got "${value}")`,
          pos
        );
      }
      // The search text for in: comes from the next token
      const nextTok = peek();
      let searchText: string;
      if (nextTok.type === 'QUOTED') {
        advance();
        searchText = nextTok.value;
      } else if (nextTok.type === 'WORD') {
        advance();
        searchText = nextTok.value;
      } else {
        throw new QueryParseError(
          `in:${scope} requires a search text after it`,
          nextTok.pos
        );
      }
      return { type: 'in', scope, value: searchText };
    }

    // has:scope
    if (field === 'has') {
      const scope = value.toLowerCase();
      if (scope !== 'commits' && scope !== 'turns' && scope !== 'comments') {
        throw new QueryParseError(
          `has: scope must be "commits", "turns", or "comments" (got "${value}")`,
          pos
        );
      }
      return { type: 'has', scope };
    }

    // created:>date or created:<date
    if (field === 'created' || field === 'updated') {
      if (!value || (value[0] !== '>' && value[0] !== '<')) {
        throw new QueryParseError(
          `${field}: requires > or < followed by a date (e.g., ${field}:>2026-01-01)`,
          pos
        );
      }
      const op = value[0] as '>' | '<';
      const dateStr = value.substring(1);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        throw new QueryParseError(
          `${field}: date must be in YYYY-MM-DD format (got "${dateStr}")`,
          pos
        );
      }
      return { type: 'date', field, op, value: dateStr };
    }

    // Unknown field — treat the whole thing as text
    return { type: 'text', value: word };
  }

  const ast = parseOr();

  // Ensure we consumed everything
  if (peek().type !== 'EOF') {
    const tok = peek();
    throw new QueryParseError(
      `Unexpected token ${tok.type} ("${tok.value}") — did you forget AND/OR between terms?`,
      tok.pos
    );
  }

  return ast;
}

/**
 * Check if a query string uses the structured query language.
 * Returns true if the query contains operators or field syntax.
 * This is used to decide whether to use the new parser or fall back to simple text search.
 *
 * Note: Parentheses alone do NOT trigger structured mode — they only make sense
 * with operators or field syntax, which are already detected. This avoids false
 * positives on queries like "function()" which should use regex search.
 */
export function isStructuredQuery(input: string): boolean {
  // Check for boolean operators (whole words)
  if (/\bAND\b/.test(input)) return true;
  if (/\bOR\b/.test(input)) return true;
  if (/\bNOT\b/.test(input)) return true;

  // Check for field syntax
  if (/\b(status|goal|code|in|has|created|updated):/.test(input)) return true;

  return false;
}
