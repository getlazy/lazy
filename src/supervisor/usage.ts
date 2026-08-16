/**
 * Token-usage salvage for turns that die.
 *
 * A turn that crashes, gets killed by the watchdog, or exhausts its retries has
 * usually already spent real tokens — often the majority of the turn's cost,
 * since the expensive part is the context the model read before it fell over.
 * Historically all of that was thrown away at the throw site: `executeAgent`
 * raised a CrashError/WatchdogTimeoutError carrying only an error string, so the
 * tokens never reached a turn record.
 *
 * This module is the one place that knows how to (a) recognize a reported usage
 * object, (b) dig one out of an agent's final output even when that output can
 * no longer be parsed as a full response, and (c) carry it on a thrown error so
 * the supervisor can put it on the wire.
 *
 * Everything here is defensive by construction: salvaging usage must never be
 * able to turn a recoverable failure into an unrecoverable one. Nothing throws.
 */

import type { AgentTokenUsage } from '../types';

/** Anything that may be carrying salvaged usage — thrown errors, mostly. */
export interface UsageCarrier {
  usage?: AgentTokenUsage;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

/**
 * Validate a usage object coming from OUTSIDE lazy (an agent's stdout).
 *
 * Agents are external surfaces: a backend that reports `usage: null`, a string,
 * or a partially-written JSON line must be rejected here rather than propagated
 * into storage as `NaN` totals that silently corrupt every later sum.
 */
export function isAgentTokenUsage(value: unknown): value is AgentTokenUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const u = value as Record<string, unknown>;
  return (
    isFiniteNumber(u.input_tokens) &&
    isFiniteNumber(u.output_tokens) &&
    isOptionalFiniteNumber(u.cache_creation_input_tokens) &&
    isOptionalFiniteNumber(u.cache_read_input_tokens)
  );
}

/** Add two reported usages. Either side may be absent. */
export function addAgentUsage(
  a: AgentTokenUsage | undefined,
  b: AgentTokenUsage | undefined,
): AgentTokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}

/** Attach salvaged usage to a thrown error (no-op when there is none). */
export function attachUsage<T>(err: T, usage: AgentTokenUsage | undefined): T {
  if (usage && err !== null && typeof err === 'object') {
    (err as UsageCarrier).usage = usage;
  }
  return err;
}

/** Read usage off a thrown error, validating it before trusting it. */
export function readUsage(err: unknown): AgentTokenUsage | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const usage = (err as UsageCarrier).usage;
  return isAgentTokenUsage(usage) ? usage : undefined;
}

/**
 * Dig a usage object out of an agent's raw final output.
 *
 * Tries hardest-to-weakest:
 *   1. the whole blob as one JSON object (the ordinary single-line result), and
 *   2. each line from the end, for a streaming agent whose captured output is a
 *      bounded NDJSON tail.
 *
 * Only a TOP-LEVEL `usage` counts. Streaming assistant events nest their usage
 * under `message.usage` and describe one message, not the turn — summing those
 * would over-count wildly, so they are deliberately not matched here.
 *
 * Returns undefined when nothing usable is present; `onMiss` is called with an
 * explanation so a silent loss is always visible in the supervisor log (we do
 * not throw: the caller is already on an error path).
 */
export function usageFromRawOutput(
  raw: string | undefined,
  onMiss?: (reason: string) => void,
): AgentTokenUsage | undefined {
  if (!raw || !raw.trim()) {
    onMiss?.('the agent produced no final output');
    return undefined;
  }

  const fromBlob = usageFromJsonText(raw);
  if (fromBlob) return fromBlob;

  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const fromLine = usageFromJsonText(lines[i]!);
    if (fromLine) return fromLine;
  }

  onMiss?.('no token usage was present in the agent\'s final output');
  return undefined;
}

function usageFromJsonText(text: string): AgentTokenUsage | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON (or a truncated line from a killed process). Nothing to salvage
    // from this text; the caller's remaining candidates are tried by usageFromRawOutput,
    // and a total miss is reported through its onMiss callback.
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const usage = (parsed as Record<string, unknown>).usage;
  return isAgentTokenUsage(usage) ? usage : undefined;
}
