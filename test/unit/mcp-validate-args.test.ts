/**
 * Unit tests for MCP tool-argument validation (src/mcp/validate-args.ts).
 *
 * INVARIANT — every surface that dispatches an MCP tool validates arguments
 * against the declared inputSchema BEFORE dispatch. These tests pin the
 * validator itself; the e2e counterpart (test/e2e/mcp-arg-validation.test.ts)
 * proves the daemon route uses it and writes nothing on a violation.
 *
 * Regression: POST /mcp/:taskId/:toolName did `body.arguments ?? {}` and
 * dispatched. A body missing the `{"arguments": {...}}` envelope — what an agent
 * hand-rolling the documented HTTP fallback sends — made `args.message`
 * undefined, and lazy_commit ran `git commit -m undefined`, producing a real
 * commit whose message was the literal string "undefined".
 */

import { describe, test, expect } from 'bun:test';
import {
  validateToolArgs,
  parseToolCallEnvelope,
  assertSchemaSubsetSupported,
  isPlainObject,
} from '../../src/mcp/validate-args';
import { findToolDefinition, allDispatchableTools, parseAndValidateToolCallBody } from '../../src/mcp/tool-registry';
import type { McpToolInputSchema } from '../../src/mcp/types';

const SCHEMA: McpToolInputSchema = {
  type: 'object',
  properties: {
    message: { type: 'string', minLength: 1 },
    label: { type: 'string', maxLength: 5 },
    kind: { type: 'string', enum: ['a', 'b'] },
    code: { type: 'string', pattern: '^[a-z]+$' },
    count: { type: 'number' },
    flag: { type: 'boolean' },
    files: { type: 'array', items: { type: 'string' } },
    modes: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } },
    either: { type: ['string', 'array'] },
  },
  required: ['message'],
};

describe('validateToolArgs', () => {
  test('accepts arguments that satisfy the schema', () => {
    expect(validateToolArgs(SCHEMA, { message: 'hi' })).toBeNull();
    expect(validateToolArgs(SCHEMA, {
      message: 'hi', label: 'abc', kind: 'b', code: 'abc', count: 3, flag: false,
      files: ['a.ts'], modes: ['x'], either: ['a', 'b'],
    })).toBeNull();
  });

  // INVARIANT: a required parameter that is absent, null, or undefined is a
  // REJECTION. This is the exact hole the "undefined" commit fell through — the
  // value arrived undefined and reached `git commit -m`.
  test('rejects a missing, null or undefined required parameter', () => {
    for (const args of [{}, { message: null }, { message: undefined }]) {
      const err = validateToolArgs(SCHEMA, args as Record<string, unknown>);
      expect(err).toContain("Missing required parameter 'message'");
    }
  });

  test('names the offending field and the expected type on a type mismatch', () => {
    expect(validateToolArgs(SCHEMA, { message: 42 })).toBe("'message' must be string, got number");
    expect(validateToolArgs(SCHEMA, { message: 'hi', count: '3' })).toBe("'count' must be number, got string");
    expect(validateToolArgs(SCHEMA, { message: 'hi', flag: 'yes' })).toBe("'flag' must be boolean, got string");
    expect(validateToolArgs(SCHEMA, { message: 'hi', files: 'a.ts' })).toBe("'files' must be array, got string");
  });

  test('enforces minLength, so an empty required string is not "provided"', () => {
    expect(validateToolArgs(SCHEMA, { message: '' })).toBe("'message' must not be empty");
  });

  test('enforces maxLength, enum and pattern', () => {
    expect(validateToolArgs(SCHEMA, { message: 'hi', label: 'toolong' })).toContain('at most 5 characters');
    expect(validateToolArgs(SCHEMA, { message: 'hi', kind: 'c' })).toContain('must be one of: a, b');
    expect(validateToolArgs(SCHEMA, { message: 'hi', code: 'AB1' })).toContain('must match ^[a-z]+$');
  });

  test('validates array element types and element enums', () => {
    expect(validateToolArgs(SCHEMA, { message: 'hi', files: ['a', 2] })).toBe("'files[1]' must be string, got number");
    expect(validateToolArgs(SCHEMA, { message: 'hi', modes: ['x', 'z'] })).toContain("'modes[1]' must be one of: x, y");
  });

  test('accepts any branch of a union type', () => {
    expect(validateToolArgs(SCHEMA, { message: 'hi', either: 'one' })).toBeNull();
    expect(validateToolArgs(SCHEMA, { message: 'hi', either: ['one', 'two'] })).toBeNull();
    expect(validateToolArgs(SCHEMA, { message: 'hi', either: 7 })).toBe("'either' must be string or array, got number");
  });

  // Clients routinely serialize "not set" as null. Rejecting that for an
  // OPTIONAL parameter would break callers that are not actually wrong.
  test('treats null/undefined for an optional parameter as absent', () => {
    expect(validateToolArgs(SCHEMA, { message: 'hi', label: null, count: undefined })).toBeNull();
  });

  test('rejects unknown parameters and suggests the closest known one', () => {
    const err = validateToolArgs(SCHEMA, { message: 'hi', mesage: 'x' });
    expect(err).toContain('Unknown parameter(s)');
    expect(err).toContain('did you mean: message');
  });
});

describe('parseToolCallEnvelope', () => {
  test('unwraps a well-formed envelope', () => {
    const parsed = parseToolCallEnvelope('lazy_commit', { arguments: { message: 'hi' } }, SCHEMA);
    expect(parsed).toEqual({ ok: true, args: { message: 'hi' } });
  });

  // A no-argument tool legitimately serializes to `{}` (JSON.stringify drops an
  // undefined `arguments`), so this must stay accepted — schema validation then
  // decides whether the tool actually needed anything.
  test('accepts an empty body as "no arguments"', () => {
    expect(parseToolCallEnvelope('lazy_status', {}, { type: 'object' })).toEqual({ ok: true, args: {} });
    expect(parseToolCallEnvelope('lazy_status', { arguments: null }, { type: 'object' })).toEqual({ ok: true, args: {} });
  });

  // INVARIANT: THE regression. Top-level tool-arg-looking keys with no
  // `arguments` key get a hint that names the envelope, because "missing
  // required parameter 'message'" would send the caller looking in the wrong
  // place while their `message` sits right there in the body.
  test('rejects a body missing the arguments envelope, naming the mistake', () => {
    const parsed = parseToolCallEnvelope('lazy_commit', { message: 'oops' }, SCHEMA);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toContain('Did you forget the arguments envelope?');
    expect(parsed.error).toContain("'message'");
    expect(parsed.error).toContain('"arguments"');
  });

  test('rejects a body with stray keys even when none look like tool arguments', () => {
    const parsed = parseToolCallEnvelope('lazy_commit', { params: { message: 'x' } }, SCHEMA);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toContain('arguments envelope');
  });

  test('rejects a body that is not a JSON object', () => {
    for (const body of [[1, 2], 'hello', 42, null]) {
      const parsed = parseToolCallEnvelope('lazy_commit', body, SCHEMA);
      expect(parsed.ok).toBe(false);
    }
  });

  test('rejects an arguments value that is not an object', () => {
    const parsed = parseToolCallEnvelope('lazy_commit', { arguments: 'message=hi' }, SCHEMA);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toContain('"arguments" must be a JSON object');
  });
});

describe('parseAndValidateToolCallBody', () => {
  // The end-to-end shape the daemon route uses: envelope first, schema second.
  test('rejects the real "undefined commit" body against the real lazy_commit schema', () => {
    const parsed = parseAndValidateToolCallBody('lazy_commit', { message: 'a real message' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toContain('arguments envelope');
  });

  test('rejects a well-enveloped call that omits a required parameter', () => {
    const parsed = parseAndValidateToolCallBody('lazy_commit', { arguments: {} });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toContain("Missing required parameter 'message'");
    expect(parsed.error).toContain('Expected: {"arguments"');
  });

  test('accepts a valid call', () => {
    expect(parseAndValidateToolCallBody('lazy_commit', { arguments: { message: 'real' } }))
      .toEqual({ ok: true, args: { message: 'real' } });
  });

  // An unknown tool name still gets its envelope checked; the dispatcher owns
  // the 404 for the name itself.
  test('passes an unknown tool through with the envelope still enforced', () => {
    expect(parseAndValidateToolCallBody('lazy_not_a_tool', { arguments: { x: 1 } }))
      .toEqual({ ok: true, args: { x: 1 } });
    expect(parseAndValidateToolCallBody('lazy_not_a_tool', { x: 1 }).ok).toBe(false);
  });
});

describe('declared schemas stay inside the validated subset', () => {
  // INVARIANT: a schema keyword this validator does not implement is a keyword
  // nothing enforces — a declared constraint that is documentation only. That
  // is precisely the failure this whole change exists to end, so it fails HERE
  // rather than in production. If you add a keyword to a tool schema, implement
  // it in validate-args.ts (and extend SUPPORTED_PROPERTY_KEYWORDS).
  test('every dispatchable tool schema uses only supported keywords', () => {
    const problems = allDispatchableTools().flatMap(assertSchemaSubsetSupported);
    expect(problems).toEqual([]);
  });

  // INVARIANT: lazy_internal_git is VALIDATED but never ADVERTISED. It is
  // reachable over the daemon's HTTP route, so it must be schema-checked; it
  // must never appear in a tool list handed to an agent.
  test('lazy_internal_git is validatable but absent from the advertised tool list', async () => {
    expect(findToolDefinition('lazy_internal_git')).toBeDefined();
    const { allTools } = await import('../../src/mcp/tools');
    expect(allTools.some(t => t.name === 'lazy_internal_git')).toBe(false);
  });
});

describe('isPlainObject', () => {
  test('distinguishes objects from arrays and null', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
  });
});
