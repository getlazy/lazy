/**
 * Helpers for presenting `docker build` output to a human while it runs.
 *
 * An image build is the longest thing lazy ever does, and it used to print
 * nothing at all until it exited: output was buffered and dumped to the log
 * file afterwards. A silent multi-minute command is indistinguishable from a
 * hung one, which is exactly how a build that lazy itself killed on a timer
 * got mistaken for Docker dying.
 *
 * Now that builds are unbounded by default, showing progress is not a nicety —
 * it is the only thing telling the human the build is alive.
 */

/**
 * Whether a line of build output is worth echoing to the console.
 *
 * Docker's layer output is overwhelmingly noise (every apt line, every
 * download percentage), so only the STRUCTURE is echoed: which step is running
 * and how each one ended. Everything else still reaches the log file via
 * `logger.stream`, so `--verbose` and the log are unchanged.
 *
 * Two builders are covered, because which one runs depends on the daemon's
 * BuildKit setting and not on anything lazy controls:
 *
 * - BuildKit plain progress: `#7 [3/9] RUN apt-get update`, `#7 DONE 4.1s`,
 *   `#7 CACHED`, `#7 ERROR: ...`
 * - The classic builder: `Step 3/9 : RUN apt-get update`
 */
export function isBuildProgressLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;

  // BuildKit step headers and terminal states. The bare `#N <digits>.<digits>`
  // form is a step's own stdout (`#7 0.412 Get:1 http://...`) and is noise.
  if (/^#\d+\s+(\[|DONE\b|CACHED\b|ERROR\b|ERROR:)/.test(trimmed)) return true;

  // Classic builder.
  if (/^Step\s+\d+\/\d+\s*:/.test(trimmed)) return true;
  if (/^Successfully (built|tagged)\b/.test(trimmed)) return true;

  return false;
}

/**
 * Split a chunk of streamed bytes into whole lines, returning the trailing
 * partial line for the caller to prepend to the next chunk. Docker writes
 * progress in chunks that do not respect line boundaries, so echoing raw
 * chunks would cut step headers in half.
 */
export function splitLines(buffered: string): { lines: string[]; remainder: string } {
  const parts = buffered.split('\n');
  const remainder = parts.pop() ?? '';
  return { lines: parts, remainder };
}

/** Human-readable duration: `90000` → `1m30s`, `45000` → `45s`, `60` → `60ms`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

/**
 * The error a human sees when an OPT-IN build timeout actually fires.
 *
 * This message exists because of the exact confusion that motivated removing
 * the old hardcoded 20-minute bound: a killed build surfaced as a bare non-zero
 * exit code and read as "Docker is broken", sending the engineer off rebuilding
 * repeatedly. So it says, in order: lazy did this, after how long, and that the
 * bound belongs to the human.
 */
export function buildTimeoutMessage(elapsedMs: number, timeoutMs: number): string {
  return [
    `Container build timed out after ${formatDuration(timeoutMs)} — lazy killed it; Docker did not fail.`,
    ``,
    `That bound came from your \`--timeout\` flag. Image builds are UNBOUNDED by`,
    `default: raise the value, pass \`--timeout 0\`, or just drop the flag.`,
    `Layers built before the kill stay in the build cache, so a retry resumes rather`,
    `than starting over.`,
    ``,
    `Elapsed before the kill: ${formatDuration(elapsedMs)}.`,
  ].join('\n');
}
