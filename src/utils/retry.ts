/**
 * Retry utility for remote operations (push, fetch, MR/PR creation).
 *
 * INVARIANT: Remote operations must retry up to 3 attempts with progressive
 * backoff (2s, 4s). If all attempts fail, the operation FAILS — no silent
 * fallback to local-only behavior.
 */

import { logger } from './logger';

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Backoff delays in ms between attempts. Default: [2000, 4000]. */
  backoffMs?: number[];
  /** If true, skip the remote operation entirely (for explicit offline mode). */
  offlineOverride?: boolean;
  /** Called before each retry with the attempt number and error. */
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [2000, 4000];

/**
 * Retry an async remote operation with progressive backoff.
 *
 * @param operation - The async operation to retry.
 * @param description - Human-readable description for error messages (e.g., "push branch main").
 * @param options - Retry configuration.
 * @returns The result of the first successful attempt.
 * @throws The last error if all attempts fail, wrapped with context.
 */
export async function withRemoteRetry<T>(
  operation: () => Promise<T>,
  description: string,
  options?: RetryOptions,
): Promise<T> {
  if (options?.offlineOverride) {
    throw new Error(
      `Skipped remote operation (offline override): ${description}. ` +
      `Re-run without --offline-override when network is available.`,
    );
  }

  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = options?.backoffMs ?? DEFAULT_BACKOFF_MS;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxAttempts) {
        const delayMs = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1]!;
        logger.warn(
          `${description}: attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. ` +
          `Retrying in ${delayMs / 1000}s...`,
        );
        options?.onRetry?.(attempt, lastError);
        await sleep(delayMs);
      }
    }
  }

  // All attempts failed — provide actionable error message
  throw new Error(
    `${description} failed after ${maxAttempts} attempts. ` +
    `Last error: ${lastError!.message}. ` +
    `Check your network connection and retry, or use --offline-override to proceed without remote.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
