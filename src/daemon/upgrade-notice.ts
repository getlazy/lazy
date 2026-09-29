/**
 * Daemon upgrade notice — the trivial built-in system-message producer.
 *
 * On startup the daemon compares its own version with the version recorded at
 * the previous startup for this project. When they differ it files ONE system
 * message (kind 'notice', source 'daemon') so the human learns the project's
 * daemon changed under them — and so the system-messages pipeline is exercised
 * end to end by a real producer from day one.
 *
 * The last-seen marker is HOUSEKEEPING, not a persistent domain object, so it
 * lives with the rest of the daemon's per-project state (pidfile, token, log —
 * see src/daemon/paths.ts) rather than behind Storage (test: it would never
 * make sense in Postgres — it describes this machine's daemon, not the
 * project's data). NOT in the repo's `.lazy/`: user projects may commit parts
 * of that directory, and an unignored marker there dirtied worktrees on every
 * daemon start. The message itself is domain state and goes through Storage.
 */

import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { getDaemonDir } from './paths';
import { logger } from '../utils/logger';
import type { Storage } from '../storage';
import { runningBuildIdentity } from '../utils/build-provenance';

const MARKER_FILE = 'daemon-last-version.json';

interface VersionMarker {
  version: string;
  /** `branch@sha, clean|dirty` of that start, when it could be determined. */
  build?: string | null;
}

/** `0.90.4100 (main@abc1234, clean)`, or the bare version when no build is known. */
function label(version: string, build: string | null | undefined): string {
  return build ? `${version} (${build})` : version;
}

/**
 * Compare the running version against the marker and file an upgrade notice
 * when they differ. Always rewrites the marker to the current version.
 *
 * Never throws: a failure here is logged and the daemon starts anyway — an
 * upgrade notice is not worth a failed launch. The very first start (no
 * marker) records the version silently; "lazy started existing" is not news.
 */
export async function maybePostUpgradeNotice(
  projectRoot: string,
  getStorage: () => Promise<Storage>,
): Promise<void> {
  let version: string;
  try {
    version = (await import('../version')).VERSION;
  } catch {
    // No generated version file (source checkout without a build step in some
    // test contexts) — nothing meaningful to compare or record.
    return;
  }

  // Which commit, not only which version: two builds of one version are
  // different code, and "is this daemon up to date" is asked of the SHA.
  // Display only — a notice still fires on a VERSION change, as before.
  let build: string | null = null;
  try {
    build = await runningBuildIdentity();
  } catch (err) {
    logger.warn(`Could not determine the daemon's build identity: ${err instanceof Error ? err.message : String(err)}`);
  }

  const markerDir = getDaemonDir(projectRoot);
  const markerPath = join(markerDir, MARKER_FILE);

  try {
    let previous: string | null = null;
    let previousBuild: string | null = null;
    try {
      const raw = await readFile(markerPath, 'utf-8');
      const parsed = JSON.parse(raw) as VersionMarker;
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        previous = parsed.version;
        previousBuild = typeof parsed.build === 'string' ? parsed.build : null;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Present but unreadable/corrupt: treat as first start (no notice) but
        // say so — silently guessing a previous version would fabricate news.
        logger.warn(`Could not read ${markerPath}: ${err instanceof Error ? err.message : String(err)}. Re-recording the current daemon version.`);
      }
    }

    if (previous !== null && previous !== version) {
      const storage = await getStorage();
      await storage.createSystemMessage({
        source: 'daemon',
        kind: 'notice',
        title: `Daemon version changed: ${label(previous, previousBuild)} → ${label(version, build)}`,
        body:
          `The daemon for this project started as version **${label(version, build)}**; the previous start was **${label(previous, previousBuild)}**.\n\n` +
          `Nothing to do — this is a heads-up that new daemon code is now serving the project. ` +
          `If running tasks behave unexpectedly after an upgrade, \`lazy daemon status\` shows what is running and \`CHANGELOG.md\` what changed.`,
      });
      logger.info(`Filed system message: daemon version changed ${previous} → ${version}`);
    }

    await mkdir(markerDir, { recursive: true });
    await writeFile(markerPath, JSON.stringify({ version, build } satisfies VersionMarker, null, 2) + '\n', 'utf-8');
  } catch (err) {
    logger.error(
      `Failed to record/report the daemon version change: ${err instanceof Error ? err.message : String(err)}. ` +
      'The daemon is starting anyway.',
    );
  }
}
