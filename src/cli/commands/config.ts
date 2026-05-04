/**
 * `lazy config` command
 *
 * Runtime configuration get/set:
 *   lazy config set auto_react off              — globally pause auto-triggered turns
 *   lazy config set auto_react on               — globally resume auto-triggered turns
 *   lazy config set auto_react off --task <id>  — pause auto-react for a specific task
 *   lazy config set auto_react on --task <id>   — resume auto-react for a specific task
 *   lazy config get auto_react                  — show global auto-react status
 *   lazy config get auto_react --task <id>      — show per-task auto-react status
 *
 * Runtime toggles live here under a generic namespace. Budget sizes and other
 * static config remain in lazy.toml.
 */

import { requireLazyRoot, requireStorage, resolveTaskOrExit, displayId, parseFlags } from '../helpers';
import { join } from 'path';
import {
  isGlobalAutoReactPaused,
  setGlobalAutoReactPaused,
  pauseAutoReact,
  resetAutoReactCounters,
  getAutoReactSummary,
  readDailyBudget,
} from '../../daemon/auto-react-budget';
import { getOfflineStatus, setOfflineMode } from '../../utils/offline';
import { theme } from '../theme';

/** Known config keys and their allowed values. */
const KNOWN_KEYS: Record<string, { values: string[]; description: string }> = {
  auto_react: { values: ['on', 'off'], description: 'Auto-triggered agent turns' },
  offline: { values: ['on', 'off'], description: 'Offline mode (skip remote operations)' },
};

export async function commandConfig(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'set':
      await configSet(subArgs);
      break;
    case 'get':
      await configGet(subArgs);
      break;
    default:
      if (subcommand === '--help' || subcommand === '-h' || !subcommand) {
        configUsage();
      } else {
        console.error(`Unknown config subcommand: ${subcommand}`);
        configUsage();
        process.exit(1);
      }
  }
}

async function configSet(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'task', takesValue: true },
    { name: 'reason', takesValue: true },
  ], 'config set');

  const key = parsed.positional[0];
  const value = parsed.positional[1];

  if (!key || !value) {
    console.error('Usage: lazy config set <key> <value> [--task <id>] [--reason <text>]');
    console.error(`\nAvailable keys: ${Object.keys(KNOWN_KEYS).join(', ')}`);
    process.exit(1);
  }

  const spec = KNOWN_KEYS[key];
  if (!spec) {
    console.error(`Unknown config key: ${key}`);
    console.error(`Available keys: ${Object.keys(KNOWN_KEYS).join(', ')}`);
    process.exit(1);
  }

  if (!spec.values.includes(value)) {
    console.error(`Invalid value '${value}' for ${key}. Allowed: ${spec.values.join(', ')}`);
    process.exit(1);
  }

  const taskIdInput = parsed.flags.get('task') as string | undefined;

  switch (key) {
    case 'auto_react':
      await setAutoReact(value, taskIdInput, parsed.flags);
      break;
    case 'offline':
      await setOffline(value);
      break;
  }
}

async function configGet(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'task', takesValue: true },
  ], 'config get');

  const key = parsed.positional[0];

  if (!key) {
    console.error('Usage: lazy config get <key> [--task <id>]');
    console.error(`\nAvailable keys: ${Object.keys(KNOWN_KEYS).join(', ')}`);
    process.exit(1);
  }

  const spec = KNOWN_KEYS[key];
  if (!spec) {
    console.error(`Unknown config key: ${key}`);
    console.error(`Available keys: ${Object.keys(KNOWN_KEYS).join(', ')}`);
    process.exit(1);
  }

  const taskIdInput = parsed.flags.get('task') as string | undefined;

  switch (key) {
    case 'auto_react':
      await getAutoReact(taskIdInput);
      break;
    case 'offline':
      await getOffline();
      break;
  }
}

// --- auto_react handlers ---

async function setAutoReact(
  value: string,
  taskIdInput: string | undefined,
  flags: Map<string, string | boolean | string[]>,
): Promise<void> {
  const reason = (flags.get('reason') as string | undefined) ?? 'Manually set via CLI';
  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');

  if (taskIdInput) {
    const storage = await requireStorage();
    try {
      const task = await resolveTaskOrExit(storage, taskIdInput);
      if (value === 'off') {
        await pauseAutoReact(storage, task.id, reason);
        console.log(`Auto-react paused for task ${theme.taskId(displayId(task))}`);
        console.log(`  Reason: ${reason}`);
        console.log(`\nResume with: ${theme.command(`lazy config set auto_react on --task ${displayId(task)}`)}`);
      } else {
        await resetAutoReactCounters(storage, task.id);
        console.log(`Auto-react resumed for task ${theme.taskId(displayId(task))}`);
        console.log('  Counters and pause state have been reset.');
      }
    } finally {
      await storage.close();
    }
  } else {
    if (value === 'off') {
      await setGlobalAutoReactPaused(dataDir, true, reason);
      console.log('Auto-react globally paused.');
      console.log(`  Reason: ${reason}`);
      console.log(`\nResume with: ${theme.command('lazy config set auto_react on')}`);
    } else {
      await setGlobalAutoReactPaused(dataDir, false);
      console.log('Auto-react globally resumed.');
    }
  }
}

async function getAutoReact(taskIdInput: string | undefined): Promise<void> {
  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');

  // Global status
  const globalPause = await isGlobalAutoReactPaused(dataDir);
  const dailyBudget = await readDailyBudget(dataDir);

  console.log(theme.label('Global auto-react status:'));
  if (globalPause.paused) {
    console.log(`  ${theme.error('PAUSED')}${globalPause.reason ? `: ${globalPause.reason}` : ''}`);
  } else {
    console.log(`  ${theme.status('active')}`);
  }
  console.log(`  ${theme.label('Daily budget:')} ${dailyBudget.used} used today (${dailyBudget.date})`);

  if (taskIdInput) {
    const storage = await requireStorage();
    try {
      const task = await resolveTaskOrExit(storage, taskIdInput);
      const summary = await getAutoReactSummary(storage, task.id);

      console.log(`\n${theme.label('Task')} ${theme.taskId(displayId(task))} ${theme.label('auto-react status:')}`);
      if (summary.paused) {
        console.log(`  ${theme.error('PAUSED')}: ${summary.reason ?? 'limit reached'}`);
      } else {
        console.log(`  ${theme.status('active')}`);
      }

      const triggerLabels: Record<string, string> = {
        ci_failure: 'CI failures',
        upstream_sync: 'Upstream syncs',
        comment: 'Comments',
        child_completed: 'Child completions',
        crash: 'Crashes',
      };
      const hasCounts = Object.values(summary.counts).some(c => c > 0);
      if (hasCounts) {
        console.log(`  ${theme.label('Trigger counts:')}`);
        for (const [trigger, count] of Object.entries(summary.counts)) {
          if (count > 0) {
            console.log(`    ${triggerLabels[trigger] ?? trigger}: ${count}`);
          }
        }
      }
      if (summary.consecutiveAutoTurns > 0) {
        console.log(`  ${theme.label('Consecutive auto-turns (current burst):')} ${summary.consecutiveAutoTurns}`);
      }
    } finally {
      await storage.close();
    }
  }
}

// --- offline handlers ---

async function setOffline(value: string): Promise<void> {
  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');

  if (value === 'on') {
    const status = await getOfflineStatus(dataDir);
    if (status.enabled) {
      console.log('Already in offline mode.');
      return;
    }
    await setOfflineMode(dataDir, true);
    console.log(theme.success('Offline mode enabled.'));
    console.log('  The daemon will stop remote operations on the next tick.');
    console.log(`\nRestore with: ${theme.command('lazy config set offline off')}`);
  } else {
    const status = await getOfflineStatus(dataDir);
    if (!status.enabled) {
      console.log('Already online.');
      return;
    }
    await setOfflineMode(dataDir, false);
    console.log(theme.success('Online mode restored.'));
    console.log('  The daemon will sync on the next tick.');
  }
}

async function getOffline(): Promise<void> {
  const root = requireLazyRoot();
  const dataDir = join(root, '.lazy');
  const status = await getOfflineStatus(dataDir);
  console.log(theme.label('Offline mode:'));
  if (status.enabled) {
    console.log(`  ${theme.error('ENABLED')}${status.enabled_at ? ` since ${status.enabled_at}` : ''}`);
    if (status.configured_driver && status.configured_driver !== 'local') {
      console.log(`  ${theme.label('Suspended driver:')} ${status.configured_driver}`);
    }
    console.log(`\nRestore with: ${theme.command('lazy system online')}`);
  } else {
    console.log(`  ${theme.status('off')}`);
  }
}

export function configUsage(): void {
  console.log(`Usage: lazy config <set|get> <key> [value] [options]

Runtime configuration toggles for lazy.

Subcommands:
  set <key> <value>    Set a runtime config value
  get <key>            Get current value of a runtime config key

Available keys:
  auto_react           Auto-triggered agent turns (on/off)
  offline              Offline mode — skip all remote operations (on/off, global)

Options:
  --task <id>          Apply to a specific task instead of globally
  --reason <text>      Reason for the change (used with set)

Runtime toggles control on/off behavior at runtime. Budget sizes and other
static config remain in lazy.toml.

Per-task "set auto_react on" also resets all auto-react counters (trigger
counts, consecutive auto-turn count, and backoff timers) for the task.

Examples:
  lazy config set auto_react off                        # Pause all auto-reacts globally
  lazy config set auto_react off --task abc1            # Pause auto-react for task abc1
  lazy config set auto_react off --reason "investigating"  # Pause with a reason
  lazy config set auto_react on                         # Resume globally
  lazy config set auto_react on --task abc1             # Resume task abc1 (resets counters)
  lazy config get auto_react                            # Show global status
  lazy config get auto_react --task abc1                # Show global + task status
  lazy config set offline on                            # Enable offline mode
  lazy config set offline off                           # Disable offline mode
  lazy config get offline                               # Show offline status`);
}
