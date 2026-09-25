/**
 * Run a synchronous probe off the caller's thread.
 *
 * Doctor checks that still have to call a blocking primitive (`statfsSync`,
 * a leftover `spawnSync`) must not sit on the daemon's event loop: one stuck
 * docker probe would stall every RPC, MCP tool and dashboard request. The
 * same Blob-URL Worker pattern `src/search/regex-worker.ts` uses — a compiled
 * binary cannot `new Worker(new URL('./worker.ts'))` — so the probe source
 * is a string.
 *
 * The daemon never runs the WHOLE report in a Worker. A Worker cannot share
 * the daemon's Storage handle; opening FileStorage would fight the lock the
 * daemon holds for life, and talking back over RPC while `doctor.run` is
 * awaiting the Worker would deadlock. Isolated probes that touch no storage
 * are what this is for. Everything else is properly async.
 */

const workerUrls = new Map<string, string>();

function workerUrlFor(id: string, source: () => string): string {
  let url = workerUrls.get(id);
  if (url === undefined) {
    url = URL.createObjectURL(new Blob([source()], { type: 'text/javascript' }));
    workerUrls.set(id, url);
  }
  return url;
}

export interface BlockingProbeJob<TPayload> {
  /** Stable id for the worker source, used to cache its Blob URL. */
  id: string;
  /** Builds the worker source; called once per process, per id. */
  source: () => string;
  /** Structured-clonable payload posted to the worker. */
  payload: TPayload;
  /** Override the deadline (default {@link DOCTOR_PROBE_DEADLINE_MS}). */
  deadlineMs?: number;
}

/** Bound on one blocking probe. A hung docker/statfs must not last forever. */
export const DOCTOR_PROBE_DEADLINE_MS = 15_000;

interface WorkerReply<TResult> {
  ok: boolean;
  result?: TResult;
  error?: string;
}

/**
 * Post `payload` to a fresh Worker running `source` and await its reply.
 *
 * `await`ing the Worker keeps the daemon event loop free. A worker that does
 * not answer within the deadline is terminated; a worker that dies mid-probe
 * takes the same path.
 */
export async function runBlockingProbe<TPayload, TResult>(
  job: BlockingProbeJob<TPayload>,
): Promise<TResult> {
  const worker = new Worker(workerUrlFor(job.id, job.source));
  let settled = false;

  return await new Promise<TResult>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Doctor probe '${job.id}' timed out after ${job.deadlineMs ?? DOCTOR_PROBE_DEADLINE_MS}ms`)));
    }, job.deadlineMs ?? DOCTOR_PROBE_DEADLINE_MS);

    worker.onmessage = (event: MessageEvent<WorkerReply<TResult>>) => {
      const data = event.data;
      if (data && data.ok && data.result !== undefined) {
        finish(() => resolve(data.result as TResult));
        return;
      }
      finish(() => reject(new Error(data?.error ?? `Doctor probe '${job.id}' failed`)));
    };

    worker.onerror = (event: ErrorEvent) => {
      finish(() => reject(new Error(event.message || `Doctor probe '${job.id}' crashed`)));
      event.preventDefault();
    };

    worker.postMessage(job.payload);
  });
}

/**
 * `statfs` in a Worker so a slow filesystem cannot pin the daemon.
 *
 * The worker source uses `require('fs')` so it is a self-contained string
 * (no `import.meta.url` resolve against `$bunfs`).
 */
export async function statfsOffThread(root: string): Promise<{ bavail: number; bsize: number }> {
  return runBlockingProbe<{ root: string }, { bavail: number; bsize: number }>({
    id: 'statfs',
    source: () => `
      self.onmessage = (event) => {
        try {
          const { statfsSync } = require('fs');
          const stats = statfsSync(event.data.root);
          self.postMessage({ ok: true, result: { bavail: stats.bavail, bsize: stats.bsize } });
        } catch (err) {
          self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      };
    `,
    payload: { root },
  });
}
