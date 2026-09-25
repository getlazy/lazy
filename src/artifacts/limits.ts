/**
 * Bounds on task artifacts.
 *
 * WHY FIXED CONSTANTS AND NOT CONFIG: these are enforced inside the storage
 * backends, which are the one choke point every writer (CLI, MCP, daemon RPC)
 * passes through — and storage is constructed without a project config in
 * several paths. A config key that only *some* backends could read would be a
 * bound in name only. Raising these is a deliberate code change, which is the
 * right friction for a limit whose whole job is to keep a task's history from
 * growing without bound.
 *
 * The numbers are sized for what artifacts are FOR: a handful of design files,
 * a spec, a screenshot, a report. The motivating incident was nine HTML/CSS/JSON
 * files totalling well under a megabyte. Anything that wants more than this is a
 * blob store, and lazy is not one — see the proxy audit log (CLAUDE.md), which
 * grew to 677 MiB inside the store and broke a real push.
 */

/** Largest single artifact, in bytes (1 MiB). */
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

/** Largest total across one task's artifacts, in bytes (8 MiB). */
export const MAX_TASK_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Most artifacts one task may carry. */
export const MAX_TASK_ARTIFACT_COUNT = 64;

/** Longest artifact name, in characters. */
export const MAX_ARTIFACT_NAME_LENGTH = 200;

/** Human-readable byte size for error messages and listings. */
export function formatArtifactBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Thrown when an attach would breach a bound. A distinct class so the CLI and
 * the MCP boundary can report it as a limit rather than as an unknown failure.
 */
export class ArtifactLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactLimitError';
  }
}

/**
 * Enforce the per-file, per-task-total and per-task-count bounds for one attach.
 *
 * `existing` is the task's current artifacts. When the incoming name replaces
 * one of them, its bytes are freed first — replacing a 900 KB file with another
 * 900 KB file must not fail on a total that is not actually growing.
 *
 * Errors name the actual numbers (CLAUDE.md: errors are for humans, and include
 * the values that caused the failure).
 */
export function assertArtifactWithinLimits(
  name: string,
  size: number,
  existing: readonly { name: string; size: number }[],
): void {
  if (size > MAX_ARTIFACT_BYTES) {
    throw new ArtifactLimitError(
      // "per-artifact limit" is the one spelling for this bound — the CLI and
      // MCP pre-flight checks word it the same way, so a user who trips it at
      // either surface reads the same sentence.
      `Artifact '${name}' is ${formatArtifactBytes(size)}, over the ${formatArtifactBytes(MAX_ARTIFACT_BYTES)} per-artifact limit. ` +
      `Artifacts are inputs and outputs, not a blob store — attach a smaller file, or point the task at the data another way.`,
    );
  }

  const others = existing.filter(a => a.name !== name);
  const replacing = others.length !== existing.length;

  if (!replacing && others.length + 1 > MAX_TASK_ARTIFACT_COUNT) {
    throw new ArtifactLimitError(
      `Task already has ${others.length} artifacts, the maximum is ${MAX_TASK_ARTIFACT_COUNT}. ` +
      `Remove one first (lazy artifact rm <task> <name>).`,
    );
  }

  const totalAfter = others.reduce((sum, a) => sum + a.size, 0) + size;
  if (totalAfter > MAX_TASK_ARTIFACT_BYTES) {
    throw new ArtifactLimitError(
      `Attaching '${name}' (${formatArtifactBytes(size)}) would put this task at ` +
      `${formatArtifactBytes(totalAfter)} of artifacts, over the ${formatArtifactBytes(MAX_TASK_ARTIFACT_BYTES)} per-task limit. ` +
      `Remove artifacts you no longer need (lazy artifact rm <task> <name>).`,
    );
  }
}
