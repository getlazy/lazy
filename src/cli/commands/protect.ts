/**
 * `lazy protect <branch|task> on|off` — the single CLI for branch protection.
 *
 * ONE STORE: every protection setting lives in the `[protection]` section of
 * lazy.toml. There is no parallel per-task store — a protected task is a task
 * code in `[protection].protected_tasks`, sitting next to
 * `protected_branches`, readable and editable by hand. This command is just a
 * safe editor for that section (see src/config/toml-edit.ts for what the
 * comment-preserving editing can and cannot do).
 *
 * TWO DIRECTIONS, one verb, because the engineer thinks in tasks as often as
 * in branches:
 *   - a BRANCH is protected against merges coming IN  (incoming)
 *   - a TASK  is protected against its work going OUT (outgoing) — merging its
 *     branch upward needs approval whatever the target
 *
 * CLI-only on purpose: there is no MCP equivalent for writing, so the builder
 * cannot arrange its own gates. Reading the state is harmless; changing it is
 * a human act, like `lazy approve`.
 */

import { readFile, writeFile } from 'fs/promises';
import { requireLazyRoot, requireStorage, parseFlags, shortId, displayId } from '../helpers';
import { loadConfig, resolveConfigPath } from '../../config/loader';
import { setSectionStringArray, setSectionBoolean, TomlEditError } from '../../config/toml-edit';
import { branchExists, getRemoteDefaultBranch } from '../../git/operations';
import { theme } from '../theme';
import type { Storage } from '../../storage';
import type { Task } from '../../types';

type Target =
  | { kind: 'branch'; branch: string }
  | { kind: 'task'; task: Task; listedAs: string };

/**
 * Storage is acquired only when a task actually has to be resolved. Editing a
 * BRANCH entry, or listing a project with no protected tasks, is pure config
 * work — requiring a running daemon for it would be gratuitous friction on a
 * command whose whole job is editing a text file.
 */
function lazyStorage(): () => Promise<Storage> {
  let cached: Promise<Storage> | null = null;
  return () => (cached ??= requireStorage());
}

export async function commandProtect(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'branch', takesValue: false },
    { name: 'task', takesValue: false },
  ], 'protect');

  if (parsed.flags.get('branch') && parsed.flags.get('task')) {
    console.error('Error: --branch and --task are mutually exclusive.');
    process.exit(1);
  }

  const target = parsed.positional[0];
  const action = parsed.positional[1];

  // No arguments: report the current protection state.
  if (!target) {
    await showProtectionState();
    return;
  }

  if (action !== 'on' && action !== 'off') {
    console.error(
      action
        ? `Error: unknown action '${action}' — expected 'on' or 'off'.`
        : `Error: missing action — say what to do: lazy protect ${target} on|off`,
    );
    process.exit(1);
  }

  await setProtection(target, action === 'on', {
    forceBranch: parsed.flags.get('branch') === true,
    forceTask: parsed.flags.get('task') === true,
  });
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a target the way `lazy_create --parent` does: TASK FIRST (code or
 * short id), then branch name. The engineer types a task code far more often
 * than a branch name, and a task code that also names a branch is reported
 * rather than guessed at — `--branch`/`--task` settle it explicitly.
 */
async function resolveTarget(
  getStorage: () => Promise<Storage>,
  input: string,
  opts: { forceBranch: boolean; forceTask: boolean },
  projectRoot: string,
): Promise<Target> {
  if (opts.forceBranch) return { kind: 'branch', branch: input };

  const match = await (await getStorage()).resolveTask(input);
  if (match.ambiguousMatches && match.ambiguousMatches.length > 0) {
    console.error(`Error: '${input}' matches ${match.ambiguousMatches.length} tasks:`);
    for (const t of match.ambiguousMatches) {
      console.error(`  ${shortId(t.id)}  ${t.code ?? '-'}  ${t.goal}`);
    }
    console.error('\nUse a full task id, or --branch to protect a branch of that name.');
    process.exit(1);
  }

  if (!match.task) {
    if (opts.forceTask) {
      console.error(`Error: no task matches '${input}'.`);
      console.error('Drop --task to protect a branch of that name instead.');
      process.exit(1);
    }
    return { kind: 'branch', branch: input };
  }

  // A task matched. Say so out loud when a branch of the same name also
  // exists — silently picking one of two real things is exactly the kind of
  // guess that erodes trust.
  if (!opts.forceTask && (await branchExists(input, projectRoot))) {
    console.log(
      theme.warning(`Note: '${input}' matches both a task and a branch — protecting the TASK.`),
    );
    console.log(`      Use ${theme.command(`lazy protect --branch ${input} …`)} to protect the branch instead.\n`);
  }

  return { kind: 'task', task: match.task, listedAs: match.task.code ?? shortId(match.task.id) };
}

// ---------------------------------------------------------------------------
// on / off
// ---------------------------------------------------------------------------

async function setProtection(
  input: string,
  on: boolean,
  opts: { forceBranch: boolean; forceTask: boolean },
): Promise<void> {
  const projectRoot = requireLazyRoot();
  const getStorage = lazyStorage();
  const config = await loadConfig(projectRoot);
  const configPath = await resolveConfigPath(projectRoot);

  const target = await resolveTarget(getStorage, input, opts, projectRoot);

  const key = target.kind === 'branch' ? 'protected_branches' : 'protected_tasks';
  const value = target.kind === 'branch' ? target.branch : target.listedAs;
  const current = target.kind === 'branch'
    ? config.protection.protected_branches
    : config.protection.protected_tasks;

  // The repo default branch is protected IMPLICITLY by
  // [protection].gate_default_branch — it is gated without appearing in
  // protected_branches. Editing the list alone therefore cannot turn it off,
  // and reporting "not protected" for it would be a plain lie.
  const implicitlyGated =
    target.kind === 'branch' &&
    config.protection.enabled &&
    config.protection.gate_default_branch &&
    target.branch === (await getRemoteDefaultBranch(projectRoot, config.remote.git_remote));

  const already = current.includes(value);

  // Turning something ON also engages the master switch when it is off.
  // Protection is opt-in, so a bare list edit would otherwise be inert and
  // `lazy protect main on` — the exact command the accept hint suggests —
  // would silently protect nothing. Announced below, never silent. Turning
  // something OFF deliberately does NOT touch `enabled`: unprotecting one
  // branch is not the same act as disabling the feature.
  const engagesSwitch = on && !config.protection.enabled;

  // Already listed AND the switch is already on: genuinely nothing to do.
  if (on && already && !engagesSwitch) {
    console.log(`${describeTarget(target)} is already protected.`);
    return;
  }
  if (!on && !already) {
    if (implicitlyGated) {
      console.log(
        `${describeTarget(target)} is not listed in [protection].protected_branches, but it is ` +
        `protected as the repo default branch.`,
      );
      console.log(
        `  To unprotect it, set ${theme.command('gate_default_branch = false')} under [protection] in lazy.toml.`,
      );
      return;
    }
    console.log(`${describeTarget(target)} is not protected — nothing to change.`);
    return;
  }
  if (on && implicitlyGated) {
    // Listing it explicitly is not a no-op: the entry outlives a later
    // `gate_default_branch = false`. Say what changed and what didn't.
    console.log(
      theme.separator(`Note: \`${value}\` is already protected as the repo default branch — ` +
      `listing it keeps that gate if gate_default_branch is ever turned off.`),
    );
  }

  const next = on
    ? (already ? current : [...current, value])
    : current.filter((v) => v !== value);

  let original: string;
  try {
    original = await readFile(configPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // No lazy.toml at all — start one rather than failing. `lazy init`
      // normally writes it, but a project may have deleted or never had it.
      original = '';
    } else {
      throw new Error(
        `Failed to read ${configPath}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  let updated: string;
  try {
    updated = setSectionStringArray(original, 'protection', key, next);
    if (engagesSwitch) {
      updated = setSectionBoolean(updated, 'protection', 'enabled', true);
    }
  } catch (err) {
    if (err instanceof TomlEditError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  await writeFile(configPath, updated, 'utf-8');

  const verb = on ? 'protected' : 'unprotected';
  console.log(theme.success(`${describeTarget(target)} is now ${verb}.`));
  console.log(theme.separator(`  [protection].${key} in ${configPath}`));

  if (engagesSwitch) {
    console.log(theme.separator('  Also set `enabled = true` — branch protection is opt-in and was off.'));
  }

  if (on) {
    if (target.kind === 'branch') {
      console.log(`  Accepting a task into \`${target.branch}\` now requires ${theme.command('lazy approve <task>')}.`);
      if (!(await branchExists(target.branch, projectRoot))) {
        console.log(theme.warning(`  Note: no branch named \`${target.branch}\` exists yet — the entry takes effect when it does.`));
      }
    } else {
      const session = await (await getStorage()).getSessionByTaskId(target.task.id);
      const branch = session?.git_branch;
      console.log(
        `  Merging this task's work upward${branch ? ` (\`${branch}\`)` : ''} — into any target — ` +
        `now requires ${theme.command(`lazy approve ${target.listedAs}`)}.`,
      );
      if (!branch) {
        console.log(theme.warning('  Note: the task has no branch yet (never started) — the gate arms when it does.'));
      }
    }
  }

  warnIfGloballyDisabled(config.protection.enabled || engagesSwitch);
}

function describeTarget(target: Target): string {
  return target.kind === 'branch'
    ? `Branch \`${target.branch}\``
    : `Task ${target.listedAs}`;
}

/**
 * Reached only by `lazy protect <target> off` while protection is disabled —
 * an `on` edit engages the master switch itself, so it never lands here.
 * The list is edited either way (refusing would be surprising, and losing the
 * edit while the human flips the switch would be worse), but the change has
 * no effect yet, so say so, with the exact fix.
 */
function warnIfGloballyDisabled(enabled: boolean): void {
  if (enabled) return;
  console.log('');
  console.log(theme.warning('Warning: protection is globally disabled — this has no effect yet.'));
  console.log('  Set `enabled = true` under [protection] in lazy.toml to turn it on.');
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

async function showProtectionState(): Promise<void> {
  const projectRoot = requireLazyRoot();
  const getStorage = lazyStorage();
  const config = await loadConfig(projectRoot);
  const p = config.protection;

  // Resolved BEFORE any output: getRemoteDefaultBranch may log a warning, and
  // it would otherwise land in the middle of the table.
  const defaultBranch = p.enabled && p.gate_default_branch
    ? await getRemoteDefaultBranch(projectRoot, config.remote.git_remote)
    : null;

  console.log(theme.header('\nProtection') + theme.separator('  ([protection] in lazy.toml)'));
  console.log(
    `  ${theme.label('Status'.padEnd(18))} ${
      p.enabled
        ? theme.success('enabled')
        : theme.warning('disabled (the default) — nothing below has any effect')
    }`,
  );
  console.log(
    `  ${theme.label('Default branch'.padEnd(18))} ${
      p.gate_default_branch
        ? `protected${defaultBranch ? ` (\`${defaultBranch}\`)` : ''}`
        : 'not protected (gate_default_branch = false)'
    }`,
  );
  console.log(`  ${theme.label('Passphrase file'.padEnd(18))} ${p.passphrase_file}`);

  console.log(`\n${theme.header('Protected branches')} ${theme.separator('(merges IN need approval)')}`);
  // The default branch is gated without being listed. Show it here too, marked
  // as implicit — a human scanning this list for "what is protected" must not
  // have to remember that one entry lives in a boolean two lines up.
  if (defaultBranch) {
    console.log(`  ${defaultBranch}  ${theme.separator('(implicit — gate_default_branch)')}`);
  }
  const listedOnly = p.protected_branches.filter((b) => b !== defaultBranch);
  if (listedOnly.length === 0 && !defaultBranch) {
    console.log(theme.separator('  none'));
  } else {
    for (const branch of listedOnly) console.log(`  ${branch}`);
  }

  console.log(`\n${theme.header('Protected tasks')} ${theme.separator('(merges OUT need approval)')}`);
  if (p.protected_tasks.length === 0) {
    console.log(theme.separator('  none'));
  } else {
    for (const listedAs of p.protected_tasks) {
      // Resolve for display so a stale entry is visible as stale rather than
      // looking like an armed gate.
      const match = await (await getStorage()).resolveTask(listedAs);
      if (!match.task) {
        console.log(`  ${listedAs}  ${theme.warning('— no such task; this entry protects nothing')}`);
        continue;
      }
      const session = await (await getStorage()).getSessionByTaskId(match.task.id);
      const where = session?.git_branch
        ? theme.separator(`→ ${session.git_branch}`)
        : theme.warning('— not started yet, no branch');
      console.log(`  ${displayId(match.task)}  ${where}  ${match.task.goal}`);
    }
  }

  console.log('');
  if (!p.enabled) {
    console.log(`Turn protection on: ${theme.command('lazy protect <branch> on')} (or set ${theme.command('enabled = true')} under [protection] in lazy.toml).`);
  }
  console.log(`Change what is protected: ${theme.command('lazy protect <branch|task> on|off')}`);
  console.log('');
}

export function protectUsage(): void {
  console.log(`Usage: lazy protect [<branch|task>] [on|off] [--branch|--task]

Manage branch protection — which merges require a one-time HUMAN approval
(recorded with 'lazy approve'). All settings live in the [protection] section
of lazy.toml; this command edits that section, preserving its comments.

With no arguments, prints the current protection state.

Two directions, one verb:
  BRANCH   protects merges coming IN — accepting any task into that branch
           requires approval.
  TASK     protects that task's work going OUT — merging its branch upward
           requires approval regardless of the target branch.

<branch|task> resolves as a task code or short id FIRST, then as a branch
name. Pass --branch or --task to settle it explicitly.

Protection is opt-in — off until something turns it on. Turning any target ON
also sets [protection] enabled = true (announced, never silent), so
'lazy protect main on' is the one step from a stock project to a gated one.
Turning a target OFF never touches that switch; while protection is disabled
such an edit is saved but has no effect, and the command says so.

Arguments:
  <branch|task>  Branch name, or task code / short id
  on|off         Add or remove protection for that target

Options:
  --branch       Treat the argument as a branch name, never a task
  --task         Treat the argument as a task, never a branch

Examples:
  lazy protect                          # Show current protection state
  lazy protect release on               # Protect merges INTO 'release'
  lazy protect add-auth on              # Protect merges OUT OF task 'add-auth'
  lazy protect --branch main off        # Stop protecting the 'main' branch
  lazy protect add-auth off             # Remove the task gate

This command has no MCP equivalent on purpose: the builder must not manage
its own gates. See docs/protected-branches.md.`);
}
