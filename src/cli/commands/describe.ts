/**
 * `lazy describe <task_id>` — (re)generate a linked task's description.
 *
 * `lazy link` writes the description as its last step. This is the retry: the
 * one-shot needs a model, and a link made offline, without a credential, or
 * against a wedged proxy still has to LINK — so the description is the half
 * that can be missing, and this is how it is filled in afterwards.
 *
 * Its own verb rather than a flag on `lazy link`: `lazy link` takes a REF and
 * adopts it, while this takes a TASK that already exists. Overloading link's
 * positional to mean either would be exactly the mode-switching flag lazy's
 * "flags do one thing" rule rejects, and `<verb> <task_id>` is the shape every
 * other task-addressed command already uses (`lazy sync`, `lazy diff`, …).
 *
 * A thin client, like every other command: the gathering, the model call and
 * the writes all happen in the daemon.
 */

import { parseFlags } from '../helpers';
import { theme } from '../../render/theme';
import { getActor } from '../../constants';
import { docsFooter } from '../../docs/links';

export async function commandDescribe(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'yes', takesValue: false },
  ], 'describe');

  const taskId = parsed.positional[0];
  if (!taskId) {
    describeUsage();
    process.exit(1);
  }
  const yes = parsed.flags.get('yes') === true;

  const { queryDescribeLinkedTask } = await import('../../daemon/rpc-fallback');
  const { createPhaseDisplay } = await import('../phase-display');
  const display = createPhaseDisplay();
  try {
    const result = await runDescribe(queryDescribeLinkedTask, taskId, yes, display);
    display.close();

    for (const warning of result.warnings) {
      console.error(theme.warning(`Warning: ${warning}`));
    }

    console.log(theme.success(`\nDescribed task ${result.displayId}`));
    console.log(`  ${theme.label('Goal:')}   ${result.goal}${result.goalUpdated ? ' (regenerated)' : ''}`);
    console.log(`  ${theme.label('Prompt:')} ${result.promptChars} characters written`);
    console.log(`\n  Read it: ${theme.command('lazy show ' + result.displayId)}`);
  } catch (err) {
    display.close();
    throw err;
  }
}

/**
 * Run the describe RPC, asking first when the daemon refuses because the prompt
 * has been hand-edited since lazy wrote it (HTTP 409 from the daemon, the same
 * `RpcError` when the CLI is running the handler in-process).
 *
 * The confirmation is HERE rather than in the daemon because only the CLI has a
 * human attached; the daemon's job is to refuse, not to prompt. `--yes` skips it
 * for scripts, per the CLI convention that every confirmation takes the flag.
 */
async function runDescribe(
  query: typeof import('../../daemon/rpc-fallback')['queryDescribeLinkedTask'],
  taskId: string,
  yes: boolean,
  display: Parameters<typeof import('../../daemon/rpc-fallback')['queryDescribeLinkedTask']>[1],
) {
  const actor = getActor();
  try {
    return await query({ taskId, force: yes, actor }, display);
  } catch (err) {
    if (!isPromptEditedRefusal(err)) throw err;

    const { isTTY, promptYesNo } = await import('../editor');
    if (!isTTY()) {
      console.error(theme.warning(`\n${(err as Error).message}`));
      process.exit(1);
    }
    console.error(theme.warning(`\n${(err as Error).message}`));
    const ok = await promptYesNo('Replace the current prompt with a freshly generated description?', false);
    if (!ok) {
      console.log('Aborted — the prompt is unchanged.');
      process.exit(0);
    }
    return await query({ taskId, force: true, actor }, display);
  }
}

/** 409 is the daemon's "the prompt was edited since lazy wrote it" refusal. */
function isPromptEditedRefusal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 409;
}

export function describeUsage(): void {
  console.log(`Usage: lazy describe <task_id> [--yes]

Write a linked task's description from its branch and pull request.

A task created by 'lazy link' adopts someone else's branch, so it starts with
little more than a title. Describing it reads the pull request body, the
comments, the commits and the diff against the base branch, and writes the
task's goal and a prompt saying what the work is, what is already done, what
reviewers asked for, and what is still open.

'lazy link' does this automatically. Run this when that step was skipped or
failed (no model credential, no network), or to refresh the description after
the branch has moved on.

Arguments:
  <task_id>          Task id or code of a linked task

Options:
  --yes              Replace a hand-edited prompt without asking

Notes:
  - Only linked tasks can be described; a task lazy created already has the
    prompt it was started with (change it with 'lazy edit --prompt')
  - If you have edited the prompt yourself since lazy wrote it, this asks
    before replacing it
  - The previous prompt is kept as a prompt version, not overwritten
  - Nothing is written to the linked branch

Examples:
  lazy describe fix-auth
  lazy describe a1b2c3d4${docsFooter('link')}`);
}
