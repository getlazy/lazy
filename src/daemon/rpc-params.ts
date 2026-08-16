/**
 * Typed parameter accessors for daemon RPC handlers.
 *
 * INVARIANT — every external surface parses its inputs and confirms them. No
 * surface may rely on NOT being the surface a hand-rolled caller reaches.
 *
 * `POST /rpc/:command` is such a surface. Handlers used to read their inputs
 * with blind casts (`params.taskId as string`, `params.approvedFiles as
 * string[]`), which assert a type to the compiler while checking nothing at
 * runtime. The presence checks that follow (`if (!taskId) throw ...`) catch an
 * ABSENT value but wave a wrong-TYPED one straight through: `{"reason": {}}`
 * became an object stored where a string belongs, and `{"taskId": 42}` reached
 * `.substring()` and surfaced as a 500 — a caller's mistake reported as a
 * daemon crash.
 *
 * That is the same defect class as the MCP route's missing envelope, which let
 * `undefined` reach `git commit -m` and produced a real commit whose message
 * was the literal string "undefined" (see src/mcp/validate-args.ts).
 *
 * These accessors are the /rpc counterpart of that validator: they reject at
 * the boundary with a 400 that NAMES the field and what was wrong with it. Use
 * them instead of a cast whenever a handler reads a parameter.
 */

import { RpcError } from './rpc-error';

/** Human-readable type name for an error message ('array' and 'null' are distinct). */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** True when the parameter was not supplied at all (absent, null, or undefined). */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * A required string parameter.
 *
 * Absent, empty, or blank is `'<name> is required'` — the wording predates this
 * module and several tests pin it, so it is deliberately unchanged. A present
 * but wrong-typed value names the type it actually got.
 */
export function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (isAbsent(value) || value === '') {
    throw new RpcError(400, `${name} is required`);
  }
  if (typeof value !== 'string') {
    throw new RpcError(400, `${name} must be a string, got ${typeName(value)}`);
  }
  return value;
}

/** A required string that must also contain a non-whitespace character. */
export function requireNonBlankString(params: Record<string, unknown>, name: string): string {
  const value = requireString(params, name);
  if (!value.trim()) {
    throw new RpcError(400, `${name} is required`);
  }
  return value;
}

/** An optional string. Absent and null both mean "not supplied". */
export function optionalString(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  if (isAbsent(value)) return undefined;
  if (typeof value !== 'string') {
    throw new RpcError(400, `${name} must be a string, got ${typeName(value)}`);
  }
  return value;
}

/** An optional boolean. A truthy STRING is not a boolean — say so rather than guess. */
export function optionalBoolean(params: Record<string, unknown>, name: string): boolean | undefined {
  const value = params[name];
  if (isAbsent(value)) return undefined;
  if (typeof value !== 'boolean') {
    throw new RpcError(400, `${name} must be a boolean, got ${typeName(value)}`);
  }
  return value;
}

/**
 * A required boolean.
 *
 * Separate from {@link optionalBoolean} because a ⛔/✅ decision has no safe
 * default: treating an absent `approved` as false would silently record a
 * refusal the reviewer never made.
 */
export function requireBoolean(params: Record<string, unknown>, name: string): boolean {
  const value = params[name];
  if (isAbsent(value)) {
    throw new RpcError(400, `${name} is required`);
  }
  if (typeof value !== 'boolean') {
    throw new RpcError(400, `${name} must be a boolean, got ${typeName(value)}`);
  }
  return value;
}

/** An optional finite number. */
export function optionalNumber(params: Record<string, unknown>, name: string): number | undefined {
  const value = params[name];
  if (isAbsent(value)) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RpcError(400, `${name} must be a number, got ${typeName(value)}`);
  }
  return value;
}

/**
 * A required finite number.
 *
 * Separate from {@link optionalNumber} because a review comment's `line` is
 * meaningless without it: an absent line would anchor the comment nowhere and
 * the reviewer's words would render detached from the code they are about.
 */
export function requireNumber(params: Record<string, unknown>, name: string): number {
  const value = params[name];
  if (isAbsent(value)) {
    throw new RpcError(400, `${name} is required`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RpcError(400, `${name} must be a number, got ${typeName(value)}`);
  }
  return value;
}

/**
 * An optional array of strings.
 *
 * Worth its own accessor because `approvedFiles` feeds file-permission
 * decisions on accept: a non-string element there would compare unequal to
 * every real path and silently fail to approve the file the caller meant.
 */
export function optionalStringArray(params: Record<string, unknown>, name: string): string[] | undefined {
  const value = params[name];
  if (isAbsent(value)) return undefined;
  if (!Array.isArray(value)) {
    throw new RpcError(400, `${name} must be an array of strings, got ${typeName(value)}`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      throw new RpcError(400, `${name}[${i}] must be a string, got ${typeName(value[i])}`);
    }
  }
  return value as string[];
}

/** An optional string constrained to a known set of values. */
export function optionalEnum<T extends string>(
  params: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(params, name);
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new RpcError(400, `Invalid ${name}: '${value}'. Expected one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/** A required string constrained to a known set of values. */
export function requireEnum<T extends string>(
  params: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T {
  const value = requireString(params, name);
  if (!allowed.includes(value as T)) {
    throw new RpcError(400, `Invalid ${name}: '${value}'. Expected one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}
