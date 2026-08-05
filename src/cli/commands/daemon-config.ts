/**
 * `lazy daemon config <subcommand>`
 *
 * Runtime control + visibility for the daemon's concurrency caps:
 *   get              — show both caps (configured / override / effective / running)
 *   set <key> <val>  — set an EPHEMERAL override for the current daemon session
 *   reset [key]      — clear the override(s), reverting to lazy.toml
 *
 * The override is ephemeral: it lives only in the running daemon process and is
 * lost on restart (which reverts to lazy.toml). This command NEVER writes
 * lazy.toml — permanent limits live in `[limits]` there.
 */

import { parseFlags } from '../helpers';
import { theme } from '../theme';
import { queryConcurrency, type ConcurrencyLimitState } from '../../daemon/rpc-fallback';
import { LIMIT_KEYS, type LimitKey } from '../../daemon/concurrency';

/** Accept the full lazy.toml key or a short alias (agents / builders). */
function normalizeKey(input: string): LimitKey | null {
  if ((LIMIT_KEYS as readonly string[]).includes(input)) return input as LimitKey;
  if (input === 'agents' || input === 'agent') return 'max_concurrent_agents';
  if (input === 'builders' || input === 'builder') return 'max_concurrent_builders';
  return null;
}

export async function commandDaemonConfig(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'get':
    case 'list':
    case 'status':
    case undefined:
      await configGet(subArgs);
      break;
    case 'set':
      await configSet(subArgs);
      break;
    case 'reset':
    case 'unset':
      await configReset(subArgs);
      break;
    default:
      if (subcommand === '--help' || subcommand === '-h') {
        daemonConfigUsage();
      } else {
        console.error(`Unknown daemon config subcommand: ${subcommand}`);
        daemonConfigUsage();
        process.exit(1);
      }
  }
}

function printLimit(label: string, key: LimitKey, state: ConcurrencyLimitState): void {
  const overridden = state.override !== null;
  const effective = overridden
    ? `${theme.warning(String(state.limit))} (override; configured ${state.configured})`
    : `${state.limit}`;
  console.log(`  ${theme.label((label + ':').padEnd(10))} ${state.running}/${effective} running   ${theme.separator(key)}`);
}

async function configGet(args: string[]): Promise<void> {
  parseFlags(args, [], 'daemon config get');
  const state = await queryConcurrency();

  console.log(theme.header('Concurrency limits'));
  printLimit('Agents', 'max_concurrent_agents', state.agents);
  printLimit('Builders', 'max_concurrent_builders', state.builders);

  const anyOverride = state.agents.override !== null || state.builders.override !== null;
  if (anyOverride) {
    console.log('');
    console.log(`  ${theme.warning('Ephemeral override active')} — resets on daemon restart (reverts to lazy.toml).`);
  }
  console.log('');
  console.log(`  Change for this daemon session: ${theme.command('lazy daemon config set <key> <value>')}`);
  console.log(`  Permanent changes: set ${theme.command('[limits]')} in lazy.toml.`);
}

async function configSet(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'daemon config set');
  const [rawKey, rawValue] = parsed.positional;

  if (!rawKey || rawValue === undefined) {
    console.error('Usage: lazy daemon config set <key> <value>');
    console.error(`Keys: ${LIMIT_KEYS.join(', ')} (or aliases: agents, builders)`);
    process.exit(1);
  }

  const key = normalizeKey(rawKey);
  if (!key) {
    console.error(`Unknown key '${rawKey}'. Valid keys: ${LIMIT_KEYS.join(', ')} (or aliases: agents, builders).`);
    process.exit(1);
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`Invalid value '${rawValue}'. Must be a positive integer.`);
    process.exit(1);
  }

  const state = await queryConcurrency({ action: 'set', key, value });
  const updated = key === 'max_concurrent_agents' ? state.agents : state.builders;

  console.log(theme.success(`Set ${key} = ${value} for this daemon session (was configured ${updated.configured}).`));
  console.log(`  ${theme.label('Now:')} ${updated.running}/${updated.limit} running`);
  console.log(`  ${theme.warning('This is an ephemeral override')} — it resets when the daemon restarts.`);
  console.log(`  Permanent changes: set ${theme.command(key)} under ${theme.command('[limits]')} in lazy.toml.`);
}

async function configReset(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'daemon config reset');
  const rawKey = parsed.positional[0];

  const keys: LimitKey[] = rawKey ? [] : [...LIMIT_KEYS];
  if (rawKey) {
    const key = normalizeKey(rawKey);
    if (!key) {
      console.error(`Unknown key '${rawKey}'. Valid keys: ${LIMIT_KEYS.join(', ')} (or aliases: agents, builders).`);
      process.exit(1);
    }
    keys.push(key);
  }

  let state = await queryConcurrency();
  for (const key of keys) {
    state = await queryConcurrency({ action: 'reset', key });
  }

  console.log(theme.success(`Cleared ephemeral override${keys.length > 1 ? 's' : ''} for ${keys.join(', ')}.`));
  console.log(`  ${theme.label('Agents:')}   ${state.agents.running}/${state.agents.limit}`);
  console.log(`  ${theme.label('Builders:')} ${state.builders.running}/${state.builders.limit}`);
}

export function daemonConfigUsage(): void {
  console.log(`Usage: lazy daemon config <subcommand> [options]

Runtime control + visibility for the daemon's concurrency caps
([limits] max_concurrent_agents / max_concurrent_builders in lazy.toml).

Overrides set here are EPHEMERAL — they live only in the running daemon and
reset on restart (reverting to lazy.toml). This command never writes lazy.toml.

Subcommands:
  get                    Show both caps: configured value, ephemeral override,
                         effective limit, and current running count
  set <key> <value>      Set an ephemeral override for this daemon session
  reset [key]            Clear the override(s), reverting to lazy.toml

Keys:
  max_concurrent_agents    (alias: agents)   max concurrently-working agent tasks
  max_concurrent_builders  (alias: builders) max concurrent builder containers

Examples:
  lazy daemon config get                          # Show current limits + usage
  lazy daemon config set max_concurrent_agents 12 # Raise the agent cap to 12
  lazy daemon config set builders 4               # Lower the builder cap to 4
  lazy daemon config reset                        # Clear all overrides
  lazy daemon config reset agents                 # Clear just the agent override`);
}
