/**
 * Host-side detection of the Claude session a builder container was running.
 *
 * WHY THIS EXISTS (the upgrade-relaunch-resume bug): in docker mode the host
 * runner returns `sessionId: null` — only the in-container supervisor diffs the
 * JSONL files and learns the id, and it stamps that id onto the builder resume
 * intent from its EXIT path (src/supervisor/builder.ts). But `lazy upgrade`
 * stopped builder containers with `docker kill` (SIGKILL), so the supervisor's
 * exit path — and its signal handler — never ran. Nothing was ever stamped, the
 * relaunch loop's `hintId` was null, and it fell through to "newest captured
 * conversation in the whole project", which is not necessarily this builder's
 * session. The relaunched builder therefore did not resume the conversation.
 *
 * Exit-time stamping is inherently lossy: it cannot survive SIGKILL, a container
 * OOM, a crashed supervisor, or a machine that goes to sleep. So the host learns
 * the id ITSELF, from evidence that is already on the host: Claude writes its
 * session JSONL into the projects dir the host bind-mounted into the container,
 * so `<projects>/<encoded-cwd>/<sessionId>.jsonl` is visible host-side the whole
 * time the session runs. Whatever kills the container, the file is still there.
 *
 * This is recovery, not stamping — it needs no cooperation from the thing that
 * died, which is exactly the property exit-time stamping lacked. The supervisor's
 * stamp is kept (it is the authoritative in-container view and now also runs on
 * SIGTERM), and this detection backs it up.
 */

import { join } from 'path';
import { discoverProjectSessionFiles } from '../import/claude-code-logs';
import { getHome } from '../utils/home';
import { logger } from '../utils/logger';

/** One candidate session file, reduced to what the picker needs. */
export interface SessionFileCandidate {
  sessionId: string;
  mtimeMs: number;
}

/**
 * Pick the session a launch was running, from the session files visible after it
 * ended.
 *
 * Pure so the resolution order is unit-testable without a filesystem.
 *
 * The rule mirrors the supervisor's own ownership rule (pickActiveSessionFile):
 * a file this launch owns is one that was created OR modified after the container
 * started, and the live tail of the conversation is the NEWEST of those. A single
 * run spans several JSONL files — `/clear`, compaction and resume each roll
 * Claude to a fresh `<uuid>.jsonl` — so "newest owned" is the resume target, not
 * the id the run was launched with.
 *
 * Pre-launch files are excluded by the `launchedAtMs` cut. That is what keeps
 * host-SEEDED copies out: seedProjectsDirFromHistory copies prior sessions into
 * the dir before the container starts and deliberately preserves their original
 * mtimes (see projects-isolation.ts), so they sort as old and are never mistaken
 * for this run's live session.
 *
 * Falls back to `resumeId` when nothing was touched — a session that was resumed
 * and then exited without Claude writing anything is still that session.
 */
export function pickLaunchSessionId(
  files: SessionFileCandidate[],
  launchedAtMs: number,
  resumeId: string | null,
): string | null {
  let newestId: string | null = null;
  let newestMtime = -1;
  for (const f of files) {
    if (f.mtimeMs < launchedAtMs) continue;
    if (f.mtimeMs > newestMtime) {
      newestMtime = f.mtimeMs;
      newestId = f.sessionId;
    }
  }
  return newestId ?? resumeId;
}

/**
 * Detect the Claude session id a just-exited builder launch was running, by
 * inspecting the session JSONL files on the host.
 *
 * Scan order matters. The per-builder isolation dir (when one was resolved for
 * this launch) is unambiguous — every file in it belongs to THIS builder — so it
 * is consulted first. Only when it yields nothing do we look at the shared
 * `~/.claude/projects` dir, which is where sessions land when the isolation mount
 * was dropped (the container-user write-probe failed) or when isolation is off
 * entirely. The shared dir cannot distinguish concurrent builders of the same
 * repo; that ambiguity is the pre-existing, already-warned-about degraded mode
 * (see docker-runner's "Concurrent builders may cross-capture sessions"), and a
 * best-effort answer there is strictly better than the previous none.
 *
 * NEVER throws: this runs on the builder's exit path, where the only thing worse
 * than not knowing the session id is turning a normal quit into a crash. A
 * failure is logged and reported as `resumeId` (or null).
 */
export async function detectBuilderLaunchSessionId(opts: {
  /** Repo root — its encoded form names the projects subdir. */
  lazyRoot: string;
  /** Per-builder isolation dir mounted at ~/.claude/projects, if any. */
  projectsHostDir?: string;
  /** Wall-clock ms captured immediately before the container was launched. */
  launchedAtMs: number;
  /** The `--resume <id>` this launch was started with, if any. */
  resumeId: string | null;
  /** Host home holding the shared ~/.claude/projects dir. Injectable for tests. */
  homeDirAbs?: string;
}): Promise<string | null> {
  const { lazyRoot, projectsHostDir, launchedAtMs, resumeId, homeDirAbs = getHome() } = opts;

  const scan = async (projectsDir: string): Promise<string | null> => {
    const files = await discoverProjectSessionFiles(lazyRoot, projectsDir);
    // `null` resumeId here on purpose: the resume fallback is applied ONCE, by
    // the caller below, after every candidate dir has been scanned. Applying it
    // per-dir would let the isolation dir answer `resumeId` and stop the scan
    // before the shared dir — where a newer segment may actually live — is seen.
    return pickLaunchSessionId(files, launchedAtMs, null);
  };

  try {
    if (projectsHostDir) {
      const isolated = await scan(projectsHostDir);
      if (isolated) return isolated;
    }
    const shared = await scan(join(homeDirAbs, '.claude', 'projects'));
    return shared ?? resumeId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `Could not determine which Claude session this builder was running ` +
      `(${msg}). Auto-resume after an upgrade may need a manual ` +
      `\`lazy builder --resume <id>\`.`,
    );
    return resumeId;
  }
}
