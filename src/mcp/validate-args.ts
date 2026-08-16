/**
 * Argument validation for MCP tool calls.
 *
 * INVARIANT — every surface that dispatches an MCP tool validates its arguments
 * against that tool's declared `inputSchema` FIRST. There are three such
 * surfaces (the stdio server in src/mcp/server.ts, the daemon's
 * POST /mcp/:taskId/:toolName route, and the builder's POST /tool/:name route),
 * and none of them may rely on "the normal client always sends it right".
 *
 * WHY: the daemon route used to do `body.arguments ?? {}` and dispatch. An agent
 * hand-rolling the documented HTTP fallback posted `{"message": "..."}` without
 * the `{"arguments": {...}}` envelope, so `args.message` arrived `undefined`,
 * and lazy_commit ran `git commit -m undefined` — producing a real commit whose
 * message was the literal string "undefined". A declared schema that nothing
 * enforces is documentation, not validation.
 *
 * Deliberately dependency-free: the schemas we declare use a small, closed
 * subset of JSON Schema (type/enum/minLength/maxLength/pattern/items/required),
 * so a full JSON Schema library would be a large dependency to check four
 * keywords. `assertSchemaSubsetSupported` keeps that claim honest — a schema
 * that grows a keyword this validator does not implement fails loudly in tests
 * rather than silently going unchecked.
 */

import { levenshteinDistance } from '../utils/levenshtein';
import type { McpTool, McpToolInputSchema, McpToolPropertySchema } from './types';

/** JSON Schema keywords this validator understands. */
const SUPPORTED_PROPERTY_KEYWORDS = new Set([
  'type', 'description', 'enum', 'minLength', 'maxLength', 'pattern', 'items',
]);

/** The JSON type name of a value, using JSON Schema's vocabulary. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Does `value` satisfy a single JSON Schema type name? */
function matchesType(value: unknown, type: string): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return jsonTypeOf(value) === type;
}

/** Human-readable rendering of a schema's `type` (which may be a union). */
function describeType(type: string | string[]): string {
  return Array.isArray(type) ? type.join(' or ') : type;
}

/** Is `value` a plain JSON object (not null, not an array)? */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Suggest the closest known parameter name for a misspelled one.
 * Returns null when nothing is close enough to be worth guessing.
 */
function closestKey(input: string, candidates: string[]): string | null {
  let best = '';
  let bestDist = Infinity;
  for (const c of candidates) {
    const dist = levenshteinDistance(input.toLowerCase(), c.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  if (!best) return null;
  // Same 60%-of-the-longer-string threshold the stdio server has always used.
  return bestDist <= Math.max(input.length, best.length) * 0.6 ? best : null;
}

/** Validate one property value against its schema. Returns null when valid. */
function validateProperty(
  key: string,
  value: unknown,
  schema: McpToolPropertySchema,
): string | null {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some(t => matchesType(value, t))) {
    return `'${key}' must be ${describeType(schema.type)}, got ${jsonTypeOf(value)}`;
  }

  if (typeof value === 'string') {
    if (schema.enum && !schema.enum.includes(value)) {
      return `'${key}' must be one of: ${schema.enum.join(', ')} (got '${value}')`;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return schema.minLength === 1
        ? `'${key}' must not be empty`
        : `'${key}' must be at least ${schema.minLength} characters (got ${value.length})`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `'${key}' must be at most ${schema.maxLength} characters (got ${value.length})`;
    }
    if (schema.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        // A malformed pattern is OUR bug, not the caller's — do not fail their
        // call for it. assertSchemaSubsetSupported catches these in tests.
        return null;
      }
      if (!re.test(value)) {
        return `'${key}' must match ${schema.pattern} (got '${value}')`;
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (!matchesType(item, schema.items.type)) {
        return `'${key}[${i}]' must be ${schema.items.type}, got ${jsonTypeOf(item)}`;
      }
      if (schema.items.enum && typeof item === 'string' && !schema.items.enum.includes(item)) {
        return `'${key}[${i}]' must be one of: ${schema.items.enum.join(', ')} (got '${item}')`;
      }
    }
  }

  return null;
}

/**
 * Validate tool arguments against a declared input schema.
 *
 * @returns null when the arguments are acceptable, or a message naming the
 *   offending field and what was expected.
 *
 * A `null` or `undefined` value for an OPTIONAL key is treated as absent —
 * clients routinely serialize "not set" that way, and rejecting it would break
 * callers that are not actually wrong. A required key must be present AND
 * non-null: that is the exact hole the "undefined" commit fell through.
 */
export function validateToolArgs(
  schema: McpToolInputSchema,
  args: Record<string, unknown>,
): string | null {
  const properties = schema.properties ?? {};
  const knownKeys = Object.keys(properties);

  const unknownKeys = Object.keys(args).filter(k => !knownKeys.includes(k));
  if (unknownKeys.length > 0) {
    const rendered = unknownKeys.map(k => {
      const closest = closestKey(k, knownKeys);
      return closest ? `${k} (did you mean: ${closest}?)` : k;
    });
    return `Unknown parameter(s): ${rendered.join(', ')}. Valid parameters: ${knownKeys.join(', ') || '(none)'}`;
  }

  for (const key of schema.required ?? []) {
    const value = args[key];
    if (value === undefined || value === null) {
      const propSchema = properties[key];
      const expected = propSchema ? ` (${describeType(propSchema.type)})` : '';
      return `Missing required parameter '${key}'${expected}`;
    }
  }

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue; // optional-and-unset
    const propSchema = properties[key];
    if (!propSchema) continue; // already reported above
    const err = validateProperty(key, value, propSchema);
    if (err) return err;
  }

  return null;
}

/**
 * The `{"arguments": {...}}` shape every tool-call body must use, rendered for
 * an error message so the caller sees the fix rather than just the complaint.
 */
function envelopeExample(toolName: string, keys: string[]): string {
  const sample = keys.length > 0
    ? keys.slice(0, 2).map(k => `"${k}": ...`).join(', ')
    : '';
  return `{"arguments": {${sample}}}  (tool: ${toolName})`;
}

/** Outcome of parsing a tool-call request body. */
export type EnvelopeParse =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Pull tool arguments out of an HTTP request body, enforcing the envelope.
 *
 * Rejects, rather than silently treating as empty:
 * - a body that is not a JSON object;
 * - an `arguments` value that is not a JSON object;
 * - a body with NO `arguments` key but other keys present — the exact mistake an
 *   agent makes when hand-rolling the HTTP fallback. The hint names it, because
 *   "missing required parameter 'message'" would send them looking in the wrong
 *   place while their `message` sits right there in the body.
 *
 * An empty object `{}` is accepted as "no arguments" — that is what a call to a
 * no-argument tool legitimately serializes to. Schema validation then decides
 * whether the tool actually needed something.
 */
export function parseToolCallEnvelope(
  toolName: string,
  body: unknown,
  schema?: McpToolInputSchema,
): EnvelopeParse {
  const knownKeys = Object.keys(schema?.properties ?? {});

  if (!isPlainObject(body)) {
    return {
      ok: false,
      error:
        `Request body must be a JSON object of the form ${envelopeExample(toolName, knownKeys)}, ` +
        `got ${jsonTypeOf(body)}.`,
    };
  }

  if (!('arguments' in body)) {
    const strayKeys = Object.keys(body);
    if (strayKeys.length === 0) return { ok: true, args: {} };

    const looksLikeArgs = strayKeys.filter(k => knownKeys.includes(k));
    const hint = looksLikeArgs.length > 0
      ? `Did you forget the arguments envelope? ${looksLikeArgs.map(k => `'${k}'`).join(', ')} ` +
        `${looksLikeArgs.length === 1 ? 'is a parameter' : 'are parameters'} of ${toolName}, ` +
        `and must be nested under "arguments".`
      : `Did you forget the arguments envelope? Tool parameters are nested under "arguments".`;
    return {
      ok: false,
      error:
        `Request body has no "arguments" key (top-level keys: ${strayKeys.join(', ')}). ${hint} ` +
        `Expected: ${envelopeExample(toolName, knownKeys)}`,
    };
  }

  const args = body.arguments;
  if (args === undefined || args === null) return { ok: true, args: {} };
  if (!isPlainObject(args)) {
    return {
      ok: false,
      error:
        `"arguments" must be a JSON object mapping parameter names to values, got ${jsonTypeOf(args)}. ` +
        `Expected: ${envelopeExample(toolName, knownKeys)}`,
    };
  }

  return { ok: true, args };
}

/**
 * Render a schema-validation failure with the envelope shape appended, so one
 * message carries both what was wrong and what a correct call looks like.
 */
export function describeArgsFailure(
  toolName: string,
  schema: McpToolInputSchema,
  failure: string,
): string {
  return `Invalid arguments for ${toolName}: ${failure}. ` +
    `Expected: ${envelopeExample(toolName, Object.keys(schema.properties ?? {}))}`;
}

/**
 * Assert that a schema only uses keywords this validator implements.
 *
 * Returns the list of problems (empty when the schema is fully covered). Used
 * by test/unit/mcp-validate-args.test.ts against every declared tool, so a
 * schema that grows an unsupported keyword — `minimum`, `oneOf`, a nested
 * object schema — fails a test instead of silently going unenforced.
 */
export function assertSchemaSubsetSupported(tool: McpTool): string[] {
  const problems: string[] = [];
  const schema = tool.inputSchema;

  if (schema.type !== 'object') {
    problems.push(`${tool.name}: top-level schema type must be 'object', got '${schema.type}'`);
  }

  const properties = schema.properties ?? {};
  for (const name of schema.required ?? []) {
    if (!(name in properties)) {
      problems.push(`${tool.name}: required parameter '${name}' has no schema in properties`);
    }
  }

  for (const [key, prop] of Object.entries(properties)) {
    for (const keyword of Object.keys(prop)) {
      if (!SUPPORTED_PROPERTY_KEYWORDS.has(keyword)) {
        problems.push(`${tool.name}.${key}: unsupported JSON Schema keyword '${keyword}' — validate-args.ts does not enforce it`);
      }
    }
    if (prop.pattern) {
      try {
        new RegExp(prop.pattern);
      } catch (err) {
        problems.push(`${tool.name}.${key}: invalid pattern '${prop.pattern}': ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  return problems;
}
