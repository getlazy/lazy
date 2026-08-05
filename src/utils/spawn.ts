import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { which } from 'bun';
import { assertArgvSafe } from './sanitize-text';

/**
 * Default subprocess timeout in milliseconds.
 *
 * Applied to all async spawn() calls unless explicitly overridden.
 * Prevents hanging subprocesses (SSH prompts, credential helpers,
 * rate-limited CLI tools) from blocking the daemon event loop
 * indefinitely. When the timeout fires, the process is killed
 * with SIGTERM and the `exited` promise resolves with the signal
 * exit code.
 *
 * Set to 0 to disable (not recommended for daemon code paths).
 */
export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 60_000; // 60 seconds

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
 * Drop-in replacement for Bun.spawn that produces clear error messages on ENOENT
 * and enforces a default subprocess timeout.
 *
 * When Bun.spawn fails with ENOENT because a stdout/stderr file's parent directory
 * doesn't exist, Bun misleadingly reports the error against the binary path. This
 * wrapper catches that and provides a diagnostic message identifying the actual
 * missing path.
 *
 * Timeout behavior: by default, subprocesses are killed with SIGTERM after
 * DEFAULT_SUBPROCESS_TIMEOUT_MS (60s). Override with `timeout` in options
 * (in milliseconds), or pass 0 to disable. The timer is cleaned up when the
 * process exits normally.
 *
 * Argv safety: a NUL byte anywhere in argv makes the spawn fail with an opaque
 * `The argument 'args[N]' must be a string without null bytes`. That message
 * names no command and suggests no fix, and when it happens on an agent turn
 * it fails instantly enough to trip crash-loop detection. We pre-check and
 * raise an actionable error instead.
 */
export function spawn<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "inherit",
>(
  cmd: string[],
  options?: Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { timeout?: number },
): Bun.Subprocess<In, Out, Err> {
  assertArgvSafe(cmd, cmd[0]);

  // Extract timeout before passing to Bun.spawn (not a native Bun option)
  const timeout = (options as any)?.timeout ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;
  const bunOptions = options ? { ...options } : undefined;
  if (bunOptions) {
    delete (bunOptions as any).timeout;
  }

  try {
    const proc = Bun.spawn(cmd, bunOptions as any);

    // Set up kill timer for async subprocesses
    if (timeout > 0) {
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // Process may have already exited
        }
      }, timeout);
      // Clean up timer when process exits naturally
      proc.exited.then(() => clearTimeout(timer), () => clearTimeout(timer));
    }

    return proc as Bun.Subprocess<In, Out, Err>;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      const diagnosis = diagnoseEnoent(cmd, bunOptions ?? {});
      if (diagnosis) {
        throw new Error(diagnosis, { cause: err });
      }
    }
    throw err;
  }
}

/**
 * Drop-in replacement for Bun.spawnSync with ENOENT diagnosis and the same
 * argv NUL guard as the async `spawn()` above.
 */
export function spawnSync<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "pipe",
>(
  cmd: string[],
  options?: Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err>,
): Bun.SyncSubprocess<Out, Err> {
  assertArgvSafe(cmd, cmd[0]);

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
