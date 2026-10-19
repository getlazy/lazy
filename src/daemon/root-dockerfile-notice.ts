/**
 * Tell the people on a project, once, that its committed Dockerfile.lazy is not
 * being used because this install's backend never auto-builds it.
 *
 * The launch narration and the agent's instructions already say so, but a
 * launch's narration reaches only a caller that is listening for it — Lazy
 * Teams starts and unblocks without one, and a turn the daemon starts itself
 * has no listener at all. A system message is what every surface (Teams'
 * messages page, `lazy messages`, the dashboard) shows, so it is the channel
 * that makes this not silent.
 *
 * Filed ONCE PER COMMITTED BLOB: the reconciler runs this every tick, and
 * re-filing whenever no undismissed copy existed undid every dismissal within
 * seconds. Each notice names its blob ("Committed version: <sha12>"), and one
 * for that blob — open OR dismissed — is never filed again, across daemon
 * restarts too (Teams restarts every daemon on each upgrade). A human's
 * dismissal therefore holds until the accepted Dockerfile.lazy changes. Between those
 * events a tick costs one `git rev-parse` — the inspection re-runs only when
 * the root's HEAD moves.
 */

import type { Storage } from '../storage/interface';
import type { SystemMessage } from '../types';
import { autoBuildsRootDockerfile } from '../config/managed-mode';
import { loadConfig } from '../config/loader';
import {
  inspectConventionalDockerfile,
  ROOT_DOCKERFILE_SKIPPED_ON_BACKEND,
  CONVENTIONAL_DOCKERFILE,
} from '../capture/claude';

export const ROOT_DOCKERFILE_NOTICE_SOURCE = 'task-image';
export const ROOT_DOCKERFILE_NOTICE_TITLE = `This project's ${CONVENTIONAL_DOCKERFILE} is not being used`;

/** Per project root: the HEAD last inspected and the blob last announced. */
const lastSeen = new Map<string, { head: string; announcedBlob: string | null }>();

/** Test seam: forget what this process has announced. */
export function resetRootDockerfileNoticeMemory(): void {
  lastSeen.clear();
}

async function rootHead(lazyRoot: string): Promise<string> {
  const { spawn } = await import('../utils/spawn');
  const proc = spawn(['git', 'rev-parse', '-q', '--verify', 'HEAD'], {
    cwd: lazyRoot, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  // Exit 1 is an unborn branch; anything else non-zero is left to the
  // inspection below, which throws with git's own words.
  return exitCode === 0 ? stdout.trim() : `exit-${exitCode}`;
}

function isNotice(message: SystemMessage): boolean {
  return (
    message.kind === 'notice' &&
    message.source === ROOT_DOCKERFILE_NOTICE_SOURCE &&
    message.title === ROOT_DOCKERFILE_NOTICE_TITLE
  );
}

/** The line naming the committed version a notice is about. */
function versionLine(blob: string): string {
  return `Committed version: ${blob.substring(0, 12)}`;
}

/**
 * File the notice when the committed root Dockerfile.lazy is skipped by this
 * backend, unless an open copy exists. Returns the message it filed or found,
 * or null when there is nothing to say. Cheap when the backend builds the file
 * (no git, no storage read), which is every unmanaged daemon.
 */
export async function maybePostRootDockerfileNotice(
  storage: Pick<Storage, 'listSystemMessages' | 'createSystemMessage'>,
  lazyRoot: string,
): Promise<SystemMessage | null> {
  if (autoBuildsRootDockerfile()) return null;
  const config = await loadConfig(lazyRoot);
  if (config.docker.dockerfile) return null; // the owner chose explicitly

  const head = await rootHead(lazyRoot);
  const seen = lastSeen.get(lazyRoot);
  if (seen && seen.head === head) return null;

  // Recorded BEFORE inspecting: a HEAD the inspection refuses (a task branch
  // checked out mid-accept) is reported once, not on every tick until it moves.
  const announced = seen?.announcedBlob ?? null;
  lastSeen.set(lazyRoot, { head, announcedBlob: announced });
  const state = await inspectConventionalDockerfile(lazyRoot);
  const blob = state.kind === 'not-built-on-backend' ? state.blob : null;
  if (blob === null) lastSeen.set(lazyRoot, { head, announcedBlob: null });
  if (blob === null || blob === announced) return null;

  // The durable half of "once per blob": every notice names the version it is
  // about, so a copy for THIS blob — open or dismissed, from this process or
  // one before a restart — means it was already said.
  const marker = versionLine(blob);
  const all = await storage.listSystemMessages({ includeDismissed: true });
  lastSeen.set(lazyRoot, { head, announcedBlob: blob });
  const already = all.find(m => isNotice(m) && m.body.includes(marker));
  if (already) return already.dismissed_at === undefined ? already : null;

  return storage.createSystemMessage({
    source: ROOT_DOCKERFILE_NOTICE_SOURCE,
    kind: 'notice',
    title: ROOT_DOCKERFILE_NOTICE_TITLE,
    body:
      `${ROOT_DOCKERFILE_SKIPPED_ON_BACKEND}.\n\n` +
      `${marker}\n\n` +
      `Tasks on this project run on the base image, so toolchains an agent added to ` +
      `${CONVENTIONAL_DOCKERFILE} are not installed in new task containers. The project owner can use ` +
      `the file anyway by naming it in the project configuration: \`[docker] dockerfile = "${CONVENTIONAL_DOCKERFILE}"\`.`,
  });
}
