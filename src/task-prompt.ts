/**
 * The single resolver for "what is this task's prompt RIGHT NOW".
 *
 * Prompts are versioned: every `lazy edit --prompt` appends a
 * {@link TaskPromptVersion} to the task's prompt history, and `task.prompt` is
 * updated to the new content in the SAME write (see `updateTaskPrompt` in each
 * storage backend). So the current prompt is a plain field on the task — no
 * history read, no version arithmetic.
 *
 * This function exists because five call sites re-derived it instead, each
 * doing `(await storage.getPromptHistory(id))[history.length - 1]`. That is
 * only correct if the history array is ascending by version, and FileStorage
 * returned it DESCENDING while PostgresStorage returned it ascending — so on
 * the default backend those callers silently resolved the ORIGINAL prompt:
 *
 *   - `lazy_show` reported a prompt the agent never received, disagreeing with
 *     its own `turns` array in the same response (a reviewer reading v1 next to
 *     a diff produced from v2 concludes the agent went off-instruction);
 *   - `lazy clone` / `lazy redo` (CLI and MCP) seeded the NEW task with the
 *     superseded prompt, so the stale text was then actually executed.
 *
 * The backend ordering divergence is still there — aligning it would edit an
 * assertion in an invariant test, which needs human approval. The fix is that
 * nobody re-derives this any more: every surface that wants the current prompt
 * calls here, and `getPromptHistory` is for HISTORY.
 */
import type { Task } from './types/index';

/**
 * The task's current prompt, or `null` when it has none.
 *
 * Empty string is normalized to `null`: a task created without a prompt stores
 * `''`, and callers uniformly treat "no prompt" as absent.
 */
export function currentPromptOf(task: Pick<Task, 'prompt'>): string | null {
  return task.prompt ? task.prompt : null;
}
