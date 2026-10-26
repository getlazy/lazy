/**
 * A task's persistent data directory: `$LAZY_TASK_DATA` (= /lazy/data) in
 * every container lazy runs for the task — its turns' container and every
 * member container (Shell, Pair, Chat) — backed by one NAMED VOLUME per task
 * in the task's own engine.
 *
 * It exists for services' data (Postgres, Redis …): it lives outside git and
 * outside the worktree, so it survives container recreation, daemon restarts,
 * image changes and machine restarts, and nothing that cleans a worktree
 * reaches it.
 *
 * NAMED BY THE TASK'S UUID, never its code: a volume name is global to the
 * engine, and on a shared engine (Teams' local Docker, one Docker Desktop
 * serving several projects) two projects may well have tasks with the same
 * code — one project would then mount, or delete, the other's data.
 *
 * Lazy never chowns, prunes or frees anything INSIDE it while the task is
 * open. The one ownership change is the volume's top directory when the engine
 * has just created it root-owned (`claimTaskDataDirShell`) — never its
 * contents, and never again once claimed. It is removed only at the task's
 * terminal teardown (`removeTaskDataVolume`, from cleanupTaskContainer) or by a
 * person through finished-task cleanup. Resetting a machine's Docker storage
 * deletes it too, as it deletes every volume; that reset says so.
 */
import { spawn } from '../utils/spawn';

export const TASK_DATA_MOUNT = '/lazy/data';
export const TASK_DATA_ENV = 'LAZY_TASK_DATA';
/** Label on a task container created with the data mount and the root-only adopt rule. */
export const TASK_DATA_LABEL = 'lazy.task-data';
export const TASK_DATA_VOLUME_PREFIX = 'lazy-data-';

/** Volume name for a task: its full UUID, unique across every project on the engine. */
export function taskDataVolumeName(taskUuid: string): string {
  return `${TASK_DATA_VOLUME_PREFIX}${taskUuid}`;
}

/** `docker run` args mounting the task's data volume and announcing it. Docker creates the volume on first use. */
export function taskDataMountArgs(volume: string, readOnly = false): string[] {
  return [
    '--mount', `type=volume,src=${volume},dst=${TASK_DATA_MOUNT}${readOnly ? ',readonly' : ''}`,
    '-e', `${TASK_DATA_ENV}=${TASK_DATA_MOUNT}`,
  ];
}

/**
 * Shell: when the volume's top directory is still root-owned (the engine just
 * created it), hand THAT DIRECTORY ONLY to the container user. Contents are
 * never touched; once claimed, this is a no-op for good.
 */
export function claimTaskDataDirShell(): string {
  return `if [ -d ${TASK_DATA_MOUNT} ] && [ "$(stat -c %u ${TASK_DATA_MOUNT} 2>/dev/null)" = 0 ] && [ "$(id -u)" != 0 ]; then ` +
    `sudo -n chown "$(id -u):$(id -g)" ${TASK_DATA_MOUNT} 2>/dev/null || echo "lazy: could not make ${TASK_DATA_MOUNT} writable" >&2; fi`;
}

async function runEngine(argv: string[], timeout: number): Promise<{ code: number; out: string; err: string }> {
  const p = spawn(argv, { stdout: 'pipe', stderr: 'pipe', timeout });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code: code ?? 1, out, err };
}

/** Remove a task's data volume. A volume that does not exist is already gone. Throws on any other failure. */
export async function removeTaskDataVolume(binary: string, volume: string): Promise<void> {
  const r = await runEngine([binary, 'volume', 'rm', volume], 60_000);
  if (r.code === 0 || /no such volume/i.test(r.err)) return;
  throw new Error(`${binary} could not remove the task data volume ${volume}: ${r.err.trim() || `exit ${r.code}`}`);
}

/** Names of the task data volumes on this engine (cheap: no sizes). */
export async function listTaskDataVolumeNames(binary: string): Promise<Set<string>> {
  const r = await runEngine([binary, 'volume', 'ls', '--filter', `name=${TASK_DATA_VOLUME_PREFIX}`, '--format', '{{.Name}}'], 15_000);
  if (r.code !== 0) throw new Error(`${binary} could not list volumes: ${r.err.trim() || `exit ${r.code}`}`);
  return new Set(r.out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(TASK_DATA_VOLUME_PREFIX)));
}

/**
 * Size in bytes of the data dir, measured inside the task's RUNNING container
 * (`du`), bounded to a few seconds so a page that shows it never waits on the
 * engine. Null when it cannot be measured now (no running container, timeout).
 */
export async function measureTaskDataBytes(binary: string, runName: string): Promise<number | null> {
  try {
    const r = await runEngine([binary, 'exec', runName, 'du', '-sk', TASK_DATA_MOUNT], 4_000);
    if (r.code !== 0) return null;
    const kib = Number(r.out.trim().split(/\s+/)[0]);
    return Number.isFinite(kib) ? kib * 1024 : null;
  } catch {
    // Measuring is informational: an engine that cannot answer within the
    // bound means "size unknown right now", which the caller reports as null.
    return null;
  }
}

/** Shared diagnosis for Services and doctor; an upgrade never replaces this environment. */
export const OLD_TASK_ENVIRONMENT_NOTICE = "This environment was created before lazy kept a data directory and left services' files alone. Restart the environment to get both. A restart loses anything installed outside the worktree and what running services hold in memory.";
