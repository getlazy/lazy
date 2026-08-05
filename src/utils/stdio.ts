/**
 * Writing bulk output to stdout without losing the tail.
 *
 * WHY THIS EXISTS (measured on Bun 1.3.14, not assumed):
 *
 * When stdout is a **pipe** — `lazy ask … | less`, output captured by a test
 * harness or an editor's terminal pane — writes are asynchronous. `process.exit()`
 * terminates immediately and does NOT drain what is still queued, so the tail of
 * a large write is lost:
 *
 *   process.stdout.write('y'.repeat(5_000_000)); process.exit(0);
 *
 * piped into a slow reader delivers exactly 65536 bytes — one pipe buffer — and
 * silently drops the other 4.9 MB. Exit code 0, nothing logged, no error.
 *
 * WHY THE FIX IS HERE AND NOT IN THE SHARED EXIT PATH
 *
 * The obvious fix is a `flushStdio()` awaited in `src/index.ts` before
 * `process.exit(0)`, so every command is covered at one choke point. That cannot
 * be built on Bun: at exit time there is no way to ask whether bytes are still
 * queued. All three candidate signals were measured and all three are useless:
 *
 *   process.stdout.writableLength      -> 0        (while 4.9 MB is pending)
 *   process.stdout.writableNeedDrain   -> false    (while 4.9 MB is pending)
 *   process.stdout.write('')           -> true     (while 4.9 MB is pending)
 *   process.stdout.write('', callback) -> fires immediately, before the flush
 *
 * The ONLY reliable signal is the boolean returned by the actual bulk write,
 * followed by the stream's `drain` event — and that is only available at the
 * call site, while the write is happening. Hence a writer helper rather than an
 * exit hook. A command that emits bulk output must use {@link writeStdout};
 * `console.log` (synchronous on Bun today) is fine for short, line-sized output.
 */

/**
 * How long to wait for a drain before giving up and returning.
 *
 * Bounded on purpose: if the reader has stopped consuming (`| head -1`, a closed
 * pager) the stream will never drain, and an unbounded await would hang the CLI
 * forever — a worse failure than a truncated tail. Two seconds is far beyond any
 * local pipe's needs while still terminating promptly against a dead reader.
 */
const DRAIN_TIMEOUT_MS = 2_000;

/**
 * Write `text` to stdout and resolve only once it has actually been handed to
 * the OS.
 *
 * Safe to `await` immediately before `process.exit()` — which is the entire
 * point. Returns when the write completed, when the reader went away, or when
 * {@link DRAIN_TIMEOUT_MS} elapses, whichever comes first.
 */
export async function writeStdout(text: string): Promise<void> {
  // `write` returns false when the data did not fit in the kernel buffer. That
  // return value is the only trustworthy backpressure signal Bun gives us, and
  // it is available *only* here, at the moment of the write.
  const flushed = process.stdout.write(text);
  if (flushed) return;

  await new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdout.off('drain', finish);
      process.stdout.off('error', finish);
      resolve();
    };

    const timer = setTimeout(finish, DRAIN_TIMEOUT_MS);
    process.stdout.once('drain', finish);
    // EPIPE (reader closed) is not worth reporting: the bytes have nowhere to
    // go and the caller is on its way out. Resolving beats hanging.
    process.stdout.once('error', finish);
  });
}

/** {@link writeStdout} with a trailing newline — the `console.log` shape. */
export function writeStdoutLine(text: string): Promise<void> {
  return writeStdout(text + '\n');
}
