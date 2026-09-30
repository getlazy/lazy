/**
 * `lazy daemon reload`, and the config section of `lazy daemon status`.
 *
 * Both answers are the daemon's (src/daemon/config-status.ts): which lazy.toml
 * is in force and why, which startup-only settings differ from it, and what a
 * reload applied. This file only asks and formats.
 */

import { parseFlags, requireLazyRoot } from '../helpers';
import { DaemonClient, DaemonNotRunningError, DAEMON_HEALTH_TIMEOUT_MS } from '../../daemon';
import type { ConfigStatus, PendingSetting, ReloadResult } from '../../daemon/config-status';
import type { ConfigSourceRule } from '../../config/loader';

const RULE_WORDS: Record<ConfigSourceRule, string> = {
  'managed': 'the control plane\'s managed copy',
  'LAZY_CONFIG': 'set by LAZY_CONFIG',
  'project-root': 'the project root\'s lazy.toml',
};

/** The running daemon was started by a lazy that has no config status/reload. */
export class DaemonPredatesReloadError extends Error {
  constructor() {
    super('this daemon predates `lazy daemon reload`; restart it (`lazy daemon restart`) to get it');
    this.name = 'DaemonPredatesReloadError';
  }
}

async function ask<T>(projectRoot: string, command: string): Promise<T> {
  const client = await DaemonClient.create(projectRoot);
  if (!client) throw new DaemonNotRunningError();
  const signal = AbortSignal.timeout(DAEMON_HEALTH_TIMEOUT_MS);
  try {
    return await client.rpc(command, projectRoot, {}, undefined, signal) as T;
  } catch (err) {
    if (signal.aborted) throw new Error(`the daemon did not answer ${command} within ${Math.round(DAEMON_HEALTH_TIMEOUT_MS / 1000)}s`);
    if (err instanceof Error && /unknown rpc command/i.test(err.message)) throw new DaemonPredatesReloadError();
    throw err;
  }
}

/** The daemon's config status, or null when it predates the RPC. */
export async function fetchConfigStatus(projectRoot: string): Promise<ConfigStatus | null> {
  try {
    return await ask<ConfigStatus>(projectRoot, 'configStatus');
  } catch (err) {
    // An older daemon answers "unknown rpc command"; status then says so in one
    // line rather than failing the whole command.
    if (err instanceof DaemonPredatesReloadError) return null;
    throw err;
  }
}

function pendingLine(p: PendingSetting, fileBroken: boolean): string {
  const head = `    ${p.key}: running ${p.running}, lazy.toml says ${p.configured} — pending`;
  // While the file does not load, neither command can apply anything: reload
  // refuses, and a restart would refuse to START and leave no daemon at all.
  if (fileBroken) return `${head}, apply after fixing lazy.toml`;
  const how = p.applyBy === 'reload' ? 'lazy daemon reload' : 'lazy daemon restart';
  return `${head}, apply with \`${how}\``;
}

/** The lines `lazy daemon status` prints for the config (after its own header). */
export function formatConfigStatus(status: ConfigStatus | null): string[] {
  if (!status) return ['  Config:  unknown — this daemon predates `lazy daemon reload`; restart it'];
  const lines = [`  Config:  ${status.path} (${RULE_WORDS[status.rule]})`];
  if (status.lastKnownGood) {
    lines.push('');
    lines.push(`  ⚠ ${status.lastKnownGood.path} does NOT load, so the daemon is running on the last`);
    lines.push(`    good config it read from it (loaded ${status.lastKnownGood.goodLoadedAt}):`);
    for (const l of status.lastKnownGood.error.split('\n')) lines.push(`      ${l}`);
    lines.push('    Fix the file; the daemon picks it up again by itself. Until then do NOT run');
    lines.push('    `lazy daemon restart` or `lazy upgrade`: a daemon cannot START on this file.');
  } else if (status.loadError) {
    lines.push('');
    lines.push(`  ⚠ ${status.path} does NOT load:`);
    for (const l of status.loadError.split('\n')) lines.push(`      ${l}`);
  }
  if (status.pending.length > 0) {
    lines.push('');
    lines.push('  Startup-only settings that differ from lazy.toml:');
    const fileBroken = status.lastKnownGood !== null || status.loadError !== null;
    for (const p of status.pending) lines.push(pendingLine(p, fileBroken));
  }
  return lines;
}

export async function commandDaemonReload(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'project', takesValue: true },
    { name: 'json', takesValue: false },
  ], 'daemon reload');
  const project = parsed.flags.get('project');
  const projectRoot = typeof project === 'string' ? project : requireLazyRoot();

  let result: ReloadResult;
  try {
    result = await ask<ReloadResult>(projectRoot, 'configReload');
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (parsed.flags.get('json')) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.reloaded) process.exit(1);
    return;
  }
  if (!result.reloaded) {
    console.error(`Error: ${result.path} does not load, so nothing was reloaded — the daemon keeps its running config.`);
    console.error('');
    console.error(result.error);
    process.exit(1);
  }
  console.log(`Reloaded ${result.path} (${RULE_WORDS[result.rule]}).`);
  if (result.applied.length === 0 && result.needsRestart.length === 0) {
    console.log('  No startup-only setting changed — everything else in lazy.toml is read on each use already.');
    return;
  }
  for (const p of result.applied) {
    console.log(`  Applied: ${p.key} = ${p.configured} (was ${p.running})`);
  }
  if (result.needsRestart.length > 0) {
    console.log('');
    console.log('  Not applied — these need `lazy daemon restart`:');
    for (const p of result.needsRestart) {
      console.log(`    ${p.key}: running ${p.running}, lazy.toml says ${p.configured}`);
    }
  }
}

export function daemonReloadUsage(): void {
  console.log(`Usage: lazy daemon reload [--json] [--project PATH]

Re-read the lazy.toml the daemon is using and apply the startup-only settings
that can change without a restart — [server] dashboard_url (links, sign-in and
\`lazy dashboard\` use the new address) and [server] sync_interval. Running
turns are never interrupted.

Settings that need a restart (ports, bind addresses, the proxy, storage, …) are
listed and left unchanged; apply them with \`lazy daemon restart\`. Everything
else in lazy.toml is read on each use and needs neither.

A lazy.toml that does not load is refused with its error, and the daemon keeps
its running config. \`lazy daemon status\` shows which file is in force.

Options:
  --json          Print the result as JSON
  --project PATH  Explicit project root (default: auto-detect from cwd)`);
}

/**
 * The config section for `lazy daemon status`, never throwing: a daemon that
 * cannot answer this one question still has the rest of its status to show.
 */
export async function readConfigStatusForDisplay(
  projectRoot: string,
): Promise<{ status: ConfigStatus | null; error: string | null }> {
  try {
    return { status: await fetchConfigStatus(projectRoot), error: null };
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** {@link formatConfigStatus}, or one line saying why it could not be read. */
export function formatConfigStatusOrError(read: { status: ConfigStatus | null; error: string | null }): string[] {
  if (read.error) return [`  Config:  could not be read from the daemon (${read.error})`];
  return formatConfigStatus(read.status);
}
