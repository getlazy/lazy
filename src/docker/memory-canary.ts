/**
 * A memory-integrity canary: do stores to freshly allocated memory read back?
 *
 * Why: Teams project machines (smolvm microVMs on macOS) stored Docker layer
 * blobs whose bytes no longer matched their digest. The leading explanation is
 * a libkrun race: when guest RAM the host reclaimed (balloon free-page
 * reporting) is lazily remapped on a fault, two vCPUs faulting on the same
 * range can lose a guest store. smolvm 1.29 carries the fix. This canary is
 * how a machine answers "does it still happen?" by itself, with no Docker and
 * no disk in the loop — a mismatch here is memory, not storage.
 *
 * How: CANARY_THREADS Workers (real OS threads, so real vCPUs) each loop for
 * the duration: allocate a buffer of CANARY_BUFFER_BYTES (8 MiB — far above
 * the allocator's large-object threshold, so it is backed by its own mapping
 * and handed back to the kernel when collected, which is what makes the guest
 * report the pages free and lets the host reclaim them), fill it with a
 * pattern unique to (thread, round, word), read it all back, drop it, collect.
 * Every round faults fresh pages, on every thread at once — the race's shape.
 *
 * Whether the allocator returns each buffer's pages to the KERNEL every round
 * (rather than keeping them for reuse) is the allocator's business and is not
 * verified here; the forced collection each round makes it as likely as this
 * process can. What IS certain: every round writes and verifies pages faulted
 * in that round, so a lost store on any of them is caught.
 *
 * Bounds: CANARY_THREADS × one live buffer ≈ 32 MiB, CANARY_DURATION_MS of CPU
 * on those threads, and a hard deadline after which the Workers are
 * terminated. All three are clamped, whatever a caller asks for.
 *
 * The canary cannot be proven in CI to catch the real race (it needs the
 * hypervisor bug). Its detection is tested by injecting a flipped word.
 */

export const CANARY_THREADS = 4;
export const CANARY_DURATION_MS = 30_000;
export const CANARY_BUFFER_BYTES = 8 * 1024 * 1024;
/**
 * Sleep between rounds. Unpaced, one thread does ~240 rounds a second — a
 * whole core each, ~120 CPU-seconds a run. Paced, each thread still faults in
 * and verifies a fresh buffer several times a second (~1,000 rounds a run),
 * for a few CPU-seconds in total.
 */
export const CANARY_ROUND_PAUSE_MS = 100;

/** Hard limits, whatever a caller passes. */
export const CANARY_LIMITS = {
  maxThreads: 4,
  maxDurationMs: 60_000,
  minBufferBytes: 8 * 1024 * 1024,
  maxBufferBytes: 16 * 1024 * 1024,
  /** Mismatches kept per thread (the count is exact; the examples are bounded). */
  maxExamplesPerThread: 4,
  /** Past the duration, how long a Worker may take to answer before it is terminated. */
  graceMs: 15_000,
};

export interface CanaryMismatch {
  thread: number;
  round: number;
  /** Byte offset within that round's buffer. */
  offset: number;
  expected: number;
  actual: number;
}

export interface CanaryResult {
  verdict: 'clean' | 'corrupt' | 'incomplete';
  threads: number;
  durationMs: number;
  bufferBytes: number;
  rounds: number;
  bytesVerified: number;
  mismatchedWords: number;
  examples: CanaryMismatch[];
  /** Why the run is incomplete (a Worker failed or overran), else null. */
  problem: string | null;
}

export interface CanaryOptions {
  threads?: number;
  durationMs?: number;
  bufferBytes?: number;
  /** Sleep between rounds (default CANARY_ROUND_PAUSE_MS; clamped to 0–1000). */
  pauseMs?: number;
  /** Tests only: flip one word in this thread's buffer at this round, after filling. */
  injectCorruption?: { thread: number; round: number; wordIndex: number };
}

/** Clamp a request to the canary's bounds. */
export function clampCanaryOptions(opts: CanaryOptions): { threads: number; durationMs: number; bufferBytes: number } {
  const threads = Math.max(1, Math.min(CANARY_LIMITS.maxThreads, Math.floor(opts.threads ?? CANARY_THREADS)));
  const durationMs = Math.max(1, Math.min(CANARY_LIMITS.maxDurationMs, Math.floor(opts.durationMs ?? CANARY_DURATION_MS)));
  const raw = Math.floor(opts.bufferBytes ?? CANARY_BUFFER_BYTES);
  const bufferBytes = Math.max(CANARY_LIMITS.minBufferBytes, Math.min(CANARY_LIMITS.maxBufferBytes, raw - (raw % 4)));
  return { threads, durationMs, bufferBytes };
}

/** The word stored at `index` in round `round` of thread `thread`. Distinct across rounds, so a stale page from an earlier round is caught too. */
export function canaryWord(thread: number, round: number, index: number): number {
  const seed = (Math.imul(thread + 1, 0x9e3779b1) ^ Math.imul(round + 1, 0x85ebca6b)) >>> 0;
  return (seed ^ Math.imul(index + 1, 0x01000193)) >>> 0;
}

/**
 * The Worker body. Stringified into a Blob-URL worker (a compiled binary
 * cannot load a worker file — see src/search/regex-worker.ts), so it must be
 * self-contained: it re-declares `canaryWord` and closes over nothing.
 */
function canaryWorkerMain(): void {
  const word = (thread: number, round: number, index: number): number => {
    const seed = (Math.imul(thread + 1, 0x9e3779b1) ^ Math.imul(round + 1, 0x85ebca6b)) >>> 0;
    return (seed ^ Math.imul(index + 1, 0x01000193)) >>> 0;
  };
  self.onmessage = (event: MessageEvent) => {
    const p = event.data as { thread: number; durationMs: number; bufferBytes: number; maxExamples: number; pauseMs: number;
      inject: { round: number; wordIndex: number } | null };
    const words = p.bufferBytes / 4;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const end = Date.now() + p.durationMs;
    let round = 0;
    let mismatched = 0;
    const examples: Array<{ thread: number; round: number; offset: number; expected: number; actual: number }> = [];
    try {
      do {
        let buf: Uint32Array | null = new Uint32Array(words);
        for (let i = 0; i < words; i++) buf[i] = word(p.thread, round, i);
        if (p.inject && p.inject.round === round) buf[p.inject.wordIndex % words] ^= 0x1;
        for (let i = 0; i < words; i++) {
          const expected = word(p.thread, round, i);
          const actual = buf[i];
          if (actual !== expected) {
            mismatched++;
            if (examples.length < p.maxExamples) examples.push({ thread: p.thread, round, offset: i * 4, expected, actual });
          }
        }
        buf = null;
        round++;
        // Give the buffer back now, so the next round faults fresh pages.
        const g = (globalThis as { Bun?: { gc(sync: boolean): void } }).Bun;
        if (g) g.gc(true);
        // Pace the rounds: the canary is a sampler, not a load test.
        if (p.pauseMs > 0) Atomics.wait(pause, 0, 0, p.pauseMs);
      } while (Date.now() < end);
      postMessage({ ok: true, rounds: round, mismatched, examples });
    } catch (err) {
      postMessage({ ok: false, error: err instanceof Error ? err.message : String(err), rounds: round, mismatched, examples });
    }
  };
}

let workerUrl: string | null = null;
function canaryWorkerUrl(): string {
  if (!workerUrl) {
    workerUrl = URL.createObjectURL(new Blob([`(${canaryWorkerMain.toString()})();`], { type: 'text/javascript' }));
  }
  return workerUrl;
}

interface ThreadReply { ok: boolean; error?: string; rounds: number; mismatched: number; examples: CanaryMismatch[] }

function runThread(thread: number, durationMs: number, bufferBytes: number, pauseMs: number, inject: CanaryOptions["injectCorruption"]): Promise<ThreadReply> {
  const worker = new Worker(canaryWorkerUrl());
  return new Promise<ThreadReply>((resolve) => {
    let settled = false;
    const finish = (reply: ThreadReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(reply);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `thread ${thread} did not answer within ${(durationMs + CANARY_LIMITS.graceMs) / 1000}s`, rounds: 0, mismatched: 0, examples: [] }),
      durationMs + CANARY_LIMITS.graceMs);
    worker.onmessage = (event: MessageEvent<ThreadReply>) => finish(event.data);
    worker.onerror = (event: ErrorEvent) => finish({ ok: false, error: `thread ${thread} failed: ${event.message}`, rounds: 0, mismatched: 0, examples: [] });
    worker.postMessage({
      thread, durationMs, bufferBytes, maxExamples: CANARY_LIMITS.maxExamplesPerThread, pauseMs,
      inject: inject && inject.thread === thread ? { round: inject.round, wordIndex: inject.wordIndex } : null,
    });
  });
}

/** Run the canary. Never throws: a failed thread makes the result `incomplete` (unless another thread already caught a mismatch). */
export async function runMemoryCanary(opts: CanaryOptions = {}): Promise<CanaryResult> {
  const { threads, durationMs, bufferBytes } = clampCanaryOptions(opts);
  const pauseMs = Math.max(0, Math.min(1000, Math.floor(opts.pauseMs ?? CANARY_ROUND_PAUSE_MS)));
  const started = Date.now();
  let replies: ThreadReply[];
  try {
    replies = await Promise.all(Array.from({ length: threads }, (_, t) => runThread(t, durationMs, bufferBytes, pauseMs, opts.injectCorruption)));
  } catch (err) {
    replies = [{ ok: false, error: err instanceof Error ? err.message : String(err), rounds: 0, mismatched: 0, examples: [] }];
  }
  const rounds = replies.reduce((n, r) => n + r.rounds, 0);
  const mismatchedWords = replies.reduce((n, r) => n + r.mismatched, 0);
  const problems = replies.filter((r) => !r.ok).map((r) => r.error ?? 'unknown failure');
  return {
    verdict: mismatchedWords > 0 ? 'corrupt' : problems.length > 0 ? 'incomplete' : 'clean',
    threads, durationMs: Date.now() - started, bufferBytes, rounds,
    bytesVerified: rounds * bufferBytes, mismatchedWords,
    examples: replies.flatMap((r) => r.examples),
    problem: problems.length > 0 ? problems.join('; ') : null,
  };
}

const hex = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;

/** The canary's result in plain words, for a system message and the evidence trail. */
export function describeCanaryResult(r: CanaryResult): string {
  const run = `${r.threads} threads for ${(r.durationMs / 1000).toFixed(1)}s, ${r.rounds} rounds of ${r.bufferBytes / 1048576} MiB ` +
    `(${(r.bytesVerified / 1073741824).toFixed(2)} GiB written and read back)`;
  if (r.verdict === 'clean') return `Memory check clean: ${run}; every word read back as written.`;
  if (r.verdict === 'incomplete') return `Memory check incomplete: ${run}; ${r.problem}. No mismatch was seen in what did run.`;
  return [
    `Memory check FAILED: ${run}; ${r.mismatchedWords} word(s) did not read back as written. ` +
      'The machine lost or misread a store to freshly allocated memory, with no disk or Docker involved.',
    ...r.examples.map((m) => `- thread ${m.thread}, round ${m.round}, offset ${m.offset}: wrote ${hex(m.expected)}, read ${hex(m.actual)}`),
    ...(r.problem ? [`Also: ${r.problem}.`] : []),
  ].join('\n');
}
