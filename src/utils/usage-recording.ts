/**
 * Recording token usage into storage.
 *
 * Usage is stored twice, on purpose: on the TURN that spent it, and rolled into
 * the SESSION total. Those are two views of the same tokens, so they must be
 * written together or they drift — and drift is exactly what was measured in
 * the live store (see docs/token-usage-recording.md): sessions whose total
 * exceeded the sum of their turns, with the difference attributed to nothing.
 *
 * Every caller goes through here so that invariant lives in one place.
 */

import type { Storage } from '../storage/interface';
import type { TokenUsage, AgentTokenUsage } from '../types';
import { isAgentTokenUsage } from '../supervisor/usage';
import { logger } from './logger';

/**
 * Convert a usage block reported by an agent into the stored TokenUsage shape.
 *
 * The block crosses a trust boundary (it is whatever the agent printed), so it
 * is validated before use: a backend that reports a string, null, or NaN must
 * not poison every later sum. A malformed block is logged and dropped, never
 * silently coerced to zero.
 */
export function toTurnUsage(usage: AgentTokenUsage | undefined, context?: string): TokenUsage | undefined {
  if (usage === undefined || usage === null) return undefined;
  if (!isAgentTokenUsage(usage)) {
    logger.warn(
      `${context ? `${context}: ` : ''}ignoring a malformed token-usage block from the agent ` +
      `(${JSON.stringify(usage)}) — these tokens will not be recorded.`,
    );
    return undefined;
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Add a turn's tokens to its session total.
 *
 * INVARIANT: call this ONLY where the turn carrying the same tokens is written,
 * inside the same idempotency guard. Turn writes are guarded (a re-flush of an
 * unconsumed response.json skips them); the rollup was not, so a re-flush added
 * the tokens a second time with no turn to account for them. Session total and
 * turn sum must move together or neither moves.
 *
 * Failing to roll up does not fail the turn — but it is never silent, because a
 * swallowed failure here is invisible under-reporting of real spend.
 */
export async function rollUpSessionUsage(
  storage: Storage,
  sessionId: string,
  usage: TokenUsage | undefined,
  context?: string,
): Promise<void> {
  if (!usage) return;
  try {
    await storage.updateSessionUsage(sessionId, usage);
  } catch (err) {
    logger.warn(
      `${context ? `${context}: ` : ''}could not add this turn's tokens to the session total ` +
      `(${err instanceof Error ? err.message : String(err)}). The turn record still carries them.`,
    );
  }
}
