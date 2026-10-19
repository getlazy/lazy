/**
 * A system prompt handed to an agent as a FILE rather than an argv element —
 * the argv rule in ./argv-safety. For the launch paths that build their own
 * argv (the builder); supervised turns go through the watchdog's
 * `SYSTEM_PROMPT_FILE_ARG` substitution instead.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger';

/**
 * Write `text` to a private (0600) temp file, run `fn` with its path, and remove
 * the file afterwards whatever `fn` did.
 */
export async function withSystemPromptFile<T>(text: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'lazy-system-prompt-'));
  try {
    const path = join(dir, 'system-prompt.txt');
    await writeFile(path, text, { mode: 0o600 });
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
      logger.warn(`Could not remove temporary system prompt ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
