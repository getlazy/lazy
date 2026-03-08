import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { which } from 'bun';

/**
 * Extract file path from a spawn stdio option, if it's a BunFile.
 * BunFile objects have a `name` property containing the file path.
 */
function extractFilePath(stdio: unknown): string | null {
  if (stdio && typeof stdio === 'object' && 'name' in stdio && typeof (stdio as { name: unknown }).name === 'string') {
    return (stdio as { name: string }).name;
  }
  return null;
}

/**
 * Diagnose ENOENT errors from Bun.spawn by checking which path is actually missing.
 * Bun misleadingly reports ENOENT against the binary when the real problem is a
 * missing parent directory for stdout/stderr file redirection.
 */
function diagnoseEnoent(
  cmd: string[],
  options: { cwd?: unknown; stdout?: unknown; stderr?: unknown },
): string | null {
  // Check cwd first — posix_spawn reports ENOENT against the binary when cwd doesn't exist
  if (options.cwd && !existsSync(String(options.cwd))) {
    return `spawn failed: working directory '${options.cwd}' does not exist`;
  }

  // Check stdout/stderr file paths first — this is the common misdiagnosis case
  for (const stream of ['stdout', 'stderr'] as const) {
    const filePath = extractFilePath(options[stream]);
    if (filePath) {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        return `spawn failed: directory '${dir}' does not exist (needed for ${stream} redirection to '${filePath}')`;
      }
    }
  }

  // Check if the binary itself is missing
  const binary = cmd[0];
  if (binary && !existsSync(binary) && !which(binary)) {
    return `spawn failed: binary '${binary}' not found`;
  }

  return null;
}

/**
 * Drop-in replacement for Bun.spawn that produces clear error messages on ENOENT.
 *
 * When Bun.spawn fails with ENOENT because a stdout/stderr file's parent directory
 * doesn't exist, Bun misleadingly reports the error against the binary path. This
 * wrapper catches that and provides a diagnostic message identifying the actual
 * missing path.
 */
export function spawn<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "inherit",
>(
  cmd: string[],
  options?: Bun.SpawnOptions.SpawnOptions<In, Out, Err>,
): Bun.Subprocess<In, Out, Err> {
  try {
    return Bun.spawn(cmd, options as any);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      const diagnosis = diagnoseEnoent(cmd, options ?? {});
      if (diagnosis) {
        throw new Error(diagnosis, { cause: err });
      }
    }
    throw err;
  }
}

/**
 * Drop-in replacement for Bun.spawnSync with ENOENT diagnosis.
 */
export function spawnSync<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "pipe",
>(
  cmd: string[],
  options?: Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err>,
): Bun.SyncSubprocess<Out, Err> {
  try {
    return Bun.spawnSync(cmd, options as any);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      const diagnosis = diagnoseEnoent(cmd, options ?? {});
      if (diagnosis) {
        throw new Error(diagnosis, { cause: err });
      }
    }
    throw err;
  }
}
