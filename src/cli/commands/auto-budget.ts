/**
 * `lazy daemon auto-budget <subcommand>`
 *
 * Runtime control + visibility for the daemon's auto-react daily budget:
 *   list            — today's used/limit, reset countdown, pause state, activity log
 *   update <delta>  — adjust today's effective cap only (+50 / -20 / =100), ephemeral
 *   pause           — pause auto-react until local midnight (auto-resume)
 *   resume          — clear the pause early
 *
 * The cap override and pause are ephemeral runtime controls anchored to the
 * machine's LOCAL day (see src/utils/local-day.ts). Permanent budget sizing
 * stays in lazy.toml (`[daemon] auto_react_daily_budget`).
 */

import { join } from 'path';
import { requireLazyRoot, parseFlags } from '../helpers';
import { loadConfig } from '../../config/loader';
import { theme } from '../theme';
import { describeExpiry, nextLocalMidnight } from '../../utils/local-day';
import {
  readDailyBudget,
  effectiveDailyLimit,
  adjustDailyCap,
  isGlobalAutoReactPaused,
  setGlobalAutoReactPaused,
  pauseGlobalAutoReactUntilMidnight,
} from '../../daemon/auto-react-budget';

const TRIGGER_LABELS: Record<string, string> = {
  ci_failure: 'CI failure',
  upstream_sync: 'upstream sync',
  comment: 'comment',
  child_completed: 'child completed',
  crash: 'crash',
};

export async function commandAutoBudget(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'list':
    case 'status':
      await autoBudgetList(subArgs);
      break;
    case 'update':
      await autoBudgetUpdate(subArgs);
      break;
    case 'pause':
      await autoBudgetPause(subArgs);
      break;
    case 'resume':
      await autoBudgetResume(subArgs);
      break;
    default:
      if (subcommand === '--help' || subcommand === '-h' || !subcommand) {
        autoBudgetUsage();
      } else {
        console.error(`Unknown auto-budget subcommand: ${subcommand}`);
        autoBudgetUsage();
        process.exit(1);
      }
  }
}

/** Format an epoch-ms timestamp as a local HH:MM:SS clock time. */
function formatLogTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Print the current pause state, always including the expiry when paused.
 */
async function printPauseState(dataDir: string): Promise<void> {
  const pause = await isGlobalAutoReactPaused(dataDir);
  if (pause.paused) {
    const expiry =
      pause.expiresAt !== undefined
        ? ` — resumes ${describeExpiry(new Date(pause.expiresAt))}`
        : ' — indefinite (no expiry)';
    console.log(`  ${theme.label('Pause:')} ${theme.warning('PAUSED')}${expiry}`);
    if (pause.reason) {
      console.log(`         ${theme.separator(pause.reason)}`);
    }
  } else {
    console.log(`  ${theme.label('Pause:')} active (not paused)`);
  }
}

async function autoBudgetList(args: string[]): Promise<void> {
  parseFlags(args, [], 'daemon auto-budget list');
  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');
  const config = await loadConfig(root);

  const state = await readDailyBudget(dataDir);
  const configured = config.daemon.auto_react_daily_budget;
  const limit = effectiveDailyLimit(state, configured);
  const reset = nextLocalMidnight();

  console.log(theme.header('Auto-react daily budget'));
  console.log(`  ${theme.label('Today:')} ${state.used}/${limit} turns — resets ${describeExpiry(reset)}`);

  if (state.capOverride !== undefined) {
    console.log(
      `  ${theme.label('Override:')} today-only cap ${theme.warning(String(state.capOverride))} ` +
        `(configured ${configured}) — expires ${describeExpiry(reset)}`,
    );
  }

  await printPauseState(dataDir);

  // Activity log — what consumed budget today.
  const log = state.log ?? [];
  console.log('');
  if (log.length === 0) {
    console.log(`  ${theme.label('Activity:')} none today`);
  } else {
    console.log(`  ${theme.label('Activity today:')} ${log.length} ${log.length === 1 ? 'turn' : 'turns'}`);
    for (const entry of log) {
      const code = entry.taskCode ? `${entry.taskCode} (${entry.taskId})` : entry.taskId;
      const trigger = TRIGGER_LABELS[entry.trigger] ?? entry.trigger;
      console.log(
        `    ${theme.timestamp(formatLogTime(entry.ts))}  ${theme.taskId(code)}  ${theme.separator(trigger)}`,
      );
    }
  }
}

async function autoBudgetUpdate(args: string[]): Promise<void> {
  // A negative delta like `-20` would be treated as a flag by parseFlags, so
  // pull the delta token out by pattern before flag parsing. Everything else
  // (e.g. --yes) is still validated.
  const deltaArg = args.find((a) => /^[+\-=]?\d+$/.test(a));
  const rest = args.filter((a) => a !== deltaArg);
  parseFlags(rest, [{ name: 'yes', takesValue: false }], 'daemon auto-budget update');

  if (!deltaArg) {
    console.error('Usage: lazy daemon auto-budget update <+N|-N|=N>');
    process.exit(1);
  }

  // Parse +N (relative add), -N (relative subtract), =N (absolute), or bare N (absolute).
  const match = deltaArg.match(/^([+\-=]?)(\d+)$/);
  if (!match) {
    console.error(`Invalid delta '${deltaArg}'. Use +N, -N, or =N (e.g. +50, -20, =100).`);
    process.exit(1);
  }
  const [, sign, digits] = match;
  const magnitude = parseInt(digits, 10);
  const delta: { kind: 'absolute' | 'relative'; value: number } =
    sign === '+' ? { kind: 'relative', value: magnitude }
    : sign === '-' ? { kind: 'relative', value: -magnitude }
    : { kind: 'absolute', value: magnitude };

  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');
  const config = await loadConfig(root);
  const configured = config.daemon.auto_react_daily_budget;

  const newCap = await adjustDailyCap(dataDir, configured, delta);
  const state = await readDailyBudget(dataDir);
  const reset = nextLocalMidnight();

  console.log(theme.success(`Today's auto-react cap set to ${newCap} (was configured ${configured}).`));
  console.log(`  ${theme.label('Now:')} ${state.used}/${newCap} turns used today`);
  console.log(`  ${theme.warning('This is a today-only override')} — expires ${describeExpiry(reset)}.`);
  console.log(`  Permanent changes: set ${theme.command('auto_react_daily_budget')} in lazy.toml.`);
}

async function autoBudgetPause(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'reason', takesValue: true },
    { name: 'yes', takesValue: false },
  ], 'daemon auto-budget pause');
  const reason = (parsed.flags.get('reason') as string | undefined) ?? 'Paused via lazy daemon auto-budget pause';

  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');

  const expiresAt = await pauseGlobalAutoReactUntilMidnight(dataDir, reason);
  console.log(theme.success('Auto-react paused.'));
  console.log(`  ${theme.label('Resumes:')} ${describeExpiry(new Date(expiresAt))} (auto-resume)`);
  console.log(`  ${theme.label('Reason:')} ${reason}`);
  console.log(`\nResume early with: ${theme.command('lazy daemon auto-budget resume')}`);
}

async function autoBudgetResume(args: string[]): Promise<void> {
  parseFlags(args, [{ name: 'yes', takesValue: false }], 'daemon auto-budget resume');
  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');

  const pause = await isGlobalAutoReactPaused(dataDir);
  if (!pause.paused) {
    console.log('Auto-react is not paused.');
    return;
  }
  await setGlobalAutoReactPaused(dataDir, false);
  console.log(theme.success('Auto-react resumed.'));
}

export function autoBudgetUsage(): void {
  console.log(`Usage: lazy daemon auto-budget <subcommand> [options]

Runtime control + visibility for the daemon's auto-react daily budget.
"Today" resets at LOCAL midnight. The cap override and pause set here are
ephemeral (they reset with the day) — permanent budget sizing lives in
lazy.toml (\`[daemon] auto_react_daily_budget\`).

Subcommands:
  list                Show today's used/limit, reset countdown, pause state,
                      and the log of what consumed budget today
  update <+N|-N|=N>   Adjust TODAY'S effective cap only (e.g. +50, -20, =100)
  pause               Pause auto-react until local midnight (auto-resumes)
  resume              Clear the pause early

Options:
  --reason <text>     Reason for a pause (used with pause)
  --yes               Skip confirmation prompts (non-interactive use)

Examples:
  lazy daemon auto-budget list           # Show today's budget + activity
  lazy daemon auto-budget update +50     # Raise today's cap by 50
  lazy daemon auto-budget update =100    # Set today's cap to exactly 100
  lazy daemon auto-budget pause          # Pause until midnight
  lazy daemon auto-budget resume         # Resume now`);
}
