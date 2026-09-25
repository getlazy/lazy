/**
 * `lazy daemon config <subcommand>`
 *
 * Runtime control + visibility for the daemon's builder concurrency cap and
 * the [usage_pause] threshold:
 *   get              — show the cap (configured / override / effective / running)
 *                      and the usage pause (thresholds, override, what is paused)
 *   set <key> <val>  — set an EPHEMERAL override for the current daemon session
 *   reset [key]      — clear the override, reverting to lazy.toml
 *
 * `usage_pause_threshold` is ONE-SHOT on top of ephemeral: it is used up by the
 * first start, unblock or resume a person asks for that it lets past a pause,
 * and then lazy.toml applies again (src/daemon/usage-pause.ts).
 *
 * The override is ephemeral: it lives only in the running daemon process and is
 * lost on restart (which reverts to lazy.toml). This command NEVER writes
 * lazy.toml — the permanent limit lives in `[limits]` there.
 *
 * Agent tasks are uncapped (remove-reaper-cap-sweep): the old
 * `max_concurrent_agents` key is gone, so only the builder cap is configurable.
 */

import { parseFlags } from '../helpers';
import { theme } from '../../render/theme';
import { queryConcurrency, queryUsagePause, type ConcurrencyLimitState } from '../../daemon/rpc-fallback';
import { LIMIT_KEYS, type LimitKey } from '../../daemon/concurrency';
import { describeNoReading, USAGE_PAUSE_OVERRIDE_KEY, type UsagePauseState } from '../../daemon/usage-pause';
import { mayOfferUsagePauseOverride, notAHumanTerminal } from '../human-terminal';
import { getActor } from '../../constants';
import { describeOverage, describeReadingsStoreError, describeUsagePause } from '../../usage-pause/policy';

/** Every key `set`/`reset` accepts, for error messages. */
const ALL_KEYS = [...LIMIT_KEYS, USAGE_PAUSE_OVERRIDE_KEY];

function isUsagePauseKey(input: string): boolean {
  return input === USAGE_PAUSE_OVERRIDE_KEY || input === 'usage_pause' || input === 'usage-pause';
}

function percentOrOff(value: number): string {
  return value > 0 ? `${value}%` : 'off';
}

/** Accept the full lazy.toml key or a short alias (builders). */
function normalizeKey(input: string): LimitKey | null {
  if ((LIMIT_KEYS as readonly string[]).includes(input)) return input as LimitKey;
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
  printLimit('Builders', 'max_concurrent_builders', state.builders);
  console.log('');
  printUsagePause(await queryUsagePause(), await mayOfferUsagePauseOverride());

  if (state.builders.override !== null) {
    console.log('');
    console.log(`  ${theme.warning('Ephemeral override active')} — resets on daemon restart (reverts to lazy.toml).`);
  }
  console.log('');
  console.log(`  Change for this daemon session: ${theme.command('lazy daemon config set <key> <value>')}`);
  console.log(`  Permanent changes: set ${theme.command('[limits]')} in lazy.toml.`);
  console.log(`  Agent tasks are uncapped — every ${theme.command('lazy start')} launches immediately.`);
}

/** `offerOverride`: name the command that sets the override — only to a person who could use it. */
function printUsagePause(state: UsagePauseState, offerOverride: boolean): void {
  console.log(theme.header('Usage pause'));
  console.log(
    `  ${theme.label('Threshold:'.padEnd(10))} ${percentOrOff(state.configured.threshold_percent)}   ` +
      theme.separator('[usage_pause] threshold_percent'),
  );
  for (const [credential, value] of Object.entries(state.configured.credentials)) {
    console.log(`  ${' '.repeat(10)} ${credential}: ${value > 0 ? `${value}%` : 'never paused'}`);
  }
  if (state.override !== null) {
    console.log(
      `  ${theme.warning('One-shot override:')} ${percentOrOff(state.override)}` +
        `${state.overrideSetAt ? ` (set ${new Date(state.overrideSetAt).toISOString()})` : ''} — used up by the ` +
        `first start, unblock or resume you ask for that it lets past a pause, then lazy.toml applies again.`,
    );
  }
  if (state.storeError) {
    console.log(`  ${theme.warning('UNREADABLE:')} ${describeReadingsStoreError(state.storeError)}`);
  }
  // INVARIANT (see usagePauseCoverage): armed with no usable reading is said,
  // never left looking like "nothing is paused".
  for (const c of state.coverage ?? []) {
    if (c.coverage === 'none') console.log(`  ${theme.warning('Armed, NO READING:')} ${describeNoReading(c)}`);
    if (c.overage) {
      const tag = c.overage.status === 'allowed' ? theme.warning('Overage:') : theme.label('Overage:');
      console.log(`  ${tag} ${describeOverage(c.credential, c.overage)}`);
    }
  }
  for (const v of state.paused) console.log(`  ${theme.warning('Paused:')} ${describeUsagePause(v)}`);
  for (const h of state.held) {
    console.log(`  ${theme.label('Waiting:')} ${h.task} — ${h.hold.held}, on ${h.hold.credential}`);
  }
  if (offerOverride) {
    console.log(`  Let one turn start past it: ${theme.command(`lazy daemon config set ${USAGE_PAUSE_OVERRIDE_KEY} off`)}`);
  }
}

/**
 * INVARIANT: the one-shot override is set only by a PERSON at their own
 * terminal. It is the human's escape hatch from [usage_pause]; the builder or
 * an agent that could set it could relaunch past every pause. So this refuses
 * without a real terminal (and inside a container, and with a test prompt seam
 * set) before asking the daemon, which refuses a non-human channel on its own.
 */
async function configSetUsagePause(rawValue: string): Promise<void> {
  const notHuman = await notAHumanTerminal();
  if (notHuman) {
    console.error(
      `Refusing to set ${USAGE_PAUSE_OVERRIDE_KEY}: ${notHuman}.\n` +
        `The override lets a turn spend a credential [usage_pause] has paused, and only a person may ` +
        `decide that. There is deliberately no flag or piped form. Run it yourself, at your own ` +
        `terminal on the host.`,
    );
    process.exit(1);
  }
  const state = await queryUsagePause({ action: 'set', value: rawValue, actor: getActor() });
  console.log(theme.success(`Set ${USAGE_PAUSE_OVERRIDE_KEY} = ${percentOrOff(state.override ?? 0)} for ONE turn start.`));
  console.log('  It is used up by the first start, unblock or resume you ask for that it lets past a pause;');
  console.log('  launches that were not paused leave it waiting. Then [usage_pause] in lazy.toml applies again.');
  console.log(`  It is also dropped if the daemon restarts. Clear it now: ${theme.command(`lazy daemon config reset ${USAGE_PAUSE_OVERRIDE_KEY}`)}`);
}

async function configSet(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'daemon config set');
  const [rawKey, rawValue] = parsed.positional;

  if (!rawKey || rawValue === undefined) {
    console.error('Usage: lazy daemon config set <key> <value>');
    console.error(`Keys: ${ALL_KEYS.join(', ')} (or alias: builders)`);
    process.exit(1);
  }

  if (isUsagePauseKey(rawKey)) {
    await configSetUsagePause(rawValue);
    return;
  }

  const key = normalizeKey(rawKey);
  if (!key) {
    if (rawKey === 'max_concurrent_agents' || rawKey === 'agents' || rawKey === 'agent') {
      console.error('The agent concurrency cap was removed — agent tasks are uncapped and every start launches immediately.');
    } else {
      console.error(`Unknown key '${rawKey}'. Valid keys: ${ALL_KEYS.join(', ')} (or alias: builders).`);
    }
    process.exit(1);
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`Invalid value '${rawValue}'. Must be a positive integer.`);
    process.exit(1);
  }

  const state = await queryConcurrency({ action: 'set', key, value });
  const updated = state.builders;

  console.log(theme.success(`Set ${key} = ${value} for this daemon session (was configured ${updated.configured}).`));
  console.log(`  ${theme.label('Now:')} ${updated.running}/${updated.limit} running`);
  console.log(`  ${theme.warning('This is an ephemeral override')} — it resets when the daemon restarts.`);
  console.log(`  Permanent changes: set ${theme.command(key)} under ${theme.command('[limits]')} in lazy.toml.`);
}

async function configReset(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [], 'daemon config reset');
  const rawKey = parsed.positional[0];

  if (rawKey && isUsagePauseKey(rawKey)) {
    await queryUsagePause({ action: 'reset' });
    console.log(theme.success(`Cleared the one-shot ${USAGE_PAUSE_OVERRIDE_KEY} override; [usage_pause] in lazy.toml applies.`));
    return;
  }
  // A bare `reset` clears every override, the one-shot usage-pause one included.
  if (!rawKey) await queryUsagePause({ action: 'reset' });

  const keys: LimitKey[] = rawKey ? [] : [...LIMIT_KEYS];
  if (rawKey) {
    const key = normalizeKey(rawKey);
    if (!key) {
      console.error(`Unknown key '${rawKey}'. Valid keys: ${ALL_KEYS.join(', ')} (or alias: builders).`);
      process.exit(1);
    }
    keys.push(key);
  }

  let state = await queryConcurrency();
  for (const key of keys) {
    state = await queryConcurrency({ action: 'reset', key });
  }

  console.log(theme.success(`Cleared ephemeral override for ${keys.join(', ')}.`));
  console.log(`  ${theme.label('Builders:')} ${state.builders.running}/${state.builders.limit}`);
}

export function daemonConfigUsage(): void {
  console.log(`Usage: lazy daemon config <subcommand> [options]

Runtime control + visibility for the daemon's builder concurrency cap
([limits] max_concurrent_builders in lazy.toml) and the usage pause
([usage_pause] in lazy.toml). Agent tasks are uncapped — every \`lazy start\`
launches immediately.

Overrides set here are EPHEMERAL — they live only in the running daemon and
reset on restart (reverting to lazy.toml). This command never writes lazy.toml.
The usage_pause_threshold override is also ONE-SHOT: it is used up by the first
start, unblock or resume you ask for that it lets past a pause, and then
lazy.toml applies again.

Subcommands:
  get                    Show the cap: configured value, ephemeral override,
                         effective limit, and current running count; and the
                         usage pause: thresholds, override, what is paused
  set <key> <value>      Set an ephemeral override for this daemon session
  reset [key]            Clear the override, reverting to lazy.toml

Keys:
  max_concurrent_builders  (alias: builders) max concurrent builder containers
  usage_pause_threshold    (alias: usage-pause) 'off' lets ONE paused turn start
                           regardless of usage; a percent is a threshold for
                           that one turn (100 still pauses at a full or refused
                           window). Only from your own terminal: it is refused
                           without one, inside a container, and from an agent

Examples:
  lazy daemon config get                            # Show current limit + usage
  lazy daemon config set builders 4                 # Lower the builder cap to 4
  lazy daemon config set usage_pause_threshold off  # Let one paused turn start
  lazy daemon config reset                          # Clear the overrides`);
}
