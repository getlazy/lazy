/**
 * `lazy system repair-commits` — fix recorded commit lists that name commits
 * the task never made.
 *
 * A historical range bug recorded an upstream branch's history against any
 * task that merged it, and compounded turn by turn, so some tasks carry
 * hundreds of other people's commits. The recording path only ever adds, so
 * those lists do not heal on their own. This is the deliberate, visible repair
 * — it reports by default and changes nothing until `--apply`.
 */

import { requireLazyRoot, parseFlags } from '../helpers';
import { isTTY, promptYesNo } from '../editor';
import { repairCommits } from '../../daemon/rpc-fallback';
import { createPhaseDisplay } from '../phase-display';
import { theme, dim } from '../../render/theme';
import type { CommitRepairEntry, CommitRepairResult, ConfirmedRepair } from '../../daemon/repair-commits';

export async function commandSystemRepairCommits(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'all', takesValue: false },
    { name: 'apply', takesValue: false },
    { name: 'json', takesValue: false },
    { name: 'yes', aliases: ['y'], takesValue: false },
  ], 'system repair-commits');

  requireLazyRoot();

  const taskId = parsed.positional[0];
  const all = parsed.flags.get('all') === true;
  const apply = parsed.flags.get('apply') === true;
  const json = parsed.flags.get('json') === true;
  const yes = parsed.flags.get('yes') === true;

  if (!taskId && !all) {
    console.error('Error: name a task, or pass --all to scan every task.');
    console.error('       lazy system repair-commits <task>');
    console.error('       lazy system repair-commits --all');
    process.exit(1);
  }

  // A sweep is hundreds of tasks and several git spawns each, so it narrates
  // while it runs. Under --json the narration goes to STDERR: stdout is the
  // machine-readable payload and nothing else may share it.
  const display = createPhaseDisplay({ stream: json ? 'stderr' : 'stdout' });

  // Always PLAN first, even when applying: the human sees what is about to
  // change before anything is written, and `--apply` without a TTY still has
  // to say `--yes`.
  const plan = await repairCommits({ taskId, all, apply: false }, display);

  display.close();

  if (json && !apply) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const actionable = plan.entries.filter(e => !e.skipped && (e.remove.length > 0 || e.add.length > 0));
  const skipped = plan.entries.filter(e => e.skipped);

  // What the human is about to approve, handed back to the apply so it re-plans
  // exactly these tasks instead of sweeping the store again. The apply still
  // re-runs every refusal against the branch as it is then — this narrows the
  // work, never the safety.
  const confirm: ConfirmedRepair[] = actionable.map(e => ({
    taskId: e.taskId,
    remove: e.remove.map(r => r.sha),
  }));

  // Under --json the ONLY thing on stdout may be the JSON object, so the
  // human plan is not rendered and a confirmation is never prompted for:
  // a scripted repair that has to answer a question is a hung script.
  if (json) {
    if (actionable.length > 0 && !yes) {
      console.error('Error: --apply --json needs --yes (there is nobody to confirm with when the output is machine-readable).');
      process.exit(1);
    }
    const applied = await repairCommits({ taskId, all, apply: true, confirm }, display);
    display.close();
    console.log(JSON.stringify(mergeApplied(plan, applied), null, 2));
    return;
  }

  printPlan(plan.entries);

  if (actionable.length === 0) {
    console.log(skipped.length > 0
      ? 'Nothing to repair. Some tasks could not be checked (see above).'
      : 'Nothing to repair — every commit list matches its branch.');
    return;
  }

  if (!apply) {
    console.log('');
    console.log(`Re-run with ${theme.command('--apply')} to write these changes.`);
    return;
  }

  const totalRemove = actionable.reduce((n, e) => n + e.remove.length, 0);
  const totalAdd = actionable.reduce((n, e) => n + e.add.length, 0);

  if (!yes) {
    if (!isTTY()) {
      console.error('Error: --apply needs --yes when there is no terminal to confirm at.');
      process.exit(1);
    }
    const ok = await promptYesNo(
      `Remove ${totalRemove} commit record(s) and add ${totalAdd} across ${actionable.length} task(s)?`,
      false,
    );
    if (!ok) {
      console.log('Cancelled — nothing was changed.');
      return;
    }
  }

  const result = await repairCommits({ taskId, all, apply: true, confirm }, display);
  display.close();

  // Report what the APPLY did, not what the plan predicted. The apply re-plans
  // the confirmed tasks against the branch as it is then, so a turn landing a
  // commit in between makes the plan's numbers a description of something that
  // never happened.
  const written = result.entries.filter(e => !e.skipped);
  const wroteRemove = written.reduce((n, e) => n + e.remove.length, 0);
  const wroteAdd = written.reduce((n, e) => n + e.add.length, 0);
  console.log(`Repaired ${written.length} task(s): -${wroteRemove} / +${wroteAdd} commit records.`);
  if (wroteRemove !== totalRemove || wroteAdd !== totalAdd) {
    console.log(dim(`(The plan you confirmed said -${totalRemove} / +${totalAdd}; the branch moved in between.)`));
  }
}

/**
 * The machine-readable answer to "what happened", in the plan's order.
 *
 * The apply is handed only the tasks the human confirmed, so its own entry list
 * covers just those. Reporting it alone would drop every task the plan reported
 * as SKIPPED — with the reason it could not be repaired — and every one it
 * reported as clean, leaving a script unable to tell "nothing was wrong" from
 * "five tasks were refused". So the confirmed tasks are replaced by what the
 * apply actually did, and everything else is carried through from the plan.
 *
 * Those carried-through entries describe the PLAN pass, which is the honest
 * reading: the apply deliberately did not re-scan them, and nothing was written
 * to them either.
 */
function mergeApplied(plan: CommitRepairResult, applied: CommitRepairResult): CommitRepairResult {
  const byTask = new Map(applied.entries.map(e => [e.taskId, e]));
  const entries = plan.entries.map(e => byTask.get(e.taskId) ?? e);
  // A task the apply reported that the plan did not is not expected (the
  // confirm list is built from the plan), but dropping one would be silent.
  const seen = new Set(plan.entries.map(e => e.taskId));
  for (const e of applied.entries) {
    if (!seen.has(e.taskId)) entries.push(e);
  }
  return { applied: applied.applied, entries };
}

function printPlan(entries: CommitRepairEntry[]): void {
  for (const entry of entries) {
    const label = theme.taskId(entry.code ?? entry.taskId.substring(0, 8));
    if (entry.skipped) {
      console.log(`  ${label}  skipped — ${entry.skipped} (${entry.recorded} record(s) left as they are)`);
      continue;
    }
    if (entry.remove.length === 0 && entry.add.length === 0) {
      console.log(`  ${label}  ok — ${entry.recorded} record(s) match the branch`);
      continue;
    }
    console.log(
      `  ${label}  ${entry.recorded} recorded → ${entry.correct} on the branch ` +
      `(-${entry.remove.length} / +${entry.add.length})`,
    );

    // Removal is the irreversible half, so it is itemised: approving a
    // deletion from a bare count is not reviewing it. Adds stay counted —
    // they are recoverable by re-running, and the branch is their source.
    for (const r of entry.remove.slice(0, REMOVALS_SHOWN)) {
      console.log(`      ${dim('-')} ${dim(r.sha.substring(0, 8))} ${firstLine(r.message)}`);
    }
    if (entry.remove.length > REMOVALS_SHOWN) {
      console.log(dim(`      … and ${entry.remove.length - REMOVALS_SHOWN} more (--json lists them all)`));
    }
  }
}

/**
 * How many removals to itemise per task before deferring to `--json`.
 *
 * The tasks this repairs carry hundreds of bad records, and a wall of them
 * scrolls the summary — and the decision — off the screen.
 */
const REMOVALS_SHOWN = 10;

function firstLine(message: string): string {
  const line = message.split('\n')[0] ?? '';
  return line.length > 72 ? `${line.substring(0, 71)}…` : line;
}

export function systemRepairCommitsUsage(): void {
  console.log(`Usage: lazy system repair-commits <task> [--apply]
       lazy system repair-commits --all [--apply]

Fix recorded commit lists that name commits the task never made.

A task's recorded commits should be the commits its own branch carries. An
older version of lazy also recorded everything a merged-in upstream branch
brought with it, which on long-running tasks grew into hundreds of unrelated
commits in \`lazy show\`, the web Commits tab and search. New turns record
correctly; this repairs what is already stored.

Reports by default and changes nothing. Pass --apply to write the repair.

Options:
  --all        Scan every task instead of one
  --apply      Write the repair (asks for confirmation)
  --yes, -y    Skip the confirmation (required with --apply when non-interactive)
  --json       Machine-readable output

Examples:
  lazy system repair-commits my-task           # What is wrong with this one?
  lazy system repair-commits --all             # What is wrong anywhere?
  lazy system repair-commits --all --apply     # Fix it`);
}
