/**
 * `lazy shell <task> --local` in a clone bound to Lazy Teams.
 *
 * The task's work lives on the server; some of it can only be built and tested
 * on this machine (a macOS app, say). This command gives the person a LOCAL
 * checkout of the task's branch and nothing more:
 *
 *   1. fetch `lazy/<task>` from the install's hosted repository (`origin`);
 *   2. create — or refresh — a `git worktree` of this clone on that branch,
 *      tracking `origin/lazy/<task>`;
 *   3. open the person's shell there.
 *
 * It is plain git from then on. Lazy never pushes for them — not on exit, not on
 * commit; a plain `git push` from the checkout is how their changes reach the
 * task's branch, and the agent gets them through sync's first step (merge
 * `origin/<task-branch>` when it has commits the task's branch lacks).
 *
 * WHERE: a sibling of this clone, `<clone>-<task-code>`. Not inside the clone —
 * a checkout there shows up as untracked files in every `git status` and is
 * crawled by every build tool and IDE that indexes the clone — and not hidden
 * under `.git`, because the person opens it in their editor and build tools for
 * days. If the branch is already checked out in some worktree of this clone,
 * that worktree is used wherever it is.
 *
 * A re-run NEVER discards anything: it fast-forwards a clean checkout that is
 * behind, and otherwise leaves the checkout exactly as it is and says why.
 */

import { basename, dirname, join } from 'path';
import { access } from 'fs/promises';
import { runGit } from '../../utils/git';
import { spawnSyncInteractive } from '../../utils/spawn';
import { queryTaskShow } from '../../daemon/rpc-fallback';

const REMOTE = 'origin';

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await runGit(args, cwd);
  return { ok: r.exitCode === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`could not inspect ${path}: ${errorText(err)}`);
  }
}

/** The worktree of this clone that has `branch` checked out, if any. */
async function worktreeFor(cloneRoot: string, branch: string): Promise<string | null> {
  // A checkout whose directory was deleted is still registered; pruning drops
  // only registrations whose directory is already gone, so it discards nothing.
  await git(['worktree', 'prune'], cloneRoot);
  const list = await git(['worktree', 'list', '--porcelain'], cloneRoot);
  if (!list.ok) throw new Error(`git worktree list failed: ${list.err}`);
  let current: string | null = null;
  for (const line of list.out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && current) return current;
  }
  return null;
}

/** Bring an existing checkout up to date without ever discarding anything. One line of what happened. */
async function refreshCheckout(path: string, branch: string): Promise<string> {
  const remoteRef = `${REMOTE}/${branch}`;
  const dirty = await git(['status', '--porcelain'], path);
  if (!dirty.ok) throw new Error(`git status failed in ${path}: ${dirty.err}`);
  const behind = Number((await git(['rev-list', '--count', `HEAD..${remoteRef}`], path)).out || '0');
  const ahead = Number((await git(['rev-list', '--count', `${remoteRef}..HEAD`], path)).out || '0');

  if (behind === 0) {
    const parts = ['Up to date with the task branch on Lazy Teams'];
    if (ahead > 0) parts.push(`${ahead} local commit(s) not pushed yet`);
    if (dirty.out) parts.push('uncommitted changes kept');
    return parts.join('; ') + '.';
  }
  if (dirty.out) {
    return `Left as is: ${remoteRef} has ${behind} new commit(s), but this checkout has uncommitted changes. ` +
      'Commit or stash them, then `git pull`.';
  }
  if (ahead > 0) {
    return `Left as is: this checkout and ${remoteRef} have both moved (${ahead} local, ${behind} remote commit(s)). ` +
      'Run `git pull` to merge them.';
  }
  const ff = await git(['merge', '--ff-only', remoteRef], path);
  if (!ff.ok) return `Left as is: could not fast-forward to ${remoteRef}: ${ff.err}`;
  return `Fast-forwarded ${behind} commit(s) from the task branch on Lazy Teams.`;
}

/** Make sure a tracking checkout of `branch` exists; returns its path and one line of what was done. */
async function ensureCheckout(cloneRoot: string, branch: string, code: string): Promise<{ path: string; note: string }> {
  const remoteRef = `${REMOTE}/${branch}`;
  const existing = await worktreeFor(cloneRoot, branch);
  if (existing) {
    // Re-assert tracking: harmless when set, and what makes `git push` land on the task branch.
    await git(['branch', `--set-upstream-to=${remoteRef}`, branch], cloneRoot);
    return { path: existing, note: await refreshCheckout(existing, branch) };
  }

  const path = join(dirname(cloneRoot), `${basename(cloneRoot)}-${code}`);
  if (await pathExists(path)) {
    fail(`${path} already exists and is not a checkout of ${branch} from this clone. Move it away and run this again.`);
  }

  const hasLocal = (await git(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], cloneRoot)).ok;
  const add = hasLocal
    ? await git(['worktree', 'add', path, branch], cloneRoot)
    : await git(['worktree', 'add', '--track', '-b', branch, path, remoteRef], cloneRoot);
  if (!add.ok) fail(`could not create a checkout of ${branch} at ${path}: ${add.err}`);
  if (hasLocal) {
    const track = await git(['branch', `--set-upstream-to=${remoteRef}`, branch], cloneRoot);
    if (!track.ok) fail(`could not make ${branch} track ${remoteRef}: ${track.err}`);
    return { path, note: `Checked out your existing local ${branch}. ${await refreshCheckout(path, branch)}` };
  }
  return { path, note: `Created a checkout of ${branch}.` };
}

export async function commandShellLocal(cloneRoot: string, args: string[]): Promise<void> {
  const sep = args.indexOf('--');
  const pre = sep === -1 ? args : args.slice(0, sep);
  const command = sep === -1 ? [] : args.slice(sep + 1);
  const offending = pre.filter((a) => a.startsWith('-') && a !== '--local');
  if (offending.length > 0) fail(`${offending.join(', ')} cannot be combined with --local.`);
  const taskRef = pre.find((a) => !a.startsWith('-'));
  if (!taskRef) fail('`lazy shell <task> --local` needs a task.');

  let shown;
  try {
    shown = await queryTaskShow(taskRef);
  } catch (err) {
    fail(errorText(err));
  }
  if (!shown) fail(`Task not found: ${taskRef}`);
  if (shown.ambiguous) {
    fail(`'${taskRef}' matches more than one task: ${shown.matches.map((m) => m.code ?? m.id).join(', ')}. Be more specific.`);
  }
  const branch = shown.data.session?.git_branch;
  if (!branch) fail(`task ${taskRef} has no branch yet — start it first.`);
  const code = shown.data.task.code ?? shown.data.task.id.slice(0, 8);

  const fetch = await git(['fetch', REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`], cloneRoot);
  if (!fetch.ok) {
    fail(`could not fetch ${branch} from Lazy Teams: ${fetch.err}\n` +
      '  A task branch appears there after the task finishes its first turn.');
  }

  const { path, note } = await ensureCheckout(cloneRoot, branch, code);
  console.error(`Local checkout of ${branch}: ${path}`);
  console.error(note);
  console.error(
    `It tracks ${REMOTE}/${branch}. Lazy never pushes from here: \`git push\` is how your commits reach the task,\n` +
    `and the agent picks them up at its next \`lazy sync ${code}\` or unblock.`,
  );

  const result = spawnSyncInteractive(command.length > 0 ? command : [process.env.SHELL || '/bin/sh'], {
    cwd: path,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (command.length > 0) process.exitCode = result.exitCode ?? 1;
}
