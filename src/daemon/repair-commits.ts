/**
 * Repair recorded commit lists that the old range walk over-recorded.
 *
 * Until the fix in src/task/session-commits.ts, a task that merged its
 * upstream recorded that upstream's history as its own, and the error
 * compounded turn by turn — three cluster tasks ended up with ~780 records for
 * branches carrying fewer than 30 commits. The recording paths never delete,
 * so those lists do not heal themselves: this is the explicit, visible
 * operation that fixes them, run from `lazy system repair-commits`.
 *
 * It recomputes the same answer the recording path now computes (first-parent
 * from the branch point), removes records that are not in it, and adds any it
 * is missing. A task whose branch can no longer be resolved is REPORTED AND
 * SKIPPED, never guessed at.
 */

import { RpcError } from './rpc-error';
import { getOrCreateStorage } from './rpc-handlers';
import { getWorktreePath } from '../task/identity';
import { scanSessionCommits } from '../task/session-commits';
import { getCurrentBranch } from '../git/operations';
import { pathExists } from '../utils/fs';
import { runGit } from '../utils/git';
import { loadConfig } from '../config/loader';
import { PhaseReporter } from './progress';
import type { ProgressEmitter } from './progress';
import type { Storage } from '../storage';
import type { Task } from '../types';

/** A record this repair would delete, with enough context to judge it by eye. */
export interface CommitRepairRemoval {
  sha: string;
  message: string;
}

export interface CommitRepairEntry {
  taskId: string;
  code: string | null;
  /** How many commit records the store holds today. */
  recorded: number;
  /** How many the branch actually carries. */
  correct: number;
  /**
   * Records that are not on this task's branch. Carries each message, because
   * a deletion a human approves from a bare count is a deletion they did not
   * actually review — and this is the one path that removes stored history.
   */
  remove: CommitRepairRemoval[];
  /** SHAs on its branch that were never recorded. */
  add: string[];
  /** Set when nothing could be computed — the task is left untouched. */
  skipped?: string;
}

export interface CommitRepairResult {
  applied: boolean;
  entries: CommitRepairEntry[];
}

interface BranchView {
  cwd: string;
  headRef: string;
  /**
   * Whether this view is the task's own worktree. A worktree HEAD is the
   * branch's real tip by definition; a fallback ref only might be, which is
   * what `unsafeRemovals` below exists to check.
   */
  source: 'worktree' | 'ref';
}

/**
 * Where to read this task's branch from, and which ref is its tip.
 *
 * The worktree is the truth while it exists — but ONLY while it is actually on
 * this task's branch, and that has to be checked rather than assumed. A
 * worktree sitting on another branch, or on a detached HEAD, or recovered onto
 * a different ref, makes the first-parent walk from `git_start_sha` answer with
 * THAT branch's commits: every genuine record then looks foreign, lands in
 * `remove`, and `--apply` deletes it irreversibly. The worktree source also
 * skips the containment test in `unsafeRemovals` (a worktree HEAD being the
 * tip by definition is the whole reason it may skip it), so nothing downstream
 * would have caught it either.
 *
 * A mismatch therefore falls through to the ref candidates rather than merely
 * being relabelled: the label decides whether containment is owed, but it is
 * the TIP that decides what the walk returns, so a demotion that kept reading
 * the wrong HEAD would fix the check and keep the wrong answer.
 *
 * After an accept the worktree is gone and the local branch is deleted, but the
 * remote-tracking ref usually survives — good enough to recompute a list, since
 * the question is only which commits the branch carried.
 */
async function resolveBranchView(
  projectRoot: string,
  task: Task,
  branch: string,
  remoteName: string,
): Promise<BranchView | null> {
  const worktreePath = getWorktreePath(projectRoot, task);
  if (await pathExists(worktreePath)) {
    const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: worktreePath });
    if (head.exitCode === 0 && await worktreeIsOnBranch(worktreePath, branch)) {
      return { cwd: worktreePath, headRef: 'HEAD', source: 'worktree' };
    }
  }

  for (const ref of [branch, `${remoteName}/${branch}`]) {
    const resolved = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: projectRoot });
    if (resolved.exitCode === 0) return { cwd: projectRoot, headRef: ref, source: 'ref' };
  }

  return null;
}

/**
 * Is this worktree actually on `branch`?
 *
 * `getCurrentBranch` answers the literal `HEAD` for a detached checkout, which
 * equals no real branch name and so correctly reports false. A failure to read
 * it at all is also false: this gate exists to require proof, and an unanswered
 * question is not proof.
 */
async function worktreeIsOnBranch(worktreePath: string, branch: string): Promise<boolean> {
  try {
    return (await getCurrentBranch(worktreePath)).trim() === branch;
  } catch {
    // Cannot establish which branch this worktree is on, so it does not get to
    // be the authority for deleting records. The ref fallback still applies.
    return false;
  }
}

/**
 * Of these recorded SHAs, which ones prove the view's ref is BEHIND the real tip?
 *
 * Deleting a record is the one irreversible thing this command does, and when
 * the view is a fallback ref rather than the worktree, "not on the branch" is
 * only as trustworthy as that ref. A worktree removed and a local branch
 * deleted while the last commits were never pushed leaves a remote-tracking
 * ref that is genuinely behind — and every real tip past it would look like
 * foreign history and be deleted, with nothing left to re-derive it from.
 *
 * The discriminator is containment, and it is exact rather than heuristic:
 *
 *   - An over-recorded commit (the bug this repairs) came from a line the
 *     branch MERGED, so it is reachable from the ref and simply off the
 *     first-parent walk. Contained ⇒ safe to remove.
 *   - A commit the ref never received is NOT reachable from it. Not
 *     contained ⇒ the ref is behind, or the record belongs to history this
 *     ref cannot speak for. Either way, not ours to delete.
 *
 * One `rev-list` answers containment for every candidate at once.
 *
 * A SHA whose OBJECT is gone is unprovable on BOTH paths, worktree included,
 * and it is the most dangerous record of all: a commit that no longer exists
 * in the object database — worktree removed, local branch deleted, unpushed
 * commits garbage-collected — is one whose store record is its only surviving
 * trace. Treating an absent object as "not on the branch, delete it" destroys
 * the last evidence that the work happened, which is the exact inversion of
 * why this module refuses to guess.
 */
async function unsafeRemovals(
  cwd: string,
  headRef: string,
  shas: string[],
  source: BranchView['source'],
): Promise<string[]> {
  if (shas.length === 0) return [];

  const unprovable: string[] = [];
  const existing: string[] = [];
  for (const sha of shas) {
    const probe = await runGit(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd });
    if (probe.exitCode === 0) existing.push(sha);
    else unprovable.push(sha);
  }

  // A worktree HEAD is the branch's real tip by definition, so a record it
  // does not carry really is foreign — no containment test is owed. The
  // missing-object check above still applies, which is the hole this closes.
  if (source === 'worktree' || existing.length === 0) return unprovable;

  // `--no-walk` keeps this to the listed commits themselves; `--not <ref>`
  // drops the ones the ref already contains. What survives is exactly the set
  // the ref cannot account for.
  const result = await runGit(['rev-list', '--no-walk', ...existing, '--not', headRef], { cwd });
  if (result.exitCode !== 0) {
    // Cannot prove safety, so do not claim it.
    return [...unprovable, ...existing];
  }
  return [...unprovable, ...result.stdout.split('\n').map(s => s.trim()).filter(Boolean)];
}

/**
 * Commits that reached the tip through a merge of this task's OWN branch, and
 * so are its work despite sitting off the first-parent walk.
 *
 * Sync step 1 merges `origin/<task-branch>` with `--no-ff` when a colleague
 * has pushed to this task's branch. Their commits land on the merge's SECOND
 * parent, so the first-parent walk never records them — and this repair would
 * then read their existing, correct records as foreign and delete them. That is
 * real history destroyed by the cleanup, which is the one thing it must not do.
 *
 * The two merge kinds are told apart structurally, not by reading messages:
 *
 *   - step 1 merges the same branch from origin, which is AHEAD of local, so
 *     the merge's first parent is an ancestor of its second. Git would
 *     fast-forward; `--no-ff` is why the merge commit exists at all.
 *   - step 2 merges the PARENT branch, a genuinely divergent line, so the first
 *     parent is not an ancestor of the second.
 *
 * Only the first kind is protected, and a single `rev-list` over all such
 * ranges answers it. The residual gap is a colleague's branch that DIVERGED
 * rather than being ahead (a force-push): its merge looks like step 2 and its
 * commits are not protected here. Recording is unchanged either way — this is
 * the delete path refusing to act on what it did not derive, not a second
 * opinion about what should have been recorded.
 */
async function ownBranchMergeCommits(cwd: string, walk: { sha: string }[]): Promise<Set<string>> {
  const ranges: string[] = [];

  for (const commit of walk) {
    const parents = await runGit(['rev-list', '--parents', '-n', '1', commit.sha], { cwd });
    if (parents.exitCode !== 0) continue;
    const parts = parents.stdout.trim().split(/\s+/);
    if (parts.length < 3) continue; // not a merge
    const [, first, second] = parts;

    const ff = await runGit(['merge-base', '--is-ancestor', first!, second!], { cwd });
    if (ff.exitCode === 0) ranges.push(`${first}..${second}`);
  }

  if (ranges.length === 0) return new Set();

  const result = await runGit(['rev-list', ...ranges], { cwd });
  if (result.exitCode !== 0) return new Set();
  return new Set(result.stdout.split('\n').map(l => l.trim()).filter(Boolean));
}

async function planForTask(
  storage: Storage,
  projectRoot: string,
  task: Task,
  remoteName: string,
): Promise<CommitRepairEntry> {
  const base: CommitRepairEntry = {
    taskId: task.id,
    code: task.code,
    recorded: 0,
    correct: 0,
    remove: [],
    add: [],
  };

  const session = await storage.getSessionByTaskId(task.id);
  if (!session) return { ...base, skipped: 'task has no session' };

  const recorded = await storage.getSessionCommits(session.id);
  base.recorded = recorded.length;

  const view = await resolveBranchView(projectRoot, task, session.git_branch, remoteName);
  if (!view) {
    return { ...base, skipped: `branch ${session.git_branch} no longer resolves (worktree and refs are gone)` };
  }

  let scan;
  try {
    scan = await scanSessionCommits(storage, session, view.cwd, view.headRef);
  } catch (err) {
    // Reading the branch FAILED. That is not an empty branch, and the
    // difference is the whole safety of this command.
    return { ...base, skipped: `could not read ${view.headRef}: ${err instanceof Error ? err.message : err}` };
  }
  if (!scan.base) return { ...base, skipped: scan.reason ?? 'could not resolve a range start' };

  // A branch that answers "no commits at all" while the store holds records is
  // never a licence to delete them. A real task branch always carries at least
  // the commit it was started with, so the likeliest explanations are a broken
  // read or a ref that is not this branch — and the plan that follows would
  // otherwise put EVERY record into `remove`, with `--apply` making it
  // permanent. The containment guard below cannot catch it either: with an
  // empty walk there is nothing to compare against.
  if (scan.all.length === 0 && recorded.length > 0) {
    return {
      ...base,
      skipped:
        `${view.headRef} reports no commits since ${scan.base.substring(0, 8)} while ${recorded.length} record(s) exist — ` +
        'refusing to read that as "every record is foreign"',
    };
  }

  const onBranch = new Set(scan.all.map(c => c.sha));

  // A colleague's commits, pushed to THIS task's branch and merged in by sync
  // step 1, sit off the first-parent walk but are this task's work. Their
  // records are correct and must survive the repair.
  const ownBranchMerged = await ownBranchMergeCommits(view.cwd, scan.all);

  const remove: CommitRepairRemoval[] = recorded
    .filter(c => !onBranch.has(c.sha) && !ownBranchMerged.has(c.sha))
    .map(c => ({ sha: c.sha, message: c.message }));

  // A fallback ref has to earn the right to delete. Reported and skipped, the
  // same as a branch that does not resolve at all — the two failures are the
  // same failure, and a partial repair that quietly dropped the unprovable
  // half would be worse than no repair.
  if (remove.length > 0) {
    const unsafe = await unsafeRemovals(view.cwd, view.headRef, remove.map(r => r.sha), view.source);
    if (unsafe.length > 0) {
      return {
        ...base,
        correct: scan.all.length,
        add: scan.commits.map(c => c.sha),
        skipped:
          `cannot prove ${unsafe.length} of the recorded commit(s) wrong ` +
          `(${unsafe.slice(0, 3).map(s => s.substring(0, 8)).join(', ')}${unsafe.length > 3 ? ', …' : ''}) — ` +
          `their objects are missing, or ${view.headRef} does not contain them and may be behind the real tip`,
      };
    }
  }

  return {
    ...base,
    correct: scan.all.length,
    remove,
    add: scan.commits.map(c => c.sha),
  };
}

/**
 * What the CLI confirmed, handed back so the apply pass does not re-sweep.
 *
 * `lazy system repair-commits --apply` plans first (the human has to see the
 * deletions before approving them) and then applies. Re-deriving the whole plan
 * for the apply meant walking every task in the store a second time — hundreds
 * of tasks and several git spawns each, silently, over one RPC.
 *
 * So the apply is handed the plan it is applying: the tasks to touch, and the
 * exact SHAs the human approved removing. It still RE-PLANS each of those tasks
 * — every refusal runs again, against the branch as it is now — and then keeps
 * only removals that are in BOTH answers. The applied removal set is therefore
 * always a subset of what was confirmed AND a subset of what the repair can
 * still prove today; a branch that moved in between can only shrink it.
 */
export interface ConfirmedRepair {
  taskId: string;
  /** SHAs the human approved removing. */
  remove: string[];
}

/**
 * Of a freshly derived removal plan, the part the human actually approved.
 *
 * INVARIANT: the applied removal set is an intersection, never a union. The
 * apply re-derives each confirmed task from scratch — so a removal the repair
 * can no longer prove is gone from the fresh plan and is not deleted — and this
 * then drops anything the fresh plan newly wants to remove but nobody approved.
 * Deleting a commit record is the one irreversible thing this command does, so
 * a record must clear BOTH bars: still provably foreign, and already shown to
 * the human. A branch that moved between the plan and the apply can only shrink
 * what is deleted.
 */
export function retainApproved(
  remove: CommitRepairRemoval[],
  approved: ReadonlySet<string>,
): CommitRepairRemoval[] {
  return remove.filter(r => approved.has(r.sha));
}

/** Read the `confirm` wire field defensively — it is an external input. */
function parseConfirmed(raw: unknown): ConfirmedRepair[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ConfirmedRepair[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { taskId, remove } = item as { taskId?: unknown; remove?: unknown };
    if (typeof taskId !== 'string' || !taskId) continue;
    out.push({
      taskId,
      remove: Array.isArray(remove) ? remove.filter((s): s is string => typeof s === 'string') : [],
    });
  }
  return out;
}

export async function handleRepairCommits(
  projectRoot: string,
  params: Record<string, unknown>,
  progress?: ProgressEmitter,
): Promise<CommitRepairResult> {
  const apply = params.apply === true;
  const taskRef = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  const all = params.all === true;
  const confirmed = apply ? parseConfirmed(params.confirm) : null;

  if (!taskRef && !all) {
    throw new RpcError(400, 'Name a task, or pass all=true to scan every task');
  }

  const storage = await getOrCreateStorage();
  const config = await loadConfig(projectRoot);
  const remoteName = config.remote.git_remote;

  const reporter = new PhaseReporter(progress, 'repair-commits');
  reporter.announce([
    { id: 'scan', label: 'Scan recorded commit lists' },
    { id: 'write', label: 'Write the repair', optional: true },
  ], taskRef || 'all tasks');

  let tasks: Task[];
  if (confirmed) {
    // Only the tasks the human approved — the sweep already happened.
    tasks = [];
    for (const item of confirmed) {
      const task = await storage.getTask(item.taskId);
      if (task) tasks.push(task);
    }
  } else if (taskRef) {
    const { task, ambiguousMatches } = await storage.resolveTask(taskRef);
    if (ambiguousMatches && ambiguousMatches.length > 0) {
      throw new RpcError(400, `Ambiguous task: ${taskRef} matches ${ambiguousMatches.map(t => t.code).join(', ')}`);
    }
    if (!task) throw new RpcError(404, `Task not found: ${taskRef}`);
    tasks = [task];
  } else {
    tasks = await storage.listTasks();
  }

  // Approved removals by task, so the re-plan below can be intersected with
  // them. A task in `confirmed` with no entry here cannot happen (it is built
  // from the same list), but an empty set correctly removes nothing.
  const approved = confirmed
    ? new Map(confirmed.map(c => [c.taskId, new Set(c.remove)]))
    : null;

  reporter.begin({ id: 'scan', label: 'Scan recorded commit lists' }, `${tasks.length} task(s)`);
  const entries: CommitRepairEntry[] = [];
  let index = 0;
  for (const task of tasks) {
    index += 1;
    const label = task.code ?? task.id.substring(0, 8);
    const entry = await planForTask(storage, projectRoot, task, remoteName);

    const stillApproved = approved?.get(task.id);
    if (stillApproved) entry.remove = retainApproved(entry.remove, stillApproved);

    reporter.note(`[${index}/${tasks.length}] ${label} — ${describeEntry(entry)}`);

    // In a sweep, only surface tasks with something to say: a clean task is
    // noise on a store with hundreds of them. A named task always reports.
    if (!taskRef && !entry.skipped && entry.remove.length === 0 && entry.add.length === 0) continue;
    if (!taskRef && entry.skipped && entry.recorded === 0) continue;
    entries.push(entry);
  }
  reporter.end(`${entries.length} task(s) to report`);

  if (apply) {
    reporter.begin({ id: 'write', label: 'Write the repair' });
    let written = 0;
    for (const entry of entries) {
      if (entry.skipped) continue;
      await writeEntry(entry);
      // Narrated AFTER both halves, so the line reports what reached the store
      // rather than what was about to be attempted: an add phase that fails
      // leaves `skipped` set, and a line already claiming `+N` would be the
      // same lie as a summary counting adds it never wrote.
      if (!entry.skipped) written += 1;
      reporter.note(`${entry.code ?? entry.taskId.substring(0, 8)} — ${describeEntry(entry)}`);
    }
    reporter.end(`${written} task(s) written`);
  } else {
    reporter.skip({ id: 'write', label: 'Write the repair' }, 'report only — re-run with --apply to write');
  }

  return { applied: apply, entries };

  /** Write one planned entry, recording any half-completion on it. */
  async function writeEntry(entry: CommitRepairEntry): Promise<void> {
    const session = await storage.getSessionByTaskId(entry.taskId);
    if (!session) {
      entry.skipped = 'session disappeared between the plan and the write — nothing was changed';
      return;
    }
    if (entry.remove.length > 0) {
      await storage.deleteSessionCommits(session.id, entry.remove.map(r => r.sha));
    }
    if (entry.add.length === 0) return;

    // Every bail-out below leaves the removal already written, so it must say
    // so: leaving the entry as a clean success would have the CLI report adds
    // that never reached the store.
    const task = await storage.getTask(entry.taskId);
    if (!task) {
      entry.skipped = `removed ${entry.remove.length} record(s), but the task disappeared before the missing ${entry.add.length} could be added`;
      return;
    }
    const view = await resolveBranchView(projectRoot, task, session.git_branch, remoteName);
    if (!view) {
      entry.skipped = `removed ${entry.remove.length} record(s), but branch ${session.git_branch} no longer resolves, so the missing ${entry.add.length} could not be added`;
      return;
    }
    // `scanSessionCommits` throws when git fails, and the deletion for this
    // entry has ALREADY run. Unguarded, a worktree removed between the plan
    // and the apply (or a pruned ref, or lock contention) escapes the whole
    // RPC: this task half-repaired, every later task in an `--all` sweep
    // silently untouched, and the caller handed an error instead of a
    // per-task skip. One task's git trouble is that task's skip.
    try {
      const scan = await scanSessionCommits(storage, session, view.cwd, view.headRef);
      for (const c of scan.commits) {
        await storage.createCommit(session.id, c.sha, c.message);
      }
    } catch (err) {
      entry.skipped = `removed ${entry.remove.length} record(s), but could not read ${view.headRef} to add the missing ${entry.add.length}: ${err instanceof Error ? err.message : err}`;
    }
  }
}

/** One line of "what did this task turn out to need", for the progress sink. */
function describeEntry(entry: CommitRepairEntry): string {
  if (entry.skipped) return `skipped: ${entry.skipped}`;
  if (entry.remove.length === 0 && entry.add.length === 0) return `ok (${entry.recorded} record(s))`;
  return `${entry.recorded} recorded → ${entry.correct} on the branch (-${entry.remove.length} / +${entry.add.length})`;
}
