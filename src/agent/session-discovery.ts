/**
 * Find the active Claude Code session for a runner's project directory.
 *
 * Claude writes one JSONL file per session under
 * `<projectDir>/<session-id>.jsonl`. The filename (minus `.jsonl`) is the
 * session id, and the most recently modified file is the active one.
 *
 * WHERE `projectDir` lives depends on the runner (its HOME differs), so this
 * helper does NOT compute it — the caller asks the runner via
 * `runner.agentSessionProjectDir(worktreePath)` and passes the result in. That
 * keeps every caller (watch, work.ts, the activity monitor) runner-agnostic
 * and the runner the single source of truth for its own session-log location.
 *
 * This scanning logic was previously duplicated in `cli/commands/watch.ts` and
 * `cli/activity-monitor.ts`; it now lives here so the supervisor can use it
 * too — see GracefulExitTimeoutError handling in `supervisor/work.ts`.
 *
 * All three of those callers are session-OWNERSHIP paths, so this helper
 * filters out lazy's own machine one-shot JSONLs — see the note on
 * {@link findLatestSessionFile}.
 */

import { readdir, stat, open } from 'fs/promises';
import { basename, join } from 'path';
import { pathExists } from '../utils/fs';
import { ONESHOT_HEAD_BYTES, isMachineOneshotSessionFile } from '../import/machine-oneshot';

export interface SessionFileInfo {
  /** Absolute path of the JSONL file. */
  path: string;
  /** Claude session id (the filename minus `.jsonl`). */
  sessionId: string;
  /** mtime of the file in ms since epoch. */
  mtimeMs: number;
}

/**
 * Cached one-shot verdicts, keyed by absolute path.
 *
 * WHY: `lazy watch` calls this helper every 500ms, and a failed housekeeping
 * one-shot leaves its stub in the directory for the rest of the turn. Without a
 * cache every tick would re-read the head of every candidate.
 */
interface OneshotVerdict {
  isOneshot: boolean;
  /** File size when the verdict was taken. */
  size: number;
  /** File mtime when the verdict was taken. */
  mtimeMs: number;
}

const oneshotVerdicts = new Map<string, OneshotVerdict>();

/**
 * Bound the cache so a long-lived process (the daemon-side supervisor) can't
 * accumulate entries for rotated sessions forever. Dropping everything is fine
 * — the verdicts are re-derivable with one small read each.
 */
const VERDICT_CACHE_MAX = 1000;

/** Can a cached verdict still be trusted for a file now `size`/`mtimeMs`? */
function verdictStillValid(cached: OneshotVerdict, size: number, mtimeMs: number): boolean {
  // The marker sits at the head and a session JSONL only ever grows, so a
  // positive verdict holds as long as the file has not SHRUNK (which would mean
  // the path was reused by a different file).
  if (cached.isOneshot) return size >= cached.size;
  // A negative verdict taken from a complete head is final for the same reason:
  // appending can never introduce a marker into the first ONESHOT_HEAD_BYTES.
  if (cached.size >= ONESHOT_HEAD_BYTES) return true;
  // Otherwise the head we read was partial (an empty or half-written file has
  // no marker YET), so only an unchanged file may reuse the verdict.
  return cached.size === size && cached.mtimeMs === mtimeMs;
}

async function isOneshotSession(path: string, size: number, mtimeMs: number): Promise<boolean> {
  const cached = oneshotVerdicts.get(path);
  if (cached && verdictStillValid(cached, size, mtimeMs)) return cached.isOneshot;

  const isOneshot = await isMachineOneshotSessionFile(path);
  if (oneshotVerdicts.size >= VERDICT_CACHE_MAX) oneshotVerdicts.clear();
  oneshotVerdicts.set(path, { isOneshot, size, mtimeMs });
  return isOneshot;
}

/**
 * Return the most recently modified Claude Code JSONL session file in the
 * given project directory, or null if none exists yet (e.g. the agent hasn't
 * started writing logs, or the directory doesn't exist).
 *
 * When `minMtimeMs` is provided, only files modified at or after that time
 * are considered — used by the supervisor to ignore stale sessions from a
 * previous turn.
 *
 * ONE-SHOTS ARE SKIPPED. lazy's own `claude -p` housekeeping runs (fidelity
 * summaries, `lazy report`, memory compaction) write session JSONLs into the
 * SAME projects dir the agent uses, and a fresh one is by construction the
 * newest file there. Every caller of this helper is a session-OWNERSHIP path —
 * `lazy watch`, the activity monitor, and the supervisor's graceful-exit
 * session recovery — so handing one of them a one-shot is always wrong: watch
 * hops onto the housekeeping prompt mid-turn and renders it as the task's
 * timeline, and recovery records a housekeeping session id as the agent's
 * resume target. See the ownership section of
 * `src/import/machine-oneshot.ts` — this is the same head-anchored marker
 * predicate `excludeMachineOneshots` uses, applied at the seam so no caller
 * can forget it.
 *
 * Same safe direction as `excludeMachineOneshots`: an unreadable or unmarked
 * file is treated as a REAL session and kept.
 */
export async function findLatestSessionFile(
  projectDir: string,
  minMtimeMs?: number,
): Promise<SessionFileInfo | null> {
  if (!(await pathExists(projectDir))) return null;

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    // Directory was removed between pathExists() and readdir() — rare race
    // during agent restart. Safe to return null and let the caller retry.
    return null;
  }

  const candidates: Array<SessionFileInfo & { size: number }> = [];

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const fullPath = join(projectDir, entry);
    try {
      const st = await stat(fullPath);
      if (minMtimeMs !== undefined && st.mtimeMs < minMtimeMs) continue;
      candidates.push({
        path: fullPath,
        sessionId: basename(entry, '.jsonl'),
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    } catch {
      // File may have been deleted or rotated between readdir and stat.
      // Safe to skip — callers that poll will pick it up on the next pass.
    }
  }

  // Newest first, then walk down past any housekeeping one-shots. In the common
  // case the newest file IS the agent's session, so this costs one cached head
  // check per call — not one per file.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    if (await isOneshotSession(candidate.path, candidate.size, candidate.mtimeMs)) continue;
    const { size: _size, ...info } = candidate;
    return info;
  }

  return null;
}

/** The slice of the Runner interface session rediscovery needs. */
export interface SessionDiscoveryRunner {
  agentSessionProjectDir(worktreePath: string): string;
  agentPiAgentDir(worktreePath: string): string;
}

/**
 * Return the most recently modified pi session file for the given worktree, or
 * null when pi has not written one yet.
 *
 * pi writes one JSONL per session under
 * `<piAgentDir>/sessions/--<munged cwd>--/<timestamp>_<session-id>.jsonl`,
 * where the munge strips the leading slash and replaces `/`, `\` and `:` with
 * `-` (pi's own `getDefaultSessionDirPath`, dist/core/session-manager.js), and
 * the timestamp is the ISO creation time with `:` and `.` replaced by `-`. The
 * worktree path is what pi resolved as cwd — the container runs the agent at
 * the worktree's own absolute path, so the munge computed here matches.
 *
 * The session id is read from the file's header line
 * (`{"type":"session",...,"id":"..."}`, always the first line) — pi's own
 * session listing parses it there rather than from the filename, and ids may
 * legally contain underscores, which the filename's `<timestamp>_<id>` split
 * cannot see through. When the header cannot be parsed, the id falls back to
 * the filename's substring after the FIRST underscore (the common uuid case),
 * and a wrong-but-plausible id degrades safely: pi's `--session-id` is
 * create-or-resume, so resuming a nonexistent id opens a fresh conversation
 * whose real id the stream then reports — the same outcome as no discovery.
 *
 * Newest mtime wins, same rule as `findLatestSessionFile`. No one-shot filter
 * and no `minMtimeMs`: lazy's machine one-shots are `claude -p` runs and never
 * land in pi's sessions tree, and the auto-resume caller wants the newest
 * session unconditionally, exactly as it does for Claude.
 */
export async function findLatestPiSessionFile(
  piAgentDir: string,
  worktreePath: string,
): Promise<SessionFileInfo | null> {
  // pi: `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--` under
  // <agentDir>/sessions. The agent runs at the worktree's own absolute path
  // (docker mounts it at the identical host path), so resolving is identity.
  const projectDir = join(
    piAgentDir,
    'sessions',
    `--${worktreePath.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`,
  );
  if (!(await pathExists(projectDir))) return null;

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    // Directory was removed between pathExists() and readdir() — rare race.
    // Safe to return null and let the caller fall back to a fresh session.
    return null;
  }

  const candidates: SessionFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    try {
      const st = await stat(join(projectDir, entry));
      candidates.push({
        path: join(projectDir, entry),
        sessionId: '',
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // Rotated or deleted between readdir and stat — the caller can retry.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) return null;

  // The newest file is the active session; its header (first line) names the
  // id. Read only the head of the file — a session JSONL grows without bound.
  const newest = candidates[0];
  let headerId: string | undefined;
  try {
    const fh = await open(newest.path, 'r');
    try {
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(1024), 0, 1024, 0);
      const firstLine = buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0];
      const header = JSON.parse(firstLine) as { type?: string; id?: string };
      if (header.type === 'session' && typeof header.id === 'string' && header.id.length > 0) {
        headerId = header.id;
      }
    } finally {
      await fh.close();
    }
  } catch {
    // Unreadable or headerless head — fall through to the filename parse.
  }
  if (headerId) {
    newest.sessionId = headerId;
    return newest;
  }

  // Filename fallback: `<timestamp>_<session-id>.jsonl`. The timestamp carries
  // no underscore (it is an ISO date with : and . replaced by -), so the split
  // is exact unless the id itself contains one (legal, but only for explicit
  // ids — pi generates uuids, which do not).
  const name = basename(newest.path, '.jsonl');
  const underscore = name.indexOf('_');
  newest.sessionId = underscore >= 0 ? name.substring(underscore + 1) : name;
  return newest;
}

/**
 * Rediscover the session id a resume of THIS turn should continue, for the
 * task's harness.
 *
 * The shared rule behind both resume paths (auto-resume in utils/auto-resume.ts
 * and the unblock launch in daemon/task-lifecycle.ts): `agent_session_id` is
 * only written when a turn FINALIZES, so a task whose turn was killed before
 * that has none stored — and without rediscovery the resume would continue a
 * stale conversation or start a new one. Discovery always goes through the
 * RUNNER, which is the single source of truth for where each agent's session
 * logs live (the sandbox for docker/podman, the host HOME for host-process).
 *
 * Harnesses with no discovery here return null deliberately: Cursor and Codex
 * have no per-worktree session file to rediscover, and inventing a resume
 * token for them would skip the distilled handoff context a fresh session
 * needs (see fix-agent-switching-on-tasks).
 */
export async function rediscoverSessionIdForHarness(
  harness: string,
  runner: SessionDiscoveryRunner,
  worktreePath: string,
): Promise<string | null> {
  switch (harness) {
    case 'claude-code':
      return (await findLatestSessionFile(runner.agentSessionProjectDir(worktreePath)))?.sessionId ?? null;
    case 'pi':
      return (await findLatestPiSessionFile(runner.agentPiAgentDir(worktreePath), worktreePath))?.sessionId ?? null;
    default:
      return null;
  }
}
