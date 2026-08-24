/**
 * `lazy doctor <task-id>` — task-level diagnostics and repair.
 *
 * Runs checks on a specific task: stale parent, missing branch/worktree,
 * local/remote divergence, status mismatch, orphaned worktree. Reports
 * findings and offers interactive fixes.
 *
 * It then runs `lazy-agent doctor` INSIDE the task's container and passes that
 * output straight through. Everything above is diagnosable from the host; the
 * agent's MCP wiring is not — the config it was launched with, its tool
 * permissions and its route back to the daemon all live inside the container,
 * and some are rewritten per turn. Making the human find the container name and
 * type `docker exec` themselves is the difference between a diagnosis they run
 * and one they don't.
 */

import { existsSync } from 'fs';
import { parkTaskPaused } from '../../utils/paused-status';
import { getActor } from '../../constants';
import type { Task, Session } from '../../types';
import type { Storage } from '../../storage';
import { isTerminalStatus } from '../../task-state-machine';
import { parentTaskIdOf, targetBranchOf, taskTarget, branchTarget } from '../../task-target';
import { theme } from '../theme';
import {
  displayId,
  shortId,
  getWorktreePath,
  resolveTaskOrExit,
  requireLazyRoot,
  requireStorage,
  taskRef,
} from '../helpers';
import { promptYesNo, isTTY } from '../editor';
import {
  localBranchExists,
  branchExists,
  recoverMissingWorktree,
} from '../../git/operations';
import { runGit } from '../../utils/git';
import { createRunner } from '../../runner';
import type { Runner } from '../../runner';

// ── types ────────────────────────────────────────────────────────────────

export interface TaskCheckResult {
  ok: boolean;
  label: string;
  detail?: string;
  fix?: () => Promise<void>;
}

// ── individual checks ────────────────────────────────────────────────────

/**
 * Check 1: Parent task is complete/abandoned/closed but child still points to it.
 */
async function checkStaleParent(
  task: Task,
  storage: Storage,
  root: string,
): Promise<TaskCheckResult> {
  const parentId = parentTaskIdOf(task);
  if (!parentId) {
    return { ok: true, label: 'Parent: none (top-level task)' };
  }

  const parent = await storage.getTask(parentId);
  if (!parent) {
    return { ok: true, label: 'Parent: not found (may have been deleted)' };
  }

  if (!isTerminalStatus(parent.status)) {
    return { ok: true, label: `Parent: ${displayId(parent)} (${parent.status})` };
  }

  // Parent is terminal — reparent to the grandparent (stack on it) or, if the
  // parent was top-level, to the branch it integrated into (the resolver will
  // heal a stale branch on the next sync).
  const grandparentId = parentTaskIdOf(parent);
  const newTarget = grandparentId
    ? taskTarget(grandparentId)
    : branchTarget(targetBranchOf(parent) ?? 'main');
  const newParentLabel = grandparentId
    ? (await storage.getTask(grandparentId))?.code ?? shortId(grandparentId)
    : `none (top-level, ${newTarget.kind === 'branch' ? newTarget.branch : ''})`;

  return {
    ok: false,
    label: `Stale parent: ${displayId(parent)} is ${parent.status}`,
    detail: `    → Reparent to ${newParentLabel}?`,
    fix: async () => {
      await storage.updateTaskTarget(task.id, newTarget);
      console.log(theme.success(`    Reparented to ${newParentLabel}`));
    },
  };
}

/**
 * Check 2: Task has a session with git_branch but the local branch doesn't exist.
 */
async function checkMissingBranch(
  task: Task,
  session: Session | null,
  root: string,
): Promise<TaskCheckResult> {
  if (!session?.git_branch) {
    return { ok: true, label: 'Branch: no session (not started)' };
  }

  const branch = session.git_branch;

  if (await localBranchExists(branch, root)) {
    return { ok: true, label: `Branch: ${branch} exists locally` };
  }

  // Check if remote branch exists
  const remoteBranch = `origin/${branch}`;
  const remoteExists = await branchExists(remoteBranch, root);

  if (remoteExists) {
    return {
      ok: false,
      label: `Missing local branch: ${branch}`,
      detail: `    Remote branch ${remoteBranch} exists`,
      fix: async () => {
        const result = await runGit(['branch', branch, remoteBranch], { cwd: root });
        if (result.exitCode !== 0) {
          console.log(theme.error(`    Failed to create branch: ${result.stderr.trim()}`));
          return;
        }
        console.log(theme.success(`    Created local branch ${branch} from ${remoteBranch}`));
      },
    };
  }

  return {
    ok: false,
    label: `Missing local branch: ${branch}`,
    detail: '    Branch not found locally or on remote. Cannot recover.',
  };
}

/**
 * Check 3: Task is non-terminal with a session but worktree directory doesn't exist.
 */
async function checkMissingWorktree(
  task: Task,
  session: Session | null,
  root: string,
): Promise<TaskCheckResult> {
  if (isTerminalStatus(task.status)) {
    return { ok: true, label: 'Worktree: task is terminal (not needed)' };
  }

  if (!session?.git_branch) {
    return { ok: true, label: 'Worktree: no session (not started)' };
  }

  const worktreePath = getWorktreePath(root, task);
  if (existsSync(worktreePath)) {
    return { ok: true, label: `Worktree: ${worktreePath} exists` };
  }

  const branch = session.git_branch;
  const hasBranch = await branchExists(branch, root);
  const remoteBranch = `origin/${branch}`;
  const hasRemote = !hasBranch && await branchExists(remoteBranch, root);

  const source = hasBranch ? branch : hasRemote ? remoteBranch : null;

  if (!source) {
    return {
      ok: false,
      label: `Missing worktree: ${worktreePath}`,
      detail: '    Branch not found locally or on remote. Cannot recreate.',
    };
  }

  return {
    ok: false,
    label: `Missing worktree: ${worktreePath}`,
    detail: `    Branch ${source} exists\n    → Recreate worktree?`,
    fix: async () => {
      // If branch is remote-only, create local branch first
      if (!hasBranch && hasRemote) {
        const branchResult = await runGit(['branch', branch, remoteBranch], { cwd: root });
        if (branchResult.exitCode !== 0) {
          console.log(theme.error(`    Failed to create local branch: ${branchResult.stderr.trim()}`));
          return;
        }
      }

      const result = await recoverMissingWorktree(worktreePath, branch, root);
      if (result.recovered) {
        console.log(theme.success(`    Recreated worktree at ${worktreePath}`));
      } else {
        console.log(theme.error('    Failed to recreate worktree'));
      }
    },
  };
}

/**
 * Check 4: Local and remote branch tips don't match.
 */
async function checkBranchDivergence(
  task: Task,
  session: Session | null,
  root: string,
): Promise<TaskCheckResult> {
  if (!session?.git_branch) {
    return { ok: true, label: 'Divergence: no session (not started)' };
  }

  const branch = session.git_branch;

  // Both local and remote must exist for this check
  if (!(await localBranchExists(branch, root))) {
    return { ok: true, label: 'Divergence: no local branch (checked separately)' };
  }

  const remoteBranch = `origin/${branch}`;
  if (!(await branchExists(remoteBranch, root))) {
    return { ok: true, label: 'Divergence: no remote branch (local only)' };
  }

  // Count commits ahead and behind
  const aheadResult = await runGit(
    ['rev-list', '--count', `${remoteBranch}..${branch}`],
    { cwd: root },
  );
  const behindResult = await runGit(
    ['rev-list', '--count', `${branch}..${remoteBranch}`],
    { cwd: root },
  );

  if (aheadResult.exitCode !== 0 || behindResult.exitCode !== 0) {
    return { ok: true, label: 'Divergence: could not compare branches' };
  }

  const ahead = parseInt(aheadResult.stdout.trim(), 10);
  const behind = parseInt(behindResult.stdout.trim(), 10);

  if (ahead === 0 && behind === 0) {
    return { ok: true, label: 'Branch: local and remote in sync' };
  }

  if (ahead > 0 && behind > 0) {
    return {
      ok: false,
      label: `Branch diverged: ${ahead} ahead, ${behind} behind remote`,
      detail: '    Local and remote have diverged. Manual resolution needed.',
    };
  }

  if (behind > 0) {
    return {
      ok: false,
      label: `Branch: ${behind} commit(s) behind remote`,
      detail: `    → Fast-forward local branch?`,
      fix: async () => {
        // Fast-forward the local branch to match remote
        const worktreePath = getWorktreePath(root, task);
        const cwd = existsSync(worktreePath) ? worktreePath : root;

        // If we're in the worktree, we can just pull
        if (existsSync(worktreePath)) {
          const result = await runGit(['merge', '--ff-only', remoteBranch], { cwd: worktreePath });
          if (result.exitCode !== 0) {
            console.log(theme.error(`    Fast-forward failed: ${result.stderr.trim()}`));
            return;
          }
        } else {
          // Update branch ref directly
          const result = await runGit(['update-ref', `refs/heads/${branch}`, remoteBranch], { cwd: root });
          if (result.exitCode !== 0) {
            console.log(theme.error(`    Failed to update branch: ${result.stderr.trim()}`));
            return;
          }
        }
        console.log(theme.success(`    Fast-forwarded local branch to match remote`));
      },
    };
  }

  // ahead > 0 && behind === 0
  return {
    ok: false,
    label: `Branch: ${ahead} commit(s) ahead of remote`,
    detail: '    Local has unpushed commits. Push will happen on next sync.',
  };
}

/**
 * Check 5: Task has completed work but status doesn't reflect it.
 */
async function checkStatusMismatch(
  task: Task,
  session: Session | null,
  storage: Storage,
): Promise<TaskCheckResult> {
  if (task.status !== 'backlog') {
    return { ok: true, label: `Status: ${task.status} (consistent)` };
  }

  if (!session) {
    return { ok: true, label: `Status: backlog (no session — consistent)` };
  }

  // Count turns and commits
  const turns = await storage.getSessionTurns(session.id);
  const commits = await storage.getSessionCommits(session.id);

  if (turns.length === 0 && commits.length === 0) {
    return { ok: true, label: `Status: backlog (no work done — consistent)` };
  }

  return {
    ok: false,
    label: `Status mismatch: task has work (${commits.length} commits, ${turns.length} turns) but status is 'backlog'`,
    detail: '    → Transition to blocked for review?',
    fix: async () => {
      // Must go through valid transitions: backlog → working → blocked/conflict.
      // The paused label is DERIVED from the pending violation set — see
      // src/utils/paused-status.ts (fix-ask-nukes-violations).
      await storage.updateTaskStatus(task.id, 'working');
      const parked = await parkTaskPaused(storage, task.id, getActor());
      console.log(theme.success(`    Status updated to ${parked}`));
    },
  };
}

/**
 * Check 6: Worktree exists but git doesn't know about it, or its branch is gone.
 */
async function checkOrphanedWorktree(
  task: Task,
  session: Session | null,
  root: string,
): Promise<TaskCheckResult> {
  const worktreePath = getWorktreePath(root, task);

  if (!existsSync(worktreePath)) {
    return { ok: true, label: 'Orphaned worktree: none (directory absent)' };
  }

  // Check if git knows about this worktree
  const listResult = await runGit(['worktree', 'list', '--porcelain'], { cwd: root });
  if (listResult.exitCode !== 0) {
    return { ok: true, label: 'Orphaned worktree: could not list worktrees' };
  }

  const registeredWorktrees = listResult.stdout
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.replace('worktree ', ''));

  const isRegistered = registeredWorktrees.some(
    wt => wt === worktreePath || worktreePath.startsWith(wt) || wt.startsWith(worktreePath),
  );

  if (isRegistered) {
    // Worktree is registered — check if its branch still exists
    if (session?.git_branch) {
      const hasBranch = await branchExists(session.git_branch, root);
      if (!hasBranch) {
        return {
          ok: false,
          label: `Orphaned worktree: branch ${session.git_branch} no longer exists`,
          detail: '    Worktree is registered but its branch is gone.\n    → Remove worktree?',
          fix: async () => {
            const result = await runGit(['worktree', 'remove', '--force', worktreePath], { cwd: root });
            if (result.exitCode !== 0) {
              console.log(theme.error(`    Failed to remove worktree: ${result.stderr.trim()}`));
              return;
            }
            console.log(theme.success(`    Removed orphaned worktree`));
          },
        };
      }
    }
    return { ok: true, label: 'Worktree: registered and healthy' };
  }

  // Worktree directory exists but git doesn't know about it
  return {
    ok: false,
    label: 'Orphaned worktree: directory exists but not registered in git',
    detail: `    → Prune and re-register?`,
    fix: async () => {
      // Prune stale entries first
      await runGit(['worktree', 'prune'], { cwd: root });

      // Try to re-add if branch exists
      if (session?.git_branch && await branchExists(session.git_branch, root)) {
        // Remove the directory first — git worktree add requires it to not exist
        const { rmSync } = await import('fs');
        rmSync(worktreePath, { recursive: true, force: true });

        const result = await runGit(
          ['worktree', 'add', worktreePath, session.git_branch],
          { cwd: root },
        );
        if (result.exitCode !== 0) {
          console.log(theme.error(`    Failed to re-register worktree: ${result.stderr.trim()}`));
          return;
        }
        console.log(theme.success('    Re-registered worktree'));
      } else {
        // No branch — just clean up the directory
        const { rmSync } = await import('fs');
        rmSync(worktreePath, { recursive: true, force: true });
        console.log(theme.success('    Removed orphaned worktree directory'));
      }
    },
  };
}

// ── in-container diagnostics ─────────────────────────────────────────────

/**
 * Run `lazy-agent doctor` inside the task's run and pass its output through
 * verbatim.
 *
 * Returns true if it ran and every in-container check passed; false if it ran
 * and something failed. A state where the question cannot be asked at all — no
 * run, a stopped run, a runner with no inside — is neither: it prints why and
 * returns null, because "we could not look" must never read as "we looked and
 * it was fine". Same rule the in-container doctor applies to its own
 * inconclusive checks.
 */
async function runContainerDoctor(
  task: Task,
  session: Session | null,
  root: string,
  opts: { probeAgent: boolean },
): Promise<boolean | null> {
  const skip = (reason: string, hint?: string): null => {
    console.log(theme.warning(`! Agent container diagnostics: skipped`));
    console.log(`    ${reason}`);
    if (hint) console.log(`    ${hint}`);
    return null;
  };

  let runner: Runner;
  try {
    runner = await createRunner(root);
  } catch (err) {
    // A daemon that is down (or that lost its proxy) is exactly what this
    // looks like. It is a real thing to report, but it is not a verdict on the
    // container — and it must not abort the task checks that already ran.
    return skip(err instanceof Error ? err.message : String(err));
  }

  // Asked before the run lookup so the answer is the real reason ("this runner
  // has no inside") rather than the incidental one ("no process found"). The
  // null branch further down stays as the honest fallback for any other runner
  // that cannot be entered.
  const noInside = `The ${runner.type} runner has no container to enter — this task's agent runs as a process on this machine.`;
  const noInsideHint = `Its MCP config and permissions are in this machine's own HOME, so ${theme.command('lazy doctor')} already covers them.`;
  if (runner.type === 'dangerously-host-process-without-any-isolation') {
    return skip(noInside, noInsideHint);
  }

  const runName = session?.container_name ?? runner.runNameForTask(taskRef(task));
  let info;
  try {
    info = await runner.getRunInfo(runName);
  } catch (err) {
    // Asking the runner about a run can fail for reasons that say nothing about
    // this task — the docker binary is not installed, the daemon socket is
    // gone. Report it as what it is rather than as a task defect.
    return skip(
      `Could not ask the ${runner.type} runner about ${runName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!info) {
    return skip(
      `No ${runner.runLabel.toLowerCase()} found for this task (${runName}).`,
      `The agent only exists while a turn is running. Start one with ${theme.command(`lazy start ${displayId(task)}`)}, then run this again.`,
    );
  }
  if (!info.running) {
    return skip(
      `${runner.runDisplayName(runName)} exists but is not running (exit code ${info.exitCode}).`,
      `MCP wiring can only be inspected in a live run — the config is written per turn.`,
    );
  }

  const argv = ['lazy-agent', 'doctor', ...(opts.probeAgent ? ['--probe-agent'] : [])];

  // The exec streams straight to this terminal, so the header has to go out
  // before it rather than after the result is known.
  console.log(
    theme.label(`Agent container diagnostics — ${argv.join(' ')} in ${runner.runDisplayName(runName)}:`),
  );
  console.log('');

  const exitCode = await runner.execInRun(runName, argv);
  if (exitCode === null) {
    return skip(noInside, noInsideHint);
  }

  console.log('');
  return exitCode === 0;
}

// ── main ─────────────────────────────────────────────────────────────────

export async function commandDoctorTask(
  taskInput: string,
  flags: { dryRun: boolean; yes: boolean; probeAgent?: boolean },
): Promise<void> {
  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    const task = await resolveTaskOrExit(storage, taskInput);
    const session = await storage.getSessionByTaskId(task.id);

    console.log(`Diagnosing task ${theme.taskId(displayId(task))} (${shortId(task.id)})...\n`);

    // Run all checks
    const results: TaskCheckResult[] = [];

    results.push(await checkStaleParent(task, storage, root));
    results.push(await checkMissingBranch(task, session, root));
    results.push(await checkMissingWorktree(task, session, root));
    results.push(await checkBranchDivergence(task, session, root));
    results.push(await checkStatusMismatch(task, session, storage));
    results.push(await checkOrphanedWorktree(task, session, root));

    // Display results and offer fixes
    let issueCount = 0;
    let fixedCount = 0;

    for (const r of results) {
      if (r.ok) {
        console.log(theme.success(`✓ ${r.label}`));
      } else {
        issueCount++;
        console.log(theme.warning(`! ${r.label}`));
        if (r.detail) {
          console.log(r.detail);
        }

        if (r.fix && !flags.dryRun) {
          let shouldFix = flags.yes;
          if (!shouldFix && isTTY()) {
            shouldFix = await promptYesNo('    Apply fix?');
          }
          if (shouldFix) {
            await r.fix();
            fixedCount++;
          }
        }
        console.log('');
      }
    }

    // The agent's own view, from inside. Runs last because it prints a whole
    // report rather than one line, and because it is the only check that can be
    // legitimately unanswerable — a task with no live turn has no container.
    const containerOk = await runContainerDoctor(task, session, root, {
      probeAgent: flags.probeAgent === true,
    });
    if (containerOk === false) {
      // Counted as an issue with no fix, so `lazy doctor <task>` exits non-zero:
      // the in-container doctor already printed what failed and how to fix it,
      // and re-summarizing it here would only paraphrase it worse.
      issueCount++;
    }

    // Summary
    console.log('');
    if (issueCount === 0) {
      console.log(theme.success('No issues found.'));
    } else if (flags.dryRun) {
      console.log(`${issueCount} issue${issueCount > 1 ? 's' : ''} found (dry run — no fixes applied).`);
    } else {
      console.log(`${issueCount} issue${issueCount > 1 ? 's' : ''} found, ${fixedCount} fixed.`);
    }

    if (issueCount > 0 && fixedCount < issueCount) {
      process.exit(1);
    }
  } finally {
    await storage.close();
  }
}
