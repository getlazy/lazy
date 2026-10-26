/**
 * Where each agent harness keeps the conversation a member's Pair or Chat
 * resumes, relative to an agent HOME — the task sandbox (`.lazy-task-sandbox/`,
 * the home a turn runs in) or a member's own home (./member-container.ts).
 *
 * The member home carries exactly ONE transcript in — the session the task's
 * agent is on — and hands it (and any session the member started) back when the
 * home closes. These are the files that do that for each harness; the layouts
 * are the ones lazy's own readers already rely on:
 *
 *   - Claude Code: `.claude/projects/<encoded worktree>/<session id>.jsonl`.
 *   - Codex: `.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl`
 *     (src/agent/codex.ts). Checked against codex-cli 0.164.0: a home holding
 *     only that file resumes it with `codex resume <id>`, and an id with no
 *     rollout fails ("no rollout found for thread id").
 *   - Pi: `.pi/agent/sessions/--<worktree, slashes as dashes>--/<timestamp>_<session id>.jsonl`
 *     (src/agent/pi.ts; the spelling test/e2e/pair.test.ts writes for the real
 *     pi binary).
 *   - Cursor: none. Its chat store's layout is undocumented (src/agent/cursor.ts
 *     reads no session files), so a member's Cursor session starts a new
 *     conversation rather than lazy copying files it cannot name.
 *
 * Listing never follows a link: a turn can plant one in the sandbox.
 */

import { join } from 'path';
import { lstat, readdir } from 'fs/promises';
import { encodeProjectPath } from '../import/claude-code-logs';

/** Where one harness keeps a worktree's sessions, relative to an agent home. */
export interface SessionArea {
  /** Directory, relative to the home. */
  dir: string;
  /** Levels of subdirectories under {@link dir} that hold transcripts. */
  depth: number;
  /** Whether a file name there is a transcript at all. */
  isTranscript: (name: string) => boolean;
  /** Whether a transcript file name belongs to this session id. */
  isSession: (name: string, sessionId: string) => boolean;
}

/** The session area for this harness, or null when lazy carries none (Cursor). */
export function sessionArea(harness: string, worktreePath: string): SessionArea | null {
  if (harness === 'claude-code') {
    return {
      dir: join('.claude', 'projects', encodeProjectPath(worktreePath)),
      depth: 0,
      isTranscript: (name) => name.endsWith('.jsonl'),
      isSession: (name, id) => name === `${id}.jsonl`,
    };
  }
  if (harness === 'codex') {
    return {
      dir: join('.codex', 'sessions'),
      depth: 3,
      isTranscript: (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
      isSession: (name, id) => name.startsWith('rollout-') && name.endsWith(`-${id}.jsonl`),
    };
  }
  if (harness === 'pi') {
    return {
      dir: join('.pi', 'agent', 'sessions', `--${worktreePath.replace(/^\//, '').replace(/\//g, '-')}--`),
      depth: 0,
      isTranscript: (name) => name.endsWith('.jsonl'),
      isSession: (name, id) => name.endsWith(`_${id}.jsonl`),
    };
  }
  return null;
}

/**
 * Every transcript in `area` under `home`, as paths relative to `home`. A
 * missing directory is an empty list; links are skipped, never followed.
 */
export async function listTranscripts(home: string, area: SessionArea): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(join(home, rel));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw err;
    }
    for (const name of names) {
      const childRel = join(rel, name);
      const st = await lstat(join(home, childRel));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (depth > 0) await walk(childRel, depth - 1);
      } else if (st.isFile() && depth === 0 && area.isTranscript(name)) {
        out.push(childRel);
      }
    }
  };
  // The area's own directory must not be a link either.
  try {
    const st = await lstat(join(home, area.dir));
    if (st.isSymbolicLink() || !st.isDirectory()) return [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw err;
  }
  await walk(area.dir, area.depth);
  return out.sort();
}

/** The transcript of `sessionId` under `home`, relative to it, or null. */
export async function findSessionTranscript(home: string, area: SessionArea, sessionId: string): Promise<string | null> {
  const found = (await listTranscripts(home, area)).filter((rel) => area.isSession(rel.split('/').pop()!, sessionId));
  return found[0] ?? null;
}
