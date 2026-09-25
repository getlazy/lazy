/**
 * `lazy link <ref>` — thin client for the daemon's linkTask RPC.
 *
 * Adopts a PR URL, a branch URL, or a bare branch as a blocked linked task.
 * The CLI only parses flags and prints the result; storage and git live in
 * the daemon.
 */

import { parseFlags } from '../helpers';
import { theme } from '../../render/theme';
import { getActor } from '../../constants';
import { docsFooter } from '../../docs/links';

export async function commandLink(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'parent', takesValue: true },
    { name: 'code', takesValue: true },
  ], 'link');

  const ref = parsed.positional[0];
  if (!ref) {
    linkUsage();
    process.exit(1);
  }

  const parent = parsed.flags.get('parent') as string | undefined;
  const code = parsed.flags.get('code') as string | undefined;

  const { queryLinkTask } = await import('../../daemon/rpc-fallback');
  const { createPhaseDisplay } = await import('../phase-display');
  const display = createPhaseDisplay();
  try {
    const result = await queryLinkTask({
      ref,
      parent,
      code,
      actor: getActor(),
    }, display);
    display.close();

    for (const warning of result.warnings) {
      console.error(theme.warning(`Warning: ${warning}`));
    }

    console.log(theme.success(`\nLinked task ${result.displayId}`));
    console.log(`  ${theme.label('Goal:')}     ${result.goal}`);
    console.log(`  ${theme.label('Branch:')}   ${result.branch}`);
    console.log(`  ${theme.label('Status:')}   ${theme.status(result.status)}`);
    if (result.prUrl) {
      console.log(`  ${theme.label('PR:')}       ${result.prUrl}`);
    }
    if (result.prState) {
      console.log(`  ${theme.label('PR State:')} ${result.prState}`);
    }
    if (result.parentDisplayId) {
      console.log(`  ${theme.label('Parent:')}   ${theme.taskId(result.parentDisplayId)}`);
    }
    if (result.commentsImported > 0) {
      console.log(`  ${theme.label('Notes:')}    ${result.commentsImported} comment(s) imported`);
    }

    console.log(`\nThe task is ${theme.status('blocked')} — ready for review or work.`);
    console.log(`  Review:  ${theme.command('lazy show ' + result.displayId)}`);
    console.log(`  Shell:   ${theme.command('lazy shell ' + result.displayId)}`);
    console.log(`  Unblock: ${theme.command('lazy unblock ' + result.displayId)}`);
  } catch (err) {
    display.close();
    throw err;
  }
}

export function linkUsage(): void {
  console.log(`Usage: lazy link <ref> [--parent <task_id>] [--code <code>]

Link a pull request or a git branch as a lazy task.

Arguments:
  <ref>              PR/MR URL, branch URL, <remote>/<branch>, or a branch name

Options:
  --parent <task_id>  Set a parent task for the linked task
  --code <code>       Human-readable code (e.g. "fix-auth", "add-login")

A PR URL needs a remote driver (driver = "github" or "gitlab" in lazy.toml).
A bare branch works with the local driver too.

Supported patterns:
  GitHub PRs:     https://github.com/<owner>/<repo>/pull/<number>
  GitLab MRs:     https://gitlab.com/<owner>/<repo>/-/merge_requests/<number>
  Branch URLs:    https://github.com/<owner>/<repo>/tree/<branch>
  Bare branch:    feature/auth   or   origin/feature/auth

What happens:
  1. The argument is classified as a PR URL, a branch URL, or a branch
  2. A PR URL is imported (title, branch, comments). A branch is fetched
     and an open PR for it is attached when one exists
  3. A lazy task is created on that existing branch (not a new lazy/ branch)
  4. The task starts in blocked status — it is never auto-started
  5. A PR opened later is attached by the daemon's periodic forge pass

A linked branch is never auto-synced or auto-pushed. Sync or merge into it
is an explicit command (lazy sync / lazy accept).

Examples:
  lazy link https://github.com/org/repo/pull/42
  lazy link https://github.com/org/repo/tree/feature/auth
  lazy link feature/auth
  lazy link origin/feature/auth --parent auth-rewrite --code fix-auth${docsFooter('link')}`);
}
