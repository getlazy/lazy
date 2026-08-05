/**
 * Delivery-side argv safety for agent prompts.
 *
 * Prompts are sanitized at their intake boundaries (CLI, MCP, daemon RPC), so
 * in practice nothing should ever need escaping here. This is the backstop: if
 * a future intake path is added without sanitization, the turn still gets
 * delivered — escaped, with a loud warning — instead of failing the spawn,
 * tripping crash-loop detection, and silently losing the human's feedback.
 *
 * Deliver-and-warn, not fail: see src/utils/sanitize-text.ts for why.
 */

import { sanitizePromptForArgv } from '../utils/sanitize-text';
import { logger } from '../utils/logger';

/**
 * Escape argv-hostile control characters in a prompt destined for argv,
 * warning loudly if anything had to be changed.
 *
 * @param text  The prompt (or system prompt) about to become an argv element.
 * @param label What this text is, for the warning message.
 */
export function safeArgvPrompt(text: string, label: string): string {
  return sanitizePromptForArgv(text, (result) => {
    logger.warn(
      `[argv-safety] ${label} reached the spawn seam with ${result.replaced} non-printable ` +
      `control character(s) (${result.found.join(', ')}) that were not sanitized at intake. ` +
      'They have been escaped so the turn is still delivered, but the intake path that ' +
      'produced this text is missing a sanitizeUserText() call.'
    );
  });
}

/** Same as `safeArgvPrompt`, but tolerant of an absent system prompt. */
export function safeArgvPromptOptional(text: string | undefined, label: string): string | undefined {
  return text === undefined ? undefined : safeArgvPrompt(text, label);
}
