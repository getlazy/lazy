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
import { parseReviewDraftPatch, ReviewDraftPatchError } from '../review-draft';
import { ACTIVE_RAISED_ACTIONS } from '../types';
import {
  REVIEW_GATE_INPUTS,
  REVIEW_MODE_INPUTS,
  REVIEW_TOGGLE_INPUTS,
  parseReviewGate,
  parseReviewMode,
  parseReviewToggle,
  type ReviewSettingsOverrides,
} from '../review/mode';
import type { ActiveRaisedResolveAction, Actor, ActorInput, ReviewDraftPatch } from '../types';

/**
 * The Actor union, as a runtime value.
 *
 * `params.actor as Actor` asserts to the compiler and checks nothing: an
 * unrecognized string used to flow into a turn record and be attributed to an
 * actor that does not exist. Adding a member to `Actor` without adding it here
 * makes every caller using it a 400, which is loud rather than silent.
 */
const ACTORS = ['human', 'builder', 'agent', 'system', 'supervisor'] as const satisfies readonly Actor[];

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
 * An optional review-settings override object, every field validated.
 *
 * Its own accessor rather than three `optionalString` casts because these
 * decide whether a reviewer container is ever launched for this task and
 * whether its verdict can refuse a merge: an unrecognised value resolving to a
 * default is a caller believing they asked for one thing while getting
 * another, silently, for the task's whole life.
 */
export function optionalReviewOverrides(
  params: Record<string, unknown>,
  name: string,
): ReviewSettingsOverrides | undefined {
  const value = params[name];
  if (isAbsent(value)) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError(400, `${name} must be an object, got ${typeName(value)}`);
  }
  const raw = value as Record<string, unknown>;
  const out: ReviewSettingsOverrides = {};

  if (!isAbsent(raw.mode)) {
    const mode = parseReviewMode(raw.mode);
    if (!mode) {
      throw new RpcError(
        400,
        `${name}.mode must be one of: ${REVIEW_MODE_INPUTS.join(', ')} — got ${JSON.stringify(raw.mode)}`,
      );
    }
    out.mode = mode;
  }
  if (!isAbsent(raw.gate)) {
    const gate = parseReviewGate(raw.gate);
    if (!gate) {
      throw new RpcError(
        400,
        `${name}.gate must be one of: ${REVIEW_GATE_INPUTS.join(', ')} — got ${JSON.stringify(raw.gate)}`,
      );
    }
    out.gate = gate;
  }
  if (!isAbsent(raw.auto_fix)) {
    const autoFix = parseReviewToggle(raw.auto_fix);
    if (autoFix === null) {
      throw new RpcError(
        400,
        `${name}.auto_fix must be one of: ${REVIEW_TOGGLE_INPUTS.join(', ')} — got ${JSON.stringify(raw.auto_fix)}`,
      );
    }
    out.auto_fix = autoFix;
  }
  return out;
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

/** Text fields a raised-item create body may carry; each must be a string. */
const RAISED_TEXT_FIELDS = [
  'content', 'note', 'title', 'explanation', 'proposed_code', 'proposed_prompt',
] as const;

/**
 * A raised-item create body, validated at the boundary.
 *
 * Accepts either a bare string (`content`) or the structured object, and
 * returns it unchanged — trimming and composition belong to
 * `normalizeRaisedCreateInput`, and a caller's spacing must survive the trip.
 *
 * Same rule as the other annotation writers: a wrong-typed or missing body is a
 * 400 naming the field, never a coerced write and never a 500 from a storage
 * `Error`. `blocking` is checked here too when the caller is expected to supply
 * it — an absent flag means the agent never chose, which is exactly the mistake
 * unification made possible and storage rejects one layer down.
 */
export function requireRaisedCreateInput(
  params: Record<string, unknown>,
  options: { requireBlocking?: boolean } = {},
): Record<string, unknown> {
  // Two spellings reach here: the structured `input` body, and the bare
  // top-level `content` the legacy follow-up callers send. A bare `content` is
  // a string or nothing — an object there is a caller confusing the two, and
  // reading it as a structured body would turn that mistake into a blank item.
  if (isAbsent(params.input)) {
    return { content: requireNonBlankString(params, 'content') };
  }
  const raw = params.input;
  if (typeof raw === 'string') {
    if (!raw.trim()) throw new RpcError(400, 'content is required');
    return { content: raw };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcError(400, `content must be a string, got ${typeName(raw)}`);
  }

  const input = raw as Record<string, unknown>;
  for (const field of RAISED_TEXT_FIELDS) {
    const value = input[field];
    if (isAbsent(value)) continue;
    if (typeof value !== 'string') {
      throw new RpcError(400, `${field} must be a string, got ${typeName(value)}`);
    }
  }
  optionalStringArray(input, 'options');
  if (!RAISED_TEXT_FIELDS.some((f) => typeof input[f] === 'string' && (input[f] as string).trim())) {
    throw new RpcError(400, 'content is required');
  }
  if (options.requireBlocking) requireBoolean(input, 'blocking');
  return input;
}

/**
 * The vocabulary is `ACTIVE_RAISED_ACTIONS` itself, never a second copy of it.
 *
 * This boundary held its own hand-written list once, and it silently fell one
 * verb behind the domain: `acknowledge` was accepted by the storage layer and
 * offered by the web decide form, but refused here before the item was ever
 * loaded — so acknowledging a NON-blocking item through accept/unblock was
 * impossible while `lazy raised acknowledge` worked. Deriving the tuple means a
 * verb added to the domain cannot be missing from the surface that guards it.
 *
 * Every verb applies to every item: `blocking` decides whether accept REQUIRES
 * a resolution, never which resolutions are legal.
 */
const RAISED_RESOLVE_ACTIONS = ACTIVE_RAISED_ACTIONS;

/**
 * Optional array of raised-item resolutions for accept / unblock.
 *
 * Shape: `{ id: string, action: 'respond'|'promote_subtask'|'promote_peer'|'dismiss'|'acknowledge', response?: string }[]`
 * Validated at the RPC boundary — a bad element must refuse loudly, not silently
 * skip an open raised item (same reason approvedFiles gets its own accessor).
 *
 * This accessor only decides whether a verb exists at all; per-item rules (a
 * required response, an already-delivered item) live in
 * `validateRaisedResolutions`, which can see the item.
 */
export function optionalRaisedResolutions(
  params: Record<string, unknown>,
  name: string = 'raisedResolutions',
): Array<{ id: string; action: ActiveRaisedResolveAction; response?: string }> | undefined {
  const value = params[name];
  if (isAbsent(value)) return undefined;
  if (!Array.isArray(value)) {
    throw new RpcError(400, `${name} must be an array, got ${typeName(value)}`);
  }
  const out: Array<{ id: string; action: ActiveRaisedResolveAction; response?: string }> = [];
  for (let i = 0; i < value.length; i++) {
    const el = value[i];
    if (el === null || typeof el !== 'object' || Array.isArray(el)) {
      throw new RpcError(400, `${name}[${i}] must be an object, got ${typeName(el)}`);
    }
    const obj = el as Record<string, unknown>;
    if (typeof obj.id !== 'string' || !obj.id) {
      throw new RpcError(400, `${name}[${i}].id must be a non-empty string`);
    }
    if (typeof obj.action !== 'string' || !RAISED_RESOLVE_ACTIONS.includes(obj.action as ActiveRaisedResolveAction)) {
      throw new RpcError(
        400,
        `${name}[${i}].action must be one of ${RAISED_RESOLVE_ACTIONS.join(', ')}`,
      );
    }
    if (obj.response !== undefined && typeof obj.response !== 'string') {
      throw new RpcError(400, `${name}[${i}].response must be a string when present`);
    }
    out.push({
      id: obj.id,
      action: obj.action as ActiveRaisedResolveAction,
      ...(typeof obj.response === 'string' ? { response: obj.response } : {}),
    });
  }
  return out;
}

/**
 * The patch half of a review draft, as an RPC parameter.
 *
 * The parsing itself lives in `parseReviewDraftPatch` (src/review-draft.ts),
 * shared with the daemon own web route: a draft arrives on two external
 * surfaces, and neither may rely on the other to validate it. This wrapper
 * only turns a parse failure into the 400 the RPC layer speaks.
 */
export function requireReviewDraftPatch(
  params: Record<string, unknown>,
  name: string = "patch",
): ReviewDraftPatch {
  try {
    return parseReviewDraftPatch(params[name], name);
  } catch (err) {
    if (err instanceof ReviewDraftPatchError) throw new RpcError(400, err.message);
    throw err;
  }
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

/**
 * Parse an `actor` request field into an {@link ActorInput}.
 *
 * Two accepted shapes: a bare role string (every CLI/MCP/supervisor caller) or
 * the `{ role, email, name }` ref the daemon stamps on for a user-kind caller
 * (see `pinActor` in rpc-handlers.ts). Both are validated against {@link ACTORS} —
 * the ref form goes over the wire on the daemon's own loopback storage proxy,
 * so it is still a request field and still gets checked rather than asserted.
 *
 * It lives HERE, with the other accessors, rather than beside its first caller:
 * every handler that attributes a write needs it, review's raised-item
 * decisions included, and a second copy in another module is the drift this
 * module exists to prevent.
 */
/**
 * Refuse the pre-identity `{ role, userId }` spelling by NAME.
 *
 * The store names people by email now, and `userId` is not a field any surface
 * reads. Dropping it silently would lose a caller's attribution without
 * telling it — the control plane sent an id, the row came back with nobody on
 * it, and nothing failed. So an old client gets an error naming the
 * replacement, the same way a renamed search field does.
 */
export function rejectLegacyActorUserId(ref: Record<string, unknown>, key = 'actor'): void {
  const legacy = ref.userId;
  if (legacy === undefined || legacy === null || legacy === '') return;
  throw new RpcError(
    400,
    `Invalid '${key}.userId': the store names people as git does. ` +
    `Send { role, email, name } instead — an opaque user id names nobody outside the control plane that minted it.`,
  );
}

export function optionalActorInput(
  params: Record<string, unknown>,
  key = 'actor',
): ActorInput | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return optionalEnum(params, key, ACTORS);
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcError(400, `Invalid '${key}': expected one of ${ACTORS.join(', ')} or { role, email, name }.`);
  }
  const ref = raw as Record<string, unknown>;
  rejectLegacyActorUserId(ref, key);
  const role = optionalEnum(ref, 'role', ACTORS);
  if (!role) {
    throw new RpcError(400, `Invalid '${key}.role': expected one of ${ACTORS.join(', ')}.`);
  }
  const email = optionalString(ref, 'email');
  const name = optionalString(ref, 'name');
  if (!email && !name) return role;
  return { role, ...(email ? { email } : {}), ...(name ? { name } : {}) };
}

/**
 * An actor input that MUST be present.
 *
 * For handlers where "who submitted this" is not attribution garnish but an
 * input other rules read — a task's AUDIENCE is derived from who launched it
 * (src/task/audience.ts), so a defaulted actor is a wrong audience, not a
 * missing label. A caller that cannot say who it is gets a 400 naming the
 * field rather than a silent `human`.
 */
export function requireActorInput(
  params: Record<string, unknown>,
  key = 'actor',
): ActorInput {
  const actor = optionalActorInput(params, key);
  if (actor === undefined) {
    throw new RpcError(
      400,
      `Missing '${key}': say which channel submitted this — one of ${ACTORS.join(', ')}. ` +
      `It is recorded on the turn and decides who the task's work is written for.`,
    );
  }
  return actor;
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
