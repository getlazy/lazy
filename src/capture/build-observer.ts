/**
 * Who is watching the container build running in this async context.
 *
 * The daemon's image builds (the project image at boot, an adoption build)
 * want EVERY line docker prints — for a streamed, per-step build log — and a
 * way to stop the build. Both are deep inside `ensureImage` →
 * `buildImageWithTags` → `ensureLazyBaseImage` → `runDockerBuild`, which other
 * callers (launches, `lazy upgrade`, the try-build tool) reach too and which
 * take their options positionally. Threading a sink and a signal through every
 * one of those signatures would touch a dozen call sites that never want them.
 *
 * So the observer is SCOPED instead: `runWithBuildObserver` binds it to one
 * async chain, and `runDockerBuild` asks `currentBuildObserver()`. Only builds
 * started inside that chain report to it — a launch elsewhere in the daemon,
 * building lazy's default image at the same moment, does not, and cannot be
 * cancelled by it. A leaf module (no imports from lazy) so nothing beneath the
 * capture layer can form a cycle through it.
 */
import { AsyncLocalStorage } from 'async_hooks';

/**
 * `connection-lost`: the client lost its connection to BuildKit — no step of the
 * Dockerfile is to blame, so none is marked failed.
 */
export type BuildEndOutcome = 'succeeded' | 'failed' | 'cancelled' | 'connection-lost';

export interface BuildObserver {
  /** Aborting it kills the docker client of every build in this context. */
  signal?: AbortSignal;
  /** One `docker build` invocation starts (`image` is its first tag). */
  onBuildStart?(image: string, source: string): void;
  /** Every line the build prints, unfiltered — the whole plain-progress stream. */
  onLine(image: string, line: string): void;
  /** That invocation ended. */
  onBuildEnd?(image: string, outcome: BuildEndOutcome): void;
}

const store = new AsyncLocalStorage<BuildObserver>();

/** Run `fn` with `observer` watching every container build it starts. */
export function runWithBuildObserver<T>(observer: BuildObserver, fn: () => Promise<T>): Promise<T> {
  return store.run(observer, fn);
}

/**
 * Run `fn` with NO observer, whatever the caller's context has — for a build
 * started from inside a watched job that is not that job's (lazy's default
 * image, prepared alongside the project's).
 */
export function runWithoutBuildObserver<T>(fn: () => Promise<T>): Promise<T> {
  return store.exit(fn);
}

/** The observer of the build running in this async context, if any. */
export function currentBuildObserver(): BuildObserver | undefined {
  return store.getStore();
}

// --- Process-wide: every container build, whoever started it ---------------
//
// Unlike the scoped observer above, these see EVERY `docker build` this process
// runs — a launch's inline default-image build and the boot path's concurrent
// one included, which no image build job wraps. The machine-integrity checks
// (src/daemon/machine-integrity.ts) need exactly that: the canary must not run
// during any build, and the blob audit must follow every successful one.

let runningBuilds = 0;
const succeededListeners = new Set<(image: string, startedAt: number) => void>();

/** How many container builds are running in this process right now. */
export function runningContainerBuilds(): number {
  return runningBuilds;
}

/** Called once per container build that succeeds, with its first tag and start time. */
export function onContainerBuildSucceeded(fn: (image: string, startedAt: number) => void): () => void {
  succeededListeners.add(fn);
  return () => { succeededListeners.delete(fn); };
}

/** The build chokepoint's bracket: counts the build while `fn` runs, and reports a success. */
export async function trackContainerBuild<T>(image: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  runningBuilds++;
  let ok = false;
  try {
    const result = await fn();
    ok = true;
    return result;
  } finally {
    runningBuilds--;
    // Listeners must not throw (the one listener only schedules async work): a
    // build that worked is never failed by whoever watches it.
    if (ok) for (const listener of succeededListeners) listener(image, startedAt);
  }
}
