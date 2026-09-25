/**
 * Shared plumbing for evaluating a USER-SUPPLIED regex off the caller's thread,
 * with a deadline.
 *
 * JS has no `RegExp.timeout` (Teams' Ruby side sets one globally), so a
 * catastrophically-backtracking pattern runs to completion on whatever thread
 * compiled it. The daemon serves RPC, MCP, and the dashboard on a single event
 * loop, so that hang is a whole-daemon outage, not one slow request. Matching
 * therefore runs in a Worker and `Worker.terminate()` is the deadline — the
 * only way to stop a JS regex that is already backtracking. A deadline helper
 * like `withWebRequestDeadline` cannot do it, because it never preempts
 * synchronous work.
 *
 * Two callers share this: conversation search (`src/conversation/search.ts`)
 * and store search (`src/search/text-matcher.ts`, behind `lazy search` and the
 * dashboard's `/search`). One mechanism so the deadline, the terminate, and the
 * "unusable pattern" error shape cannot drift between them.
 */

/**
 * How long one batch of matching may spend evaluating the user regex.
 *
 * Matches Teams' `Regexp.timeout = 1.0` (lazy-teams/config/initializers/regexp_timeout.rb)
 * so a pattern that would pin a Puma thread for a second is refused here in the
 * same budget.
 */
export const SEARCH_REGEX_DEADLINE_MS = 1000;

/** The refusal a pattern earns by running past the deadline. */
export function regexDeadlineError(query: string): Error {
  return new Error(
    `Invalid search pattern '${query}': took too long to evaluate; try a simpler query.`,
  );
}

/**
 * Worker sources are Blob URLs, not `new Worker(new URL('./worker.ts', import.meta.url))`.
 * On bun 1.4.0 a compiled binary fails that form with
 * `ModuleNotFound resolving "/$bunfs/root/worker.ts"` even when the worker is
 * passed as a second compile entrypoint; a `blob:` worker is just a string and
 * works in `bun run` and `bun build --compile`.
 *
 * One Blob URL per job id for the life of the process, so repeated searches do
 * not leak blobs.
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

export interface RegexWorkerJob<TPayload> {
  /** Stable id for the worker source, used to cache its Blob URL. */
  id: string;
  /** Builds the worker source; called once per process, per id. */
  source: () => string;
  /** Structured-clonable payload posted to the worker. */
  payload: TPayload;
  /** The user's pattern — only used to name it in the refusal message. */
  query: string;
  /** Override the deadline (default {@link SEARCH_REGEX_DEADLINE_MS}). */
  deadlineMs?: number;
}

interface WorkerReply<TResult> {
  ok: boolean;
  result?: TResult;
  error?: string;
}

/**
 * Post `payload` to a fresh Worker running `source` and await its reply.
 *
 * `await`ing the Worker keeps the daemon event loop free: other RPC, MCP, and
 * dashboard requests are served while this search's regex is evaluated. A
 * worker that does not answer within the deadline is terminated and the pattern
 * refused; a worker that dies mid-match takes the same path, so the page/CLI
 * never 500s on a pattern the human typed.
 */
export async function runRegexWorker<TPayload, TResult>(
  job: RegexWorkerJob<TPayload>,
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
      finish(() => reject(regexDeadlineError(job.query)));
    }, job.deadlineMs ?? SEARCH_REGEX_DEADLINE_MS);

    worker.onmessage = (event: MessageEvent<WorkerReply<TResult>>) => {
      const data = event.data;
      if (data && data.ok && data.result !== undefined) {
        finish(() => resolve(data.result as TResult));
        return;
      }
      finish(() => reject(new Error(data?.error ?? `Invalid search pattern '${job.query}'`)));
    };

    worker.onerror = (event: ErrorEvent) => {
      // The timeout path is the expected ReDoS outcome; this is the "the
      // isolate crashed" cousin of the same refusal.
      finish(() => reject(regexDeadlineError(job.query)));
      event.preventDefault();
    };

    worker.postMessage(job.payload);
  });
}
