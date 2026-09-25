/**
 * `lazy doctor --<remedy>` — the remedies doctor's checks point at, plus the
 * detection those checks and their remedies SHARE.
 *
 * One rule shapes every flow here: a remedy that is a lazy operation is a
 * FLAG, never a shell command list for the human to paste, and never something
 * doctor does on its own. Doctor reports; the human chooses; the flag acts.
 * Pasted `docker rm ...` / `git config --unset ...` lists were unreviewable
 * (nobody reads a twelve-image `docker image rm` line before pressing return)
 * and doctor's one automatic action — resuming interrupted tasks — spawned
 * `process.argv[0]`, which in a released binary is an embedded `bun` that is
 * not on PATH, so every automatic resume failed with `binary 'bun' not found`.
 *
 * Every flow has the same shape:
 *   1. list what it found, one line per item, with what makes it removable;
 *   2. stop there under `--dry-run`;
 *   3. confirm (`--yes` skips the prompt; a non-TTY without `--yes` stops and
 *      says so — no silent destructive default);
 *   4. act, one line per item, reporting each failure with its cause.
 *
 * Detection lives in `src/doctor/findings.ts` (shared with the sweep and the
 * daemon) so a check can never report something a flag would not act on (or
 * the reverse). This file is the CLI act-and-prompt half. Removal always goes
 * through the module that OWNS the concern, never a git or docker command line
 * composed in the CLI: worktrees through `src/task/cleanup.ts` (the same
 * chokepoint accept/reject/close use, so the agent session log is captured
 * before the tree goes), containers through the runner, images through
 * `src/capture/claude.ts`, resume through the daemon RPC `lazy resume` uses.
 */

import { theme } from '../../render/theme';
import { isTTY, promptYesNo } from '../editor';
import { withDoctorStorage } from '../../doctor/storage';
import { cleanupWorktree } from '../../task/cleanup';
import { createRunnerFromType } from '../../runner';
import { removeLazyImage, resolveImageName, type LazyImageInfo } from '../../capture/claude';
import { runGit } from '../../utils/git';
import { queryResumeTask } from '../../daemon/rpc-fallback';
import {
  applyLocalCommandCleanup,
  deleteEmptiedConversations,
  elideSummary,
} from '../../import/local-command-cleanup';
import {
  describeWorktreeReclaim,
  findLocalCommandConversations,
  findOrphanedContainers,
  findResumableTasks,
  findStaleLazyImages,
  findTerminalTaskWorktrees,
  findTrackedTaskBranches,
  formatDiskBytes,
  StaleImageScanError,
  type OrphanedContainer,
  type ResumableTask,
  type TerminalWorktree,
  type TrackedTaskBranch,
} from '../../doctor/findings';
import { usagePauseOverrideEligibility } from '../human-terminal';

export {
  describeWorktreeReclaim,
  findOrphanedContainers,
  findResumableTasks,
  findStaleLazyImages,
  findTerminalTaskWorktrees,
  findTrackedTaskBranches,
  formatDiskBytes,
  StaleImageScanError,
};
export type { OrphanedContainer, ResumableTask, TerminalWorktree, TrackedTaskBranch };

/** Options every remedy flag accepts. */
export interface RemedyOptions {
  /** Skip the confirmation prompt (scripts, and the documented non-TTY route). */
  yes: boolean;
  /** List what would happen and change nothing. */
  dryRun: boolean;
  /**
   * `--delete-empty-local-command-conversations`: also DELETE the stored
   * conversations that hold nothing but Claude Code scaffolding.
   *
   * Its own flag, never implied by `--yes`, and asked for separately from the
   * rewrite — deleting a row is a different act from cleaning one.
   */
  deleteEmpty?: boolean;
}

/**
 * Why the container runtime cannot be queried, or null when it answers.
 *
 * Both runtime remedies must ask this BEFORE they list anything, because every
 * listing path fails OPEN: `listLazyImages` returns an empty array when
 * `docker images` exits non-zero, and `findOrphanedContainers` does the same on
 * its `ps -a` — so an installed `docker` whose daemon is not running produces
 * "nothing to clean up", a clean bill of health on no evidence at all. The
 * binary being on PATH does not answer the question (which is why `which` is not
 * enough); only asking the runtime does.
 *
 * The probe is the runner's own `checkAvailability()` — one mechanism covering
 * both "not installed" and "installed but not running", owned by the runner
 * rather than re-derived here, and carrying the runtime-specific install hint
 * podman overrides it for.
 */
async function runtimeUnavailable(binary: 'docker' | 'podman'): Promise<string | null> {
  try {
    // Config-free constructor: a reachability probe must not itself need the
    // daemon (see the note at the removal loop below).
    await createRunnerFromType(binary).checkAvailability();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Report an unreachable runtime and fail — never a silent empty listing. */
function reportRuntimeUnavailable(runnerType: string, reason: string): void {
  console.error(theme.error(`Cannot reach ${runnerType} — ${reason}`));
  console.error(
    `Nothing was inspected and nothing was removed. Start it and re-run; ` +
    `${theme.command('lazy doctor')} reports the runtime itself.`,
  );
  process.exitCode = 1;
}

/**
 * Ask before acting. `--yes` proceeds; a non-TTY without it stops and says how
 * to proceed, because a destructive default nobody saw is the one thing a
 * remedy flag must not do.
 */
async function confirmRemedy(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!isTTY()) {
    console.log(`Re-run with ${theme.command('--yes')} to apply this (non-interactive).`);
    return false;
  }
  return promptYesNo(question, false);
}

/**
 * Closing line of a remedy's act step — and its exit code.
 *
 * Every per-item failure above is printed and the loop CONTINUES, because one
 * worktree git refuses to drop must not strand the other four. That makes the
 * exit code the only signal a script, a `&&` chain or a CI step can read, so a
 * batch in which anything failed exits 1: `Removed 0 of 3 container(s).`
 * followed by exit 0 tells the caller the cleanup they asked for happened.
 */
function reportRemedyOutcome(verb: string, done: number, total: number, noun: string): void {
  console.log('');
  console.log(`${verb} ${done} of ${total} ${noun}.`);
  if (done < total) process.exitCode = 1;
}

export async function commandDoctorCleanWorktrees(root: string, opts: RemedyOptions): Promise<void> {
  await withDoctorStorage(root, async storage => {
    const worktrees = await findTerminalTaskWorktrees(root, storage);
    if (worktrees.length === 0) {
      console.log('No worktrees for finished tasks — nothing to clean up.');
      return;
    }

    console.log(`${describeWorktreeReclaim(worktrees)} for tasks that are finished with:\n`);
    for (const w of worktrees) {
      console.log(
        `  ${theme.taskId(w.taskCode)} ${theme.status(w.status)} — ${w.path} (${formatDiskBytes(w.sizeBytes)})`,
      );
    }
    console.log('');
    console.log(theme.separator('  Branches are kept — only the working trees are removed.'));
    console.log('');

    if (opts.dryRun) {
      console.log(`Dry run — nothing removed. Drop ${theme.command('--dry-run')} to apply.`);
      return;
    }
    if (!(await confirmRemedy(`Remove ${worktrees.length} worktree(s)?`, opts.yes))) {
      console.log('Aborted — nothing was removed.');
      return;
    }

    let removed = 0;
    for (const w of worktrees) {
      try {
        // The shared teardown chokepoint: captures the agent session log out of
        // the sandbox dir BEFORE the tree goes, and falls back to rm + prune on
        // a worktree git no longer recognises. Never reimplemented here.
        await cleanupWorktree(w.path, root, storage, w.taskId, w.sessionId);
        console.log(theme.success(`  Removed ${w.path} (${formatDiskBytes(w.sizeBytes)})`));
        removed++;
      } catch (err) {
        console.log(
          theme.error(`  Failed to remove ${w.path}: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
    reportRemedyOutcome('Removed', removed, worktrees.length, 'worktree(s)');
  });
}


export async function commandDoctorCleanDockerImages(root: string, opts: RemedyOptions): Promise<void> {
  const { loadConfig } = await import('../../config/loader');
  const config = await loadConfig(root);
  const runnerType = config.runner?.type ?? 'docker';
  if (runnerType !== 'docker' && runnerType !== 'podman') {
    console.log(`Runner is ${runnerType} — there are no lazy container images to clean up.`);
    return;
  }

  const unavailable = await runtimeUnavailable(runnerType);
  if (unavailable) {
    reportRuntimeUnavailable(runnerType, unavailable);
    return;
  }

  const imageName = await resolveImageName(root);
  let stale: LazyImageInfo[];
  try {
    stale = await withDoctorStorage(root, handle =>
      findStaleLazyImages(imageName, runnerType, root, handle),
    );
  } catch (err) {
    // A scan that could not run must never read as "nothing to clean up".
    // `docker` absent is exactly this path: listing throws, and printing a
    // clean bill would tell the human their disk is tidy on no evidence.
    console.error(theme.error(`Cannot list stale images — ${err instanceof Error ? err.message : String(err)}`));
    console.error(
      err instanceof StaleImageScanError && err.kind === 'runtime'
        ? `Start the container runtime (or check ${theme.command(`${runnerType} ps`)}) and re-run.`
        : `Re-run once the store is readable — ${theme.command('lazy doctor')} reports what is wrong with it.`,
    );
    process.exitCode = 1;
    return;
  }
  if (stale.length === 0) {
    console.log('No stale lazy images — nothing to clean up.');
    return;
  }

  console.log(`${stale.length} lazy image(s) no launch on this machine can use:\n`);
  for (const image of stale) {
    console.log(`  ${image.ref} (${image.size})`);
  }
  console.log('');
  console.log(theme.separator(
    `  ${imageName}, the daemon-adopted image and every task-pinned image are excluded.`,
  ));
  console.log('');

  if (opts.dryRun) {
    console.log(`Dry run — nothing removed. Drop ${theme.command('--dry-run')} to apply.`);
    return;
  }
  if (!(await confirmRemedy(`Remove ${stale.length} image(s)?`, opts.yes))) {
    console.log('Aborted — nothing was removed.');
    return;
  }

  let removed = 0;
  for (const image of stale) {
    const result = await removeLazyImage(image.ref, runnerType);
    if (result.ok) {
      console.log(theme.success(`  Removed ${image.ref} (${image.size})`));
      removed++;
    } else {
      // A refusal is usually another image depending on this layer, or a
      // stopped container still referencing it — say which, don't swallow it.
      console.log(theme.error(`  Failed to remove ${image.ref}: ${result.error.split('\n')[0]}`));
    }
  }
  reportRemedyOutcome('Removed', removed, stale.length, 'image(s)');
}


export async function commandDoctorCleanOrphanedContainers(
  root: string,
  opts: RemedyOptions,
): Promise<void> {
  const { loadConfig } = await import('../../config/loader');
  const config = await loadConfig(root);
  const runnerType = config.runner?.type ?? 'docker';
  if (runnerType !== 'docker' && runnerType !== 'podman') {
    console.log(`Runner is ${runnerType} — there are no lazy containers to clean up.`);
    return;
  }

  const unavailable = await runtimeUnavailable(runnerType);
  if (unavailable) {
    reportRuntimeUnavailable(runnerType, unavailable);
    return;
  }

  await withDoctorStorage(root, async storage => {
    const orphans = await findOrphanedContainers(root, storage, runnerType);
    if (orphans.length === 0) {
      console.log('No orphaned lazy containers — nothing to clean up.');
      return;
    }

    console.log(`${orphans.length} orphaned lazy container(s):\n`);
    for (const o of orphans) {
      const why = o.running
        ? `running for ${theme.status(o.taskStatus)} task ${theme.taskId(o.taskCode)}`
        : `${o.state}, task ${theme.taskId(o.taskCode)} is ${theme.status(o.taskStatus)}`;
      console.log(`  ${o.name} — ${why}`);
    }
    console.log('');

    if (opts.dryRun) {
      console.log(`Dry run — nothing removed. Drop ${theme.command('--dry-run')} to apply.`);
      return;
    }
    if (!(await confirmRemedy(`Remove ${orphans.length} container(s)?`, opts.yes))) {
      console.log('Aborted — nothing was removed.');
      return;
    }

    // `createRunnerFromType`, not `createRunner`: the latter resolves live proxy
    // targets and THROWS `ProxyUnavailableError` when the daemon is unreachable
    // — after the human had already confirmed the removal. Removing a container
    // needs no proxy, and a cleanup remedy that only works while the daemon is
    // up would be useless in exactly the wedged state it exists for.
    const runner = createRunnerFromType(runnerType);
    let removed = 0;
    for (const o of orphans) {
      try {
        // The runner owns container lifecycle, including force-removing a
        // running one — doctor does not compose `docker rm -f`.
        await runner.removeRun(o.name);
        // `removeRun` reports failure by LOGGING it: `removeContainer` warns on a
        // non-zero `rm` and returns normally, so a clean return is NOT evidence
        // the container is gone, and printing `Removed …` on it is a false
        // success. Ask the runner instead — it answered `ps -a` moments ago, so
        // "still there" is unambiguous.
        if (await runner.runExists(o.name)) {
          console.log(theme.error(
            `  Failed to remove ${o.name} — still present afterwards; ` +
            `run ${theme.command(`${runnerType} rm -f ${o.name}`)} to see why`,
          ));
          continue;
        }
        // Keep the session record honest: a container_name pointing at a
        // container that no longer exists is what makes later turns guess.
        if (o.sessionId) await storage.updateSessionContainerName(o.sessionId, null);
        console.log(theme.success(`  Removed ${o.name}`));
        removed++;
      } catch (err) {
        console.log(
          theme.error(`  Failed to remove ${o.name}: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
    reportRemedyOutcome('Removed', removed, orphans.length, 'container(s)');
  });
}


export async function commandDoctorUnsetUpstreamTracking(
  root: string,
  opts: RemedyOptions,
): Promise<void> {
  const tracked = await findTrackedTaskBranches(root);
  if (tracked.length === 0) {
    console.log('No task branches have upstream tracking — nothing to unset.');
    return;
  }

  console.log(`${tracked.length} task branch(es) have upstream tracking config:\n`);
  for (const t of tracked) {
    const target = t.merge ?? '(no merge ref)';
    const flag = t.mismatched
      ? ` ${theme.warning('← a `git pull` on this branch merges a DIFFERENT branch')}`
      : '';
    console.log(`  ${t.branch} → ${t.remote} ${target}${flag}`);
  }
  console.log('');
  console.log(theme.separator(
    '  Unsetting only removes .git/config entries. No branch, commit or remote ref is touched.',
  ));
  console.log('');

  if (opts.dryRun) {
    console.log(`Dry run — nothing unset. Drop ${theme.command('--dry-run')} to apply.`);
    return;
  }
  if (!(await confirmRemedy(`Unset tracking on ${tracked.length} branch(es)?`, opts.yes))) {
    console.log('Aborted — nothing was unset.');
    return;
  }

  let cleared = 0;
  for (const t of tracked) {
    const failures: string[] = [];
    for (const key of [`branch.${t.branch}.remote`, `branch.${t.branch}.merge`]) {
      const why = await unsetLocalGitKey(root, key);
      if (why) failures.push(why);
    }
    if (failures.length === 0) {
      console.log(theme.success(`  Unset tracking on ${t.branch}`));
      cleared++;
    } else {
      console.log(theme.error(`  Failed to unset ${t.branch}: ${failures[0]}`));
    }
  }
  reportRemedyOutcome('Unset tracking on', cleared, tracked.length, 'branch(es)');
}

/**
 * Remove one git config key from the repository, or say why it is still there.
 * Returns null on success (including "was already absent").
 *
 * Two things make this more than a one-liner, both verified against git rather
 * than assumed:
 *
 *   - `--unset` REFUSES a multi-valued key ("has multiple values") and exits 5,
 *     leaving both values in place. `--unset-all` removes them. Exit 5 is
 *     therefore ambiguous on its own — it is also what an absent key returns —
 *     so it can never be read as success.
 *   - `git config --unset` only ever writes the LOCAL file. A `branch.<b>.*`
 *     entry that lives in the user's GLOBAL config (a wildcard `[branch]`
 *     section, an old `pull.rebase` era setup) exits 5 with the key still fully
 *     readable afterwards, and reporting "Unset tracking on <branch>" there is a
 *     false success on the one operation the human asked for.
 *
 * Hence: `--unset-all`, then READ BACK. The read-back is what makes the report
 * true, and it names the file actually holding the value so the human can act.
 */
async function unsetLocalGitKey(root: string, key: string): Promise<string | null> {
  const unset = await runGit(['config', '--unset-all', key], { cwd: root, timeout: 5_000 });
  const after = await runGit(['config', '--show-origin', '--get-all', key], {
    cwd: root,
    stderr: 'ignore',
    timeout: 5_000,
  });
  // Gone is gone, whichever exit code got us here.
  if (after.exitCode !== 0 || !after.stdout.trim()) return null;

  const origin = after.stdout.trim().split('\n')[0]?.split(/\s+/)[0] ?? 'an unknown config file';
  const stderr = unset.stderr.trim().split('\n')[0];
  return (
    `${key} is still set in ${origin}` +
    (stderr ? ` (${stderr})` : '') +
    ` — remove it there, e.g. \`git config --global --unset-all ${key}\``
  );
}


export async function commandDoctorResumeInterrupted(
  root: string,
  opts: RemedyOptions,
): Promise<void> {
  const resumable = await withDoctorStorage(root, findResumableTasks);

  if (resumable.length === 0) {
    console.log('No interrupted tasks — nothing to resume.');
    return;
  }

  console.log(`${resumable.length} interrupted task(s):\n`);
  for (const t of resumable) {
    console.log(`  ${theme.taskId(t.taskCode)}${t.runName ? ` (last run ${t.runName})` : ''}`);
  }
  console.log('');
  // Precisely what the reconciler promises, and no more: it RE-OFFERS the
  // resume every tick, and the same gates that vetoed it can veto again
  // (`resumeStrandedInterruptedTasks` in src/utils/reconcile.ts). Saying
  // flatly "the daemon resumes these on its own" would be false for a stopped
  // task or one the circuit breaker is holding — which is the case this flag
  // exists for, so overclaiming here hides the flag's only real use.
  console.log(theme.separator(
    '  A running daemon re-offers these each tick; a `lazy stop`, the interruption',
  ));
  console.log(theme.separator(
    '  circuit breaker or the auto-react budget can veto it. This starts them now.',
  ));
  console.log('');

  if (opts.dryRun) {
    console.log(`Dry run — nothing resumed. Drop ${theme.command('--dry-run')} to apply.`);
    return;
  }
  if (!(await confirmRemedy(`Resume ${resumable.length} task(s) now?`, opts.yes))) {
    console.log('Aborted — nothing was resumed.');
    return;
  }

  const { createPhaseDisplay } = await import('../phase-display');
  let resumed = 0;
  for (const t of resumable) {
    // The same route `lazy resume` takes — the daemon owns starting a turn.
    // Doctor used to spawn `process.argv[0] process.argv[1] resume <task>`,
    // which in a released binary is an embedded `bun` that is not on PATH, so
    // the automatic resume failed every time with "binary 'bun' not found".
    const display = createPhaseDisplay();
    try {
      const result = await queryResumeTask({ taskId: t.taskId, ...(await usagePauseOverrideEligibility()), }, display);
      display.close();
      for (const warning of result.warnings) console.log(`  ${warning}`);
      console.log(theme.success(`  Resumed ${t.taskCode}`));
      resumed++;
    } catch (err) {
      display.close();
      console.log(
        theme.error(`  Failed to resume ${t.taskCode}: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }
  reportRemedyOutcome('Resumed', resumed, resumable.length, 'task(s)');
}

/**
 * `lazy doctor --clean-local-command-conversations` — drop Claude Code's
 * local-command scaffolding out of conversations that were stored before lazy
 * started filtering it at ingest.
 *
 * Two things about this one are not like the other remedies, and both are
 * deliberate:
 *
 *   - Deletion is a SECOND flag. By default nothing is deleted: a row left with
 *     no content at all once the scaffolding is gone is listed and left alone.
 *     `--delete-empty-local-command-conversations` opts into removing exactly
 *     those rows, and `--yes` alone never implies it — `--yes` skips a prompt,
 *     it does not choose a destructive act nobody asked for.
 *   - It reports what it would do before doing anything, on EVERY run: the
 *     listing prints first, `--dry-run` stops there, and without `--yes` a TTY
 *     must confirm (default no) while a non-TTY is told how to proceed. The
 *     rewrite and the deletion ask SEPARATELY, so approving one is never
 *     approving the other.
 *
 * The rewrite and the deletion both live in
 * `src/import/local-command-cleanup.ts`.
 */
export async function commandDoctorCleanLocalCommandConversations(
  root: string,
  opts: RemedyOptions,
): Promise<void> {
  await withDoctorStorage(root, async storage => {
    const plan = await findLocalCommandConversations(storage);

    if (plan.rewrites.length === 0 && plan.emptied.length === 0) {
      console.log(
        `No stored conversation carries local-command scaffolding ` +
        `(${plan.scanned} scanned) — nothing to clean up.`,
      );
      return;
    }

    if (plan.rewrites.length > 0) {
      console.log(
        `${plan.rewrites.length} of ${plan.scanned} stored conversation(s) carry Claude Code ` +
        `local-command scaffolding:\n`,
      );
      for (const item of plan.rewrites) {
        const started = item.startedAt ? item.startedAt.replace('T', ' ').substring(0, 16) : 'unknown         ';
        console.log(
          `  ${theme.taskId(item.sessionId.substring(0, 8))}  ${started}  ` +
          `${item.removed} scaffolding message(s)`,
        );
        console.log(`    ${theme.label('summary now:')} ${elideSummary(item.storedSummary)}`);
        console.log(`    ${theme.label('would become:')} ${elideSummary(item.cleaned!.summary)}`);
      }
      console.log('');
      console.log(theme.separator(
        '  Only the caveat, a built-in slash command and its output are dropped. Every',
      ));
      console.log(theme.separator(
        '  other message is kept, and token totals are unchanged.',
      ));
      console.log('');
    }

    // Listed on every run, deleted only when the second flag asks for it — so a
    // human always sees the size of the question, and answers it themselves.
    if (plan.emptied.length > 0) {
      console.log(
        `${plan.emptied.length} stored conversation(s) hold NOTHING but scaffolding ` +
        `(caveat plus a built-in command):\n`,
      );
      for (const item of plan.emptied) {
        const started = item.startedAt ? item.startedAt.replace('T', ' ').substring(0, 16) : 'unknown         ';
        console.log(
          `  ${theme.taskId(item.sessionId.substring(0, 8))}  ${started}  ` +
          `${item.removed} message(s), no other content`,
        );
      }
      console.log('');
      if (opts.deleteEmpty) {
        console.log(theme.warning(
          '  These would be DELETED from the store. Deleting a conversation is permanent —',
        ));
        console.log(theme.warning(
          '  lazy cannot restore it, and a deleted row whose raw Claude JSONL is still on disk',
        ));
        console.log(theme.warning(
          `  is NOT brought back by ${theme.command('lazy doctor --reimport-conversations')}: today's reader`,
        ));
        console.log(theme.warning(
          '  drops the session as empty.',
        ));
      } else {
        console.log(theme.separator(
          `  These are left exactly as they are. Add ` +
          `${theme.command('--delete-empty-local-command-conversations')}`,
        ));
        console.log(theme.separator('  to delete them instead.'));
      }
      console.log('');
    }

    const deleting = opts.deleteEmpty === true && plan.emptied.length > 0;

    if (plan.rewrites.length === 0 && !deleting) {
      console.log('Nothing to rewrite — no conversation would gain a real summary.');
      return;
    }

    if (opts.dryRun) {
      console.log(`Dry run — nothing changed. Drop ${theme.command('--dry-run')} to apply.`);
      return;
    }

    if (plan.rewrites.length > 0) {
      if (!(await confirmRemedy(`Clean ${plan.rewrites.length} conversation(s)?`, opts.yes))) {
        console.log('Aborted — nothing was changed.');
        return;
      }

      const { rewritten, errors } = await applyLocalCommandCleanup(storage, plan, item => {
        console.log(
          theme.success(`  Cleaned ${item.sessionId.substring(0, 8)}`) +
          ` — ${elideSummary(item.cleaned!.summary)}`,
        );
      });
      for (const { sessionId, error } of errors) {
        console.log(theme.error(`  Failed to clean ${sessionId.substring(0, 8)}: ${error.message}`));
      }
      reportRemedyOutcome('Cleaned', rewritten, plan.rewrites.length, 'conversation(s)');
    }

    if (!deleting) return;

    // A separate question from the rewrite above, asked even when `--yes` was
    // already answered for that one is not enough on its own: `--yes` skips the
    // prompt, the opt-in flag is what chose deletion. Without either, a TTY is
    // asked (default no) and a non-TTY is told how to proceed — it refuses.
    console.log('');
    if (!(await confirmRemedy(
      `Delete ${plan.emptied.length} content-free conversation(s) from the store?`,
      opts.yes,
    ))) {
      console.log('Aborted — nothing was deleted.');
      return;
    }

    const { deleted, alreadyGone, errors } = await deleteEmptiedConversations(storage, plan, item => {
      console.log(theme.success(`  Deleted ${item.sessionId.substring(0, 8)}`));
    });
    for (const { sessionId, error } of errors) {
      console.log(theme.error(`  Failed to delete ${sessionId.substring(0, 8)}: ${error.message}`));
    }
    console.log('');
    console.log(
      `Deleted ${deleted} of ${plan.emptied.length} content-free conversation(s)` +
      (alreadyGone > 0 ? ` (${alreadyGone} already gone)` : '') + '.',
    );
    if (deleted + alreadyGone < plan.emptied.length) process.exitCode = 1;
  });
}
