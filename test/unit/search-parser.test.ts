import { describe, test, expect } from 'bun:test';
import { parseQuery, isStructuredQuery, QueryParseError } from '../../src/search/parser';
import type { QueryNode } from '../../src/search/parser';

describe('isStructuredQuery', () => {
  test('returns false for plain text', () => {
    expect(isStructuredQuery('hello')).toBe(false);
    expect(isStructuredQuery('hello world')).toBe(false);
    expect(isStructuredQuery('"quoted text"')).toBe(false);
  });

  test('detects AND operator', () => {
    expect(isStructuredQuery('foo AND bar')).toBe(true);
  });

  test('detects OR operator', () => {
    expect(isStructuredQuery('foo OR bar')).toBe(true);
  });

  test('detects NOT operator', () => {
    expect(isStructuredQuery('NOT foo')).toBe(true);
  });

  test('detects field syntax', () => {
    expect(isStructuredQuery('status:working')).toBe(true);
    expect(isStructuredQuery('goal:auth')).toBe(true);
    expect(isStructuredQuery('code:fix-bug')).toBe(true);
    expect(isStructuredQuery('in:turns error')).toBe(true);
    expect(isStructuredQuery('has:commits')).toBe(true);
    expect(isStructuredQuery('created:>2026-01-01')).toBe(true);
    expect(isStructuredQuery('updated:<2026-02-01')).toBe(true);
  });

  test('detects parentheses with operators', () => {
    expect(isStructuredQuery('(foo OR bar)')).toBe(true);
  });

  test('does not falsely trigger on parentheses in plain text', () => {
    expect(isStructuredQuery('function()')).toBe(false);
    expect(isStructuredQuery('foo(bar)')).toBe(false);
    expect(isStructuredQuery('(test)')).toBe(false);
  });

  test('does not falsely detect AND/OR/NOT as substrings', () => {
    expect(isStructuredQuery('android')).toBe(false);
    expect(isStructuredQuery('notification')).toBe(false);
    expect(isStructuredQuery('orchestra')).toBe(false);
  });
});

describe('parseQuery', () => {
  test('parses bare word as text node', () => {
    const ast = parseQuery('hello');
    expect(ast).toEqual({ type: 'text', value: 'hello' });
  });

  test('parses quoted string as text node', () => {
    const ast = parseQuery('"hello world"');
    expect(ast).toEqual({ type: 'text', value: 'hello world' });
  });

  test('parses AND expression', () => {
    const ast = parseQuery('foo AND bar');
    expect(ast.type).toBe('and');
    if (ast.type === 'and') {
      expect(ast.left).toEqual({ type: 'text', value: 'foo' });
      expect(ast.right).toEqual({ type: 'text', value: 'bar' });
    }
  });

  test('parses OR expression', () => {
    const ast = parseQuery('foo OR bar');
    expect(ast.type).toBe('or');
    if (ast.type === 'or') {
      expect(ast.left).toEqual({ type: 'text', value: 'foo' });
      expect(ast.right).toEqual({ type: 'text', value: 'bar' });
    }
  });

  test('parses NOT expression', () => {
    const ast = parseQuery('NOT foo');
    expect(ast.type).toBe('not');
    if (ast.type === 'not') {
      expect(ast.operand).toEqual({ type: 'text', value: 'foo' });
    }
  });

  test('parses parenthesized expression', () => {
    const ast = parseQuery('(foo OR bar) AND baz');
    expect(ast.type).toBe('and');
    if (ast.type === 'and') {
      expect(ast.left.type).toBe('or');
      expect(ast.right).toEqual({ type: 'text', value: 'baz' });
    }
  });

  test('parses status:value field', () => {
    const ast = parseQuery('status:working');
    expect(ast).toEqual({ type: 'field', field: 'status', value: 'working' });
  });

  test('parses goal:value field', () => {
    const ast = parseQuery('goal:authentication');
    expect(ast).toEqual({ type: 'field', field: 'goal', value: 'authentication' });
  });

  test('parses goal:"multi word" field', () => {
    const ast = parseQuery('goal:"error handling"');
    expect(ast).toEqual({ type: 'field', field: 'goal', value: 'error handling' });
  });

  test('parses code:value field', () => {
    const ast = parseQuery('code:fix-reconciler');
    expect(ast).toEqual({ type: 'field', field: 'code', value: 'fix-reconciler' });
  });

  test('parses in:turns with text', () => {
    const ast = parseQuery('in:turns reconciler');
    expect(ast).toEqual({ type: 'in', scope: 'turns', value: 'reconciler' });
  });

  test('parses in:commits with quoted text', () => {
    const ast = parseQuery('in:commits "fix bug"');
    expect(ast).toEqual({ type: 'in', scope: 'commits', value: 'fix bug' });
  });

  test('parses in:comments with text', () => {
    const ast = parseQuery('in:comments review');
    expect(ast).toEqual({ type: 'in', scope: 'comments', value: 'review' });
  });

  test('parses has:commits', () => {
    const ast = parseQuery('has:commits');
    expect(ast).toEqual({ type: 'has', scope: 'commits' });
  });

  test('parses has:turns', () => {
    const ast = parseQuery('has:turns');
    expect(ast).toEqual({ type: 'has', scope: 'turns' });
  });

  test('parses has:comments', () => {
    const ast = parseQuery('has:comments');
    expect(ast).toEqual({ type: 'has', scope: 'comments' });
  });

  test('parses created:>date', () => {
    const ast = parseQuery('created:>2026-02-15');
    expect(ast).toEqual({ type: 'date', field: 'created', op: '>', value: '2026-02-15' });
  });

  test('parses created:<date', () => {
    const ast = parseQuery('created:<2026-01-01');
    expect(ast).toEqual({ type: 'date', field: 'created', op: '<', value: '2026-01-01' });
  });

  test('parses updated:>date', () => {
    const ast = parseQuery('updated:>2026-02-15');
    expect(ast).toEqual({ type: 'date', field: 'updated', op: '>', value: '2026-02-15' });
  });

  test('parses complex expression', () => {
    const ast = parseQuery('status:blocked AND in:turns "reconciler"');
    expect(ast.type).toBe('and');
    if (ast.type === 'and') {
      expect(ast.left).toEqual({ type: 'field', field: 'status', value: 'blocked' });
      expect(ast.right).toEqual({ type: 'in', scope: 'turns', value: 'reconciler' });
    }
  });

  test('parses chained OR', () => {
    const ast = parseQuery('status:rejected OR status:closed');
    expect(ast.type).toBe('or');
    if (ast.type === 'or') {
      expect(ast.left).toEqual({ type: 'field', field: 'status', value: 'rejected' });
      // status:closed is not a valid status — but the parser doesn't validate status values
      expect(ast.right).toEqual({ type: 'field', field: 'status', value: 'closed' });
    }
  });

  test('parses NOT with AND', () => {
    const ast = parseQuery('has:commits AND NOT in:commits "wip"');
    expect(ast.type).toBe('and');
    if (ast.type === 'and') {
      expect(ast.left).toEqual({ type: 'has', scope: 'commits' });
      expect(ast.right.type).toBe('not');
      if (ast.right.type === 'not') {
        expect(ast.right.operand).toEqual({ type: 'in', scope: 'commits', value: 'wip' });
      }
    }
  });

  test('parses nested parentheses with AND/OR', () => {
    const ast = parseQuery('created:>2026-02-15 AND (status:blocked OR status:working)');
    expect(ast.type).toBe('and');
    if (ast.type === 'and') {
      expect(ast.left).toEqual({ type: 'date', field: 'created', op: '>', value: '2026-02-15' });
      expect(ast.right.type).toBe('or');
    }
  });

  test('left-associates chained AND', () => {
    const ast = parseQuery('a AND b AND c');
    // Should be ((a AND b) AND c)
    expect(ast.type).toBe('and');
    if (ast.type === 'and') {
      expect(ast.left.type).toBe('and');
      expect(ast.right).toEqual({ type: 'text', value: 'c' });
    }
  });

  test('AND has higher precedence than OR: a OR b AND c', () => {
    const ast = parseQuery('a OR b AND c');
    // Should parse as: a OR (b AND c)
    expect(ast.type).toBe('or');
    if (ast.type === 'or') {
      expect(ast.left).toEqual({ type: 'text', value: 'a' });
      expect(ast.right.type).toBe('and');
      if (ast.right.type === 'and') {
        expect(ast.right.left).toEqual({ type: 'text', value: 'b' });
        expect(ast.right.right).toEqual({ type: 'text', value: 'c' });
      }
    }
  });

  test('AND has higher precedence than OR: a AND b OR c', () => {
    const ast = parseQuery('a AND b OR c');
    // Should parse as: (a AND b) OR c
    expect(ast.type).toBe('or');
    if (ast.type === 'or') {
      expect(ast.left.type).toBe('and');
      if (ast.left.type === 'and') {
        expect(ast.left.left).toEqual({ type: 'text', value: 'a' });
        expect(ast.left.right).toEqual({ type: 'text', value: 'b' });
      }
      expect(ast.right).toEqual({ type: 'text', value: 'c' });
    }
  });

  test('AND has higher precedence than OR: a AND b OR c AND d', () => {
    const ast = parseQuery('a AND b OR c AND d');
    // Should parse as: (a AND b) OR (c AND d)
    expect(ast.type).toBe('or');
    if (ast.type === 'or') {
      expect(ast.left.type).toBe('and');
      expect(ast.right.type).toBe('and');
      if (ast.left.type === 'and') {
        expect(ast.left.left).toEqual({ type: 'text', value: 'a' });
        expect(ast.left.right).toEqual({ type: 'text', value: 'b' });
      }
      if (ast.right.type === 'and') {
        expect(ast.right.left).toEqual({ type: 'text', value: 'c' });
        expect(ast.right.right).toEqual({ type: 'text', value: 'd' });
      }
    }
  });

  test('treats unknown field as text', () => {
    const ast = parseQuery('foo:bar');
    expect(ast).toEqual({ type: 'text', value: 'foo:bar' });
  });

  // Error cases
  test('throws on invalid in: scope', () => {
    expect(() => parseQuery('in:invalid foo')).toThrow(QueryParseError);
  });

  test('throws on invalid has: scope', () => {
    expect(() => parseQuery('has:invalid')).toThrow(QueryParseError);
  });

  test('throws on date without operator', () => {
    expect(() => parseQuery('created:2026-01-01')).toThrow(QueryParseError);
  });

  test('throws on invalid date format', () => {
    expect(() => parseQuery('created:>2026-1-1')).toThrow(QueryParseError);
  });

  test('throws on missing closing paren', () => {
    expect(() => parseQuery('(foo AND bar')).toThrow(QueryParseError);
  });

  test('throws on unexpected token after expression', () => {
    // Two terms without a boolean operator between them
    expect(() => parseQuery('foo bar')).toThrow(QueryParseError);
  });

  test('throws on empty status', () => {
    expect(() => parseQuery('status:')).toThrow(QueryParseError);
  });
});
