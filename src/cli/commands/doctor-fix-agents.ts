/**
 * `lazy doctor --fix agents` — rewrite a pre-profile lazy.toml into the agent
 * profile form.
 *
 * The removed spellings (`[models.roles.<role>] backend/model/endpoint`, the
 * `[ollama]` block, `[proxy] openai_upstream`) fail the config load with the
 * replacement printed. This command applies it. A few real projects have the old
 * form, and hand-editing a config from an error message is exactly the kind of
 * work lazy should do for the user.
 *
 * The posture is "show, then ask": the diff is printed in full before anything
 * is written, the prompt defaults to NO, and a non-interactive run without
 * `--yes` prints the diff and writes nothing. lazy.toml is a committed file the
 * user maintains by hand — a rewrite they did not see is a rewrite they cannot
 * review.
 *
 * The planner lives in src/config/agent-migration.ts and is pure text-in /
 * text-out; this file is the human surface: read, diff, ask, write.
 */

import { readFile, writeFile } from 'fs/promises';
import { theme } from '../../render/theme';
import { isTTY, promptYesNo } from '../editor';
import { resolveConfigPath } from '../../config/loader';
import { planAgentMigration } from '../../config/agent-migration';
import { isManagedMode } from '../../config/managed-mode';

/** The single valid `--fix` target today. Unknown values are refused by name. */
export const DOCTOR_FIX_TARGETS = ['agents'] as const;

/**
 * A minimal LCS line diff, rendered in unified style without hunk headers.
 *
 * Bringing in a diff library for one command is not worth it, and lazy.toml is a
 * few hundred lines — the O(n·m) table is microseconds. Context is capped so the
 * user reads the CHANGE, not their whole config back.
 */
function renderDiff(before: string, after: string, context = 3): string[] {
  const a = before.split('\n');
  const b = after.split('\n');

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: { kind: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ kind: ' ', text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { ops.push({ kind: '-', text: a[i]! }); i++; }
    else { ops.push({ kind: '+', text: b[j]! }); j++; }
  }
  while (i < a.length) ops.push({ kind: '-', text: a[i++]! });
  while (j < b.length) ops.push({ kind: '+', text: b[j++]! });

  // Keep only changed lines plus `context` unchanged lines around them.
  const keep = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.kind === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep.add(k);
  });

  const out: string[] = [];
  let gap = false;
  ops.forEach((op, idx) => {
    if (!keep.has(idx)) { gap = true; return; }
    if (gap && out.length > 0) out.push(theme.separator('  ...'));
    gap = false;
    const line = `${op.kind} ${op.text}`;
    out.push(op.kind === '-' ? theme.error(line) : op.kind === '+' ? theme.success(line) : theme.separator(line));
  });
  return out;
}

export async function commandDoctorFixAgents(root: string, opts: { yes: boolean }): Promise<void> {
  const configPath = await resolveConfigPath(root);

  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(
      code === 'ENOENT'
        ? `No lazy.toml at ${configPath} — nothing to migrate. Run \`lazy init\` first.`
        : `Failed to read ${configPath}: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  // REFUSED WHOLESALE ON A MANAGED HOST, before the plan is even built. Every
  // rewrite this command performs writes `[agents.<name>]` blocks carrying an
  // `endpoint` — that is the migration, the old keys it replaces were endpoints
  // — and `agents.*.endpoint` is `refused` by the managed policy. So the best
  // possible outcome here is a lazy.toml the host will not load, reached by
  // running a command lazy offered. Refusing is the only honest answer; there is
  // no partial migration worth writing, because the endpoints are the content.
  if (isManagedMode()) {
    console.error(
      `Cannot migrate ${configPath} on this installation.\n\n` +
      `The rewrite moves upstream endpoints into [agents.<name>] blocks, and this installation ` +
      `manages agent configuration — such a block in the repository's lazy.toml is refused, which ` +
      `would stop the project loading altogether. Nothing was written.\n\n` +
      `Ask whoever runs this installation which agents it offers, and remove the superseded keys ` +
      `from the repository's lazy.toml rather than migrating them.`,
    );
    process.exit(1);
  }

  const plan = planAgentMigration(content);

  if (!plan.needed) {
    console.log(`${configPath} already uses agent profiles — nothing to migrate.`);
    console.log(theme.separator('  A profile is an [agents.<name>] block: harness, model, endpoint, credential.'));
    return;
  }

  if (plan.blockers.length > 0) {
    console.error(theme.error(`Cannot rewrite ${configPath} automatically:`));
    for (const blocker of plan.blockers) console.error(`\n  ${blocker.replace(/\n/g, '\n  ')}`);
    console.error('\nNothing was written.');
    process.exit(1);
  }

  console.log(`${configPath} uses config that agent profiles replaced:\n`);
  for (const step of plan.steps) {
    console.log(`  ${theme.error(step.found)}`);
    console.log('    becomes:');
    for (const line of step.becomes) console.log(`      ${theme.success(line)}`);
    console.log('');
  }

  console.log('Diff:');
  for (const line of renderDiff(content, plan.updated)) console.log(`  ${line}`);
  console.log('');

  if (!opts.yes) {
    if (!isTTY()) {
      console.log(`Re-run with ${theme.command('--yes')} to apply this (non-interactive).`);
      return;
    }
    const proceed = await promptYesNo(`Rewrite ${configPath}?`, false);
    if (!proceed) {
      console.log('Aborted — nothing was written.');
      return;
    }
  }

  await writeFile(configPath, plan.updated);
  console.log(theme.success(`Rewrote ${configPath}.`));
  console.log(`  Review it with ${theme.command('git diff lazy.toml')} — it is a committed file.`);
  console.log(`  Then restart the daemon: ${theme.command('lazy daemon restart')}`);
  console.log(`  Check the result with ${theme.command('lazy system agent')}.`);
}
