/**
 * Registry of live INTERACTIVE host sessions for a project — `lazy pair` and
 * `lazy chat`.
 *
 * WHY A REGISTRY AT ALL
 * ---------------------
 * `lazy upgrade` finds the builders it has to stop by asking the runner for
 * containers named `lazy-builder-<id>` (`discoverProjectBuilderRuns`). An
 * interactive session is a HOST process with no container and no runner-visible
 * name, so it was invisible to that scan — which is why a pair session survived
 * an upgrade that stopped every other child, and kept talking to a proxy address
 * that had already moved. `lazy chat` has exactly the same shape and the same
 * problem, so it lives in the same registry rather than getting its own.
 *
 * WHY HERE, AND NOT SOMEWHERE THAT ALREADY EXISTS
 * -----------------------------------------------
 * Two existing mechanisms were considered first, and neither fits:
 *
 *  - **The pairing lock** (`<worktree>/.lazy-task-sandbox/pairing-lock`) already
 *    records a pid with holder identity — but it is per-WORKTREE and per-TASK.
 *    Branchless pairing (`lazy pair` with no task) has no worktree at all, so
 *    it cannot be represented; and enumerating live sessions from it would mean
 *    walking every worktree of the project. It stays exactly what it is: the
 *    mutual-exclusion lock that keeps automation off a task a human is pairing
 *    on. This registry does not replace or duplicate it.
 *  - **Runner run-discovery** is a container mechanism. A host process has
 *    nothing for it to label.
 *
 * The per-project daemon dir is the one place that is already scoped to this
 * project, already lives outside the repo (so it never dirties a worktree and
 * works for branchless sessions), and is already the directory daemon tooling
 * enumerates. Entries land in
 * `~/.lazy/daemon/<slug>/interactive-sessions/<pid>.json`.
 *
 * NO MIGRATION FROM THE OLD `pair-sessions/` DIRECTORY
 * ----------------------------------------------------
 * Entries describe LIVE processes and nothing else — there is no history here to
 * preserve. A session registered by an older lazy is simply invisible to this
 * code, which is exactly the behaviour that session already had before the
 * registry existed. Its entry is cleaned up by the older binary that wrote it,
 * or left as a stale file in a directory nothing reads.
 *
 * STALENESS
 * ---------
 * An interactive session ends when a human closes their terminal, so entries
 * WILL be orphaned — kill -9, a closed laptop lid, a crash.
 * `listInteractiveSessions` verifies every entry against the process actually
 * occupying its pid (the same identity check the pairing lock uses, which is
 * immune to pid reuse) and removes the ones that are gone. There is no separate
 * reaper to forget to run.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { hostname } from 'os';
import { getDaemonDir } from './paths';
import {
  checkHolder,
  selfIdentity,
  type StartTimeSource,
} from '../utils/process-identity';

/** Directory name, inside the per-project daemon dir, holding session entries. */
export const INTERACTIVE_SESSIONS_DIR = 'interactive-sessions';

/**
 * Which surface started the session. Stored rather than inferred: a chat session
 * and a task-mode pair session are otherwise indistinguishable on disk, and the
 * human reading `lazy upgrade`'s prompt needs to know which of their terminals
 * is about to be restarted.
 */
export type InteractiveSessionKind = 'pair' | 'chat';

/** A registered, believed-live interactive supervisor. */
export interface InteractiveSessionEntry {
  /** PID of the SUPERVISOR (not of the Claude Code child). */
  pid: number;
  /** Hostname the pid is meaningful on. */
  host: string;
  /** ISO timestamp the session registered. */
  startedAt: string;
  /** Which command owns this session. Absent on entries from older versions. */
  kind?: InteractiveSessionKind;
  /** Task short id for a task-mode session; absent when branchless. */
  taskId?: string;
  /** Directory the session runs in (worktree in task mode, cwd when branchless). */
  cwd: string;
  /**
   * Identity of the supervisor process captured at registration, so a recycled
   * pid can never be mistaken for a live session — nor signalled as one.
   */
  holderStartedAt?: string | null;
  holderStartSource?: StartTimeSource | null;
  holderCommand?: string | null;
}

function sessionsDir(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), INTERACTIVE_SESSIONS_DIR);
}

function entryPath(projectRoot: string, pid: number): string {
  return join(sessionsDir(projectRoot), `${pid}.json`);
}

/**
 * Record this process as a live interactive supervisor. Overwrites any entry
 * left by a previous occupant of the same pid, which is the correct resolution:
 * a pid can only be one process at a time, and we are it.
 */
export async function registerInteractiveSession(
  projectRoot: string,
  info: { kind: InteractiveSessionKind; taskId?: string; cwd: string },
): Promise<InteractiveSessionEntry> {
  const identity = await selfIdentity();
  const entry: InteractiveSessionEntry = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    kind: info.kind,
    ...(info.taskId ? { taskId: info.taskId } : {}),
    cwd: info.cwd,
    holderStartedAt: identity?.started ?? null,
    holderStartSource: identity?.startedSource ?? null,
    holderCommand: identity?.command ?? null,
  };
  await mkdir(sessionsDir(projectRoot), { recursive: true });
  await writeFile(entryPath(projectRoot, entry.pid), JSON.stringify(entry, null, 2), { mode: 0o600 });
  return entry;
}

/**
 * Remove this process's entry. Best-effort by design: a missing entry is the
 * desired end state, and failing to unregister must never take down the human's
 * session on its way out.
 */
export async function unregisterInteractiveSession(projectRoot: string, pid = process.pid): Promise<void> {
  try {
    await unlink(entryPath(projectRoot, pid));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Surface, don't swallow — but do not throw: an undeletable entry is
      // self-healing (listInteractiveSessions drops it once the pid is gone).
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Warning: could not remove interactive session registry entry: ${msg}\n`);
    }
  }
}

/**
 * List interactive supervisors that are still running, pruning entries whose
 * process is gone or whose pid has been recycled.
 *
 * Entries stamped on a DIFFERENT host are returned unverified and never pruned:
 * their pid is meaningless here, so both "alive" and "dead" would be guesses.
 * Callers that signal a pid must check `host` themselves.
 */
export async function listInteractiveSessions(projectRoot: string): Promise<InteractiveSessionEntry[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir(projectRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `failed to read interactive session registry at ${sessionsDir(projectRoot)}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const here = hostname();
  const live: InteractiveSessionEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(sessionsDir(projectRoot), name);
    let entry: InteractiveSessionEntry;
    try {
      entry = JSON.parse(await readFile(path, 'utf-8')) as InteractiveSessionEntry;
    } catch {
      // Unreadable or half-written entry: it names no verifiable process, so it
      // can never be acted on. Drop it rather than let it accumulate.
      await unlink(path).catch(() => { /* already gone */ });
      continue;
    }
    if (typeof entry.pid !== 'number') {
      await unlink(path).catch(() => { /* already gone */ });
      continue;
    }
    if (entry.host && entry.host !== here) {
      live.push(entry);
      continue;
    }
    const verdict = await checkHolder({
      pid: entry.pid,
      started: entry.holderStartedAt,
      startedSource: entry.holderStartSource,
      acquiredAt: entry.startedAt,
    });
    if (verdict.alive) live.push(entry);
    else await unlink(path).catch(() => { /* already gone */ });
  }
  return live.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * One-line human description of an interactive session, for prompts and
 * warnings. The command name comes first because it is what tells the human
 * which of their terminals this is.
 */
export function describeInteractiveSession(entry: InteractiveSessionEntry): string {
  const command = entry.kind === 'chat' ? 'lazy chat' : 'lazy pair';
  const what = entry.taskId ? `task ${entry.taskId}` : 'branchless';
  return `${command} — pid ${entry.pid} (${what}) in ${entry.cwd}`;
}
