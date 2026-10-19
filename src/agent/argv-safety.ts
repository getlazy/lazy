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
import { SYSTEM_PROMPT_FILE_ARG } from './interface';

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

/**
 * THE ARGV RULE, for every harness: no argv element may carry unbounded text.
 *
 * Linux refuses any single argv element over MAX_ARG_STRLEN (128 KiB) and the
 * whole argv+environment over ARG_MAX, and the refusal is E2BIG at posix_spawn
 * — the agent never starts, the supervisor sees a crash, and crash-loop
 * detection fails the task. Prompts grow without bound (carried feedback,
 * re-delivered turns, notes, a cluster's constraints, turn history on a fresh
 * session), so an agent's prompt goes on STDIN (`stdinInput`) and a large system
 * prompt goes in a FILE the harness reads (`SYSTEM_PROMPT_FILE_ARG` +
 * `systemPromptInput`, materialized by the spawn seam).
 *
 * These bounds are deliberately far below the kernel's: anything legitimately
 * in argv (flags, model ids, settings JSON, a short system prompt) is small, so
 * an element near them is a prompt that leaked into argv, and it is refused at
 * the seam with a message naming it — never a bare E2BIG.
 */
export const ARGV_ELEMENT_MAX_BYTES = 64 * 1024;
export const ARGV_TOTAL_MAX_BYTES = 256 * 1024;

/**
 * Throw if any argv element, or the argv as a whole, exceeds the argv bound.
 * Called by every spawn seam that launches an agent (supervisor watchdog,
 * one-shots, builder launches) and by the guard test over every registered
 * harness, so a harness that puts a prompt in argv fails before it can fail
 * in the wild.
 *
 * @param argv The full argv about to be spawned.
 * @param what What is being launched, for the error message.
 */
export function assertArgvBounded(argv: readonly string[], what: string): void {
  let total = 0;
  for (let i = 0; i < argv.length; i++) {
    const bytes = Buffer.byteLength(argv[i]!, 'utf8');
    total += bytes + 1;
    if (bytes > ARGV_ELEMENT_MAX_BYTES) {
      throw new Error(
        `${what} was not launched: argv element ${i} is ${bytes} bytes, over the ` +
        `${ARGV_ELEMENT_MAX_BYTES}-byte argv bound (it starts ${JSON.stringify(argv[i]!.slice(0, 60))}` +
        `${i > 0 ? `, after ${JSON.stringify(argv[i - 1]!.slice(0, 40))}` : ''}). Unbounded text — a prompt ` +
        'or system prompt — must reach the agent on stdin or in a file, never as a command-line ' +
        'argument; this is a bug in how lazy launches this agent.',
      );
    }
  }
  if (total > ARGV_TOTAL_MAX_BYTES) {
    throw new Error(
      `${what} was not launched: its argv totals ${total} bytes, over the ${ARGV_TOTAL_MAX_BYTES}-byte ` +
      'argv bound. Unbounded text must reach the agent on stdin or in a file; this is a bug in how ' +
      'lazy launches this agent.',
    );
  }
}

/**
 * The argv for a system prompt on a harness that accepts it as a flag: inline
 * when it is small, otherwise `SYSTEM_PROMPT_FILE_ARG` with the text handed back
 * as `systemPromptInput` for the spawn seam to write to a file. `fileFlag` is the
 * harness's flag that takes a PATH (Claude Code `--append-system-prompt-file`;
 * pi's `--append-system-prompt` accepts either).
 */
export function systemPromptArgv(
  systemPrompt: string | undefined,
  inlineFlag: string,
  fileFlag: string,
): { args: string[]; systemPromptInput?: string } {
  if (!systemPrompt) return { args: [] };
  const text = safeArgvPrompt(systemPrompt, 'system prompt');
  // Half the element bound: a system prompt is not the only thing in argv.
  if (Buffer.byteLength(text, 'utf8') <= ARGV_ELEMENT_MAX_BYTES / 2) {
    return { args: [inlineFlag, text] };
  }
  return { args: [fileFlag, SYSTEM_PROMPT_FILE_ARG], systemPromptInput: text };
}
