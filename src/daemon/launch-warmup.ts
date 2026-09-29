/**
 * Build the runner image and the agent binary when a MANAGED daemon starts,
 * instead of inside the first launch that needs them.
 *
 * Why: in a Lazy Teams microVM both live on the machine's own disk — the
 * image in the guest dockerd's data-root on the machine's `--storage` volume,
 * the compiled `lazy-agent` under `$HOME/.lazy/bin` — and a fleet roll DELETES
 * the machine and creates a new one (SmolvmSupervisor: "an image change
 * deletes the machine"). The daemon runs lazy from TypeScript source, so there
 * is no embedded agent binary either. So after every roll the first builder
 * or task start paid a full runner-image build plus an agent compile.
 *
 * Fire-and-forget. A launch that arrives mid-warmup waits on the same image
 * build lock and the same in-flight agent compile rather than starting its
 * own, and its start timeline says the warmup was still running. A warmup
 * failure is logged and changes nothing: the launch retries the same steps
 * and reports its own error.
 *
 * Gated on managed mode and on the project's runner being a container
 * runner — the only runner that has an image to build. Nothing test-only is
 * read here: a test daemon in managed mode with a fake docker warms against
 * that fake, exactly as a launch would.
 */
import { logger } from '../utils/logger';
import { isManagedMode } from '../config/managed-mode';
import { createRunner } from '../runner';
import { DockerRunner } from '../runner/docker-runner';

export type LaunchWarmupStatus =
  | { state: 'not-started' }
  | { state: 'running'; startedAt: string }
  | { state: 'ready'; startedAt: string; ms: number }
  | { state: 'failed'; startedAt: string; ms: number; error: string };

let status: LaunchWarmupStatus = { state: 'not-started' };

/** Where this daemon's warmup is — read into every builder start's timeline. */
export function launchWarmupStatus(): LaunchWarmupStatus {
  return status;
}

/** One line for a start's timeline, or null when there is nothing to say. */
export function describeLaunchWarmup(now: number = Date.now()): string | null {
  const s = status;
  switch (s.state) {
    case 'not-started': return null;
    case 'running':
      return `the daemon's launch warmup (image + agent binary) is still running, ` +
        `${Math.round((now - Date.parse(s.startedAt)) / 1000)}s in; this start waits for it`;
    case 'ready': return `launch warmup finished in ${s.ms}ms at daemon start`;
    case 'failed': return `launch warmup FAILED after ${s.ms}ms: ${s.error}`;
  }
}

export function startLaunchWarmup(projectRoot: string): void {
  if (!isManagedMode()) return;
  void (async () => {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    try {
      const runner = await createRunner(projectRoot);
      if (!(runner instanceof DockerRunner)) return;
      status = { state: 'running', startedAt };
      logger.info('Launch warmup: preparing the runner image and agent binary before the first launch');
      await runner.prepareLaunchInputs((detail) => {
        // Build lines and heartbeats are already logged by the build itself.
        if (/^(building \S+: |still building )/.test(detail)) return;
        logger.info(`Launch warmup: ${detail}`);
      });
      status = { state: 'ready', startedAt, ms: Date.now() - started };
      logger.info(`Launch warmup: ready after ${Date.now() - started}ms`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      status = { state: 'failed', startedAt, ms: Date.now() - started, error };
      logger.warn(`Launch warmup failed after ${Date.now() - started}ms: ${error}. The next launch retries the same steps.`);
    }
  })();
}
