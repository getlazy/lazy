/**
 * Pre-stop inventory and warning for `lazy daemon stop` / `lazy daemon restart`.
 *
 * Stopping the daemon has the same blast radius as `lazy upgrade` — live builder
 * sessions, working task agents and pair sessions are all affected — but until
 * now it happened in silence. On 2026-08-08 a healthy daemon was killed by hand
 * to recover from a wedge; it stranded a builder and a live pair session on a
 * dead proxy address, and nothing had told the human that would be the cost.
 *
 * This module ports `lazy upgrade`'s pre-stop courtesy (see
 * `promptBuilderPreStop` in upgrade.ts): say what is running, say what stopping
 * does to EACH class of session, and let the human back out. It only reports —
 * it never changes what stopping does.
 *
 * The three classes are affected differently, and flattening them into
 * "3 sessions affected" would be worse than useless:
 *
 * - Working agents ARE stopped by the daemon's own shutdown (server.ts stops
 *   every supervisor it owns), so the current turn is interrupted and resumes
 *   from its last checkpoint once a daemon is running again.
 * - Builders are NOT stopped — but the daemon hosts the proxy they reach the
 *   model through, and a restarted daemon binds a NEW OS-assigned proxy port
 *   that a live builder never picks up (its ANTHROPIC_BASE_URL is fixed at
 *   launch). They survive the command and then fail on their next request.
 * - Pair sessions are NOT stopped either and nothing resumes them; the task
 *   stays locked in `pairing` until the human exits the session.
 */

import { theme } from '../theme';
import { isTTY, promptYesNo } from '../editor';
import { displayId, tryRemoteStorage } from '../helpers';
import { checkDaemonHealth } from '../../daemon';
import { RpcApplicationError } from '../../daemon/client';
import { createRunnerFromType } from '../../runner';
import { loadConfig } from '../../config/loader';

/**
 * Budget for EACH source in the inventory. `daemon stop` is the tool people
 * reach for when the daemon is WEDGED, so the pre-stop report must never be able
 * to delay it materially — and one stalled source must not starve the others.
 * Sources run concurrently, each with its own deadline, so the whole report is
 * bounded by this value rather than by the sum of its parts, and a source that
 * times out degrades to "could not enumerate" instead of hiding the rest.
 */
const INVENTORY_TIMEOUT_MS = 3_000;

/** Result of one independently-deadlined inventory source. */
type SourceOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one inventory source under its own deadline, never throwing.
 *
 * Per CLAUDE.md's error-handling rules the CAUSE is carried, not flattened: a
 * failure reports what actually happened and a timeout says it timed out. A
 * human deciding whether to kill a daemon needs to know which of those it was.
 */
async function runSource<T>(label: string, work: () => Promise<T>, ms: number): Promise<SourceOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work().then(value => ({ ok: true, value }) as SourceOutcome<T>),
      new Promise<SourceOutcome<T>>(resolve => {
        timer = setTimeout(() => resolve({ ok: false, reason: `${label} timed out after ${ms}ms` }), ms);
      }),
    ]);
  } catch (err) {
    return { ok: false, reason: errorMessage(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Name the reason task sessions could not be read, distinguishing the three
 * cases that mean different things to a human at the prompt.
 *
 * `tryRemoteStorage` returns null only for a TRANSPORT failure and deliberately
 * re-throws `RpcApplicationError` (see src/cli/helpers.ts) precisely so a daemon
 * that answered with an error is not misreported as one that never answered.
 * Exported for direct testing — it is the one place the distinction is made.
 */
export function describeStorageFailure(err: unknown | null): string {
  if (err === null || err === undefined) return 'the daemon is unreachable';
  if (err instanceof RpcApplicationError) {
    return `the daemon returned an error (HTTP ${err.status}): ${err.message}`;
  }
  return `the daemon could not be read: ${errorMessage(err)}`;
}

export interface PreStopTaskSession {
  /** Human-facing id: task code when it has one, else the short id. */
  label: string;
  goal: string;
}

export interface DaemonStopInventory {
  /** Live builder container names (`lazy-builder-<id>`) owned by this project. */
  builders: string[];
  /** Tasks whose agent is mid-turn right now. */
  working: PreStopTaskSession[];
  /** Tasks a human is currently paired on. */
  pairing: PreStopTaskSession[];
  /**
   * True when the daemon's audit/policy proxy is live. When it is, stopping the
   * daemon strands every child that was launched against it.
   *
   * Assumed true (the proxy is always on — there is no off switch) and only
   * downgraded by a daemon that successfully reports it not running — never by
   * a daemon that could not be asked. A daemon reporting `running: false` here
   * is degraded, not configured that way.
   */
  proxyLive: boolean;
  /** Set when the inventory could not be completed (wedged daemon, timeout, …). */
  incompleteReason?: string;
  /** True when no container runner was available to enumerate builders. */
  buildersUnknown: boolean;
}

export function inventoryIsEmpty(inv: DaemonStopInventory): boolean {
  return inv.builders.length === 0 && inv.working.length === 0 && inv.pairing.length === 0;
}

/** Task-bound sessions, read through the daemon we are about to stop. */
async function collectTaskSessions(
  projectRoot: string,
): Promise<{ working: PreStopTaskSession[]; pairing: PreStopTaskSession[] }> {
  let storage;
  try {
    storage = await tryRemoteStorage(projectRoot);
  } catch (err) {
    throw new Error(describeStorageFailure(err));
  }
  if (!storage) throw new Error(describeStorageFailure(null));

  let tasks;
  try {
    tasks = await storage.listTasks();
  } catch (err) {
    throw new Error(describeStorageFailure(err));
  }

  const working: PreStopTaskSession[] = [];
  const pairing: PreStopTaskSession[] = [];
  for (const task of tasks) {
    if (task.status === 'working') {
      working.push({ label: displayId(task), goal: task.goal });
    } else if (task.status === 'pairing') {
      pairing.push({ label: displayId(task), goal: task.goal });
    }
  }
  return { working, pairing };
}

/**
 * Enumerate everything the daemon is currently responsible for.
 *
 * Best-effort by construction, and every source really is independent: they run
 * concurrently under separate deadlines, so a storage lookup that stalls or
 * throws cannot stop builders from being enumerated (that coupling once made the
 * report claim zero builders it had never looked for). A source we cannot read
 * is REPORTED as unreadable rather than silently counted as zero — an inventory
 * that quietly omits a class is worse than an honest "I cannot see these".
 */
export async function collectDaemonStopInventory(projectRoot: string): Promise<DaemonStopInventory> {
  // Shared by the proxy baseline and by builder enumeration; loaded once.
  const configOutcome = runSource('reading lazy.toml', () => loadConfig(projectRoot), INVENTORY_TIMEOUT_MS);

  const [config, health, sessions, builders] = await Promise.all([
    configOutcome,
    runSource('querying daemon health', () => checkDaemonHealth(projectRoot), INVENTORY_TIMEOUT_MS),
    runSource('listing live task sessions', () => collectTaskSessions(projectRoot), INVENTORY_TIMEOUT_MS),
    // Builder containers are scoped by the `lazy.project` label, so this can
    // never enumerate another project's builders.
    //
    // Deliberately NOT createRunner(): that resolves the daemon's live proxy
    // address up front and fails loud, which would turn a purely informational
    // report into a source of scary errors. Enumeration needs none of it.
    //
    // `null` means "nothing to enumerate here" (host-process mode launches the
    // builder as a plain foreground process with no pidfile, so "0" would be a
    // claim we cannot make); a throw means we could not look at all.
    runSource('enumerating builder sessions', async () => {
      const c = await configOutcome;
      if (!c.ok) throw new Error(`builder sessions could not be enumerated: ${c.reason}`);
      const type = c.value.runner.type;
      if (type !== 'docker' && type !== 'podman') return null;
      return createRunnerFromType(type).discoverProjectBuilderRuns(projectRoot);
    }, INVENTORY_TIMEOUT_MS),
  ]);

  // The proxy is ALWAYS ON (src/config/loader.ts), so "live" is the baseline and
  // only daemon health may DOWNGRADE that claim — by reporting the server not
  // running, i.e. a degraded daemon.
  //
  // Deriving it from health alone was the original bug: health is a live
  // round-trip, so on a WEDGED daemon — the single most likely reason anyone
  // types `daemon stop` — the query fails and every stranded-child consequence
  // below went unprinted, in exactly the case this warning exists for. An
  // unreachable daemon is not evidence of "no proxy"; under-warning is the
  // costly direction here, so silence about the proxy is never the default.
  let proxyLive = true;
  if (health.ok && health.value.proxy && health.value.proxy.running === false) {
    proxyLive = false;
  }

  const reasons: string[] = [];
  const inv: DaemonStopInventory = {
    builders: [],
    working: [],
    pairing: [],
    proxyLive,
    buildersUnknown: false,
  };

  if (sessions.ok) {
    inv.working = sessions.value.working;
    inv.pairing = sessions.value.pairing;
  } else {
    reasons.push(sessions.reason);
  }

  if (builders.ok && builders.value !== null) {
    inv.builders = builders.value;
  } else {
    // Either a runner with no enumerable builders, or a lookup that did not run
    // to completion — for ANY reason, timeout included. Both are "unknown", and
    // only the second is worth reporting as an incomplete inventory.
    inv.buildersUnknown = true;
    if (!builders.ok) reasons.push(builders.reason);
  }

  if (reasons.length > 0) inv.incompleteReason = reasons.join('; ');
  return inv;
}

/**
 * Print what is running and what stopping does to each class.
 *
 * `action` is the verb the human typed: `stop` and `restart` have the same blast
 * radius (a restart IS a stop plus extra steps), and differ only in whether
 * anything comes back afterwards — so restart must never be the quieter one.
 */
export function printDaemonStopInventory(inv: DaemonStopInventory, action: 'stop' | 'restart'): void {
  const restarting = action === 'restart';

  console.log('');
  console.log(theme.warning(`This ${action} affects live sessions:`));

  if (inv.working.length > 0) {
    const noun = inv.working.length === 1 ? 'task agent is' : 'task agents are';
    console.log('');
    console.log(`  ${inv.working.length} ${noun} working:`);
    for (const t of inv.working) {
      console.log(`    ${theme.taskId(t.label)} ${t.goal}`);
    }
    console.log('    Their containers are stopped with the daemon, interrupting the current turn.');
    console.log('    Committed work is kept; the in-flight turn is lost and the task resumes');
    console.log(
      restarting
        ? '    from its last checkpoint once the new daemon reconciles.'
        : '    from its last checkpoint only once a daemon is running again.',
    );
  }

  if (inv.builders.length > 0) {
    const noun = inv.builders.length === 1 ? 'builder session is' : 'builder sessions are';
    console.log('');
    console.log(`  ${inv.builders.length} ${noun} live:`);
    for (const name of inv.builders) {
      console.log(`    ${name}`);
    }
    console.log('    They are NOT stopped and NOT resumed — they keep running as-is.');
    if (inv.proxyLive) {
      console.log('    But they reach the model through this daemon\'s proxy, which dies with it,');
      console.log(
        restarting
          ? '    and the new daemon binds a NEW proxy port a live builder never picks up.'
          : '    so their next request fails.',
      );
      console.log('    Exit and relaunch each builder afterwards to recover it.');
    }
  }

  if (inv.pairing.length > 0) {
    const noun = inv.pairing.length === 1 ? 'pair session is' : 'pair sessions are';
    console.log('');
    console.log(`  ${inv.pairing.length} ${noun} open:`);
    for (const t of inv.pairing) {
      console.log(`    ${theme.taskId(t.label)} ${t.goal}`);
    }
    console.log('    Not stopped, and nothing resumes them: the task stays locked in `pairing`');
    console.log('    until you exit the session.');
    if (inv.proxyLive) {
      console.log('    The proxy they were launched against dies with the daemon, so the session');
      console.log('    is left on a dead address — exit it and re-run `lazy pair` afterwards.');
    }
  }

  if (inv.incompleteReason) {
    console.log('');
    console.log(theme.warning(`  This list is INCOMPLETE — ${inv.incompleteReason}.`));
    console.log('  There may be more live sessions than shown.');
  }

  // Honest gaps. Branchless `lazy pair` (on main, with no task) spawns a host
  // process that nothing records — no task status, no lock, no registry — so it
  // can never appear above; a host-process builder likewise has no pidfile. Say
  // so rather than let the list imply completeness. When pairing gains a
  // supervisor/registry (fix-daemon-restart-stops-children), enumerate it in
  // collectDaemonStopInventory and drop the pair half of this note.
  console.log('');
  console.log('  Not tracked, so not listed above (affected the same way if running):');
  console.log('    pair sessions started outside a task (`lazy pair` on main)');
  if (inv.buildersUnknown) {
    console.log('    builder sessions on this project\'s runner');
  }
}

/**
 * Warn about live sessions and, interactively, let the human back out.
 *
 * Returns true when the caller should proceed.
 *
 * Gating mirrors `lazy upgrade`'s pre-stop prompt so a non-interactive caller is
 * never blocked: `--yes` or no TTY prints the same warning, states that we are
 * proceeding anyway, and continues.
 */
export async function confirmDaemonStop(
  inv: DaemonStopInventory,
  action: 'stop' | 'restart',
  yes: boolean,
): Promise<boolean> {
  // Nothing live — the ordinary case. Stay silent and stop.
  //
  // `buildersUnknown` deliberately does NOT trigger this on its own: on a
  // host-process project it is always true, and prompting every single stop for
  // a permanent blind spot is exactly the noise that trains people to stop
  // reading warnings. `incompleteReason` DOES, because it means the daemon
  // stopped answering mid-inventory — a live-state unknown, not a known gap.
  if (inventoryIsEmpty(inv) && !inv.incompleteReason) return true;

  printDaemonStopInventory(inv, action);

  if (yes || !isTTY()) {
    console.log('');
    console.log(theme.warning(`  Proceeding without confirmation (--yes or no TTY).`));
    return true;
  }

  console.log('');
  const ok = await promptYesNo(`${restartVerb(action)} the daemon anyway?`, false);
  if (!ok) {
    console.log(`Aborted. The daemon is still running and nothing was ${action === 'stop' ? 'stopped' : 'restarted'}.`);
  }
  return ok;
}

function restartVerb(action: 'stop' | 'restart'): string {
  return action === 'stop' ? 'Stop' : 'Restart';
}
