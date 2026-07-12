/**
 * One-shot reconcile entry point for e2e tests.
 *
 * Spawned as a subprocess (with `--preload test/mocks/preload-mocks.ts`, see
 * runReconcile in reconcile.ts) so the container/agent boundary (capture/claude)
 * is mocked BEFORE any module loads. That is the whole reason this runs in a
 * subprocess instead of in-process: reconcileTasks() reaches createRunner() →
 * DockerRunner, whose destructured `checkDocker` import is bound at module-load
 * time. An in-process `mock.module` call runs too late to patch that binding
 * (the daemon barrel pulls capture/claude in transitively before the test body
 * runs), so autoResumeTask()'s checkAvailability() would throw and auto-resume
 * would silently skip. --preload avoids that ordering trap entirely.
 *
 * Runs a single reconcile pass — exactly what the daemon loop does per tick —
 * making the test deterministic (no 5s background timer to wait on).
 *
 * argv[2] = project root.
 */
import { reconcileTasks } from '../../src/utils/reconcile';
import { openProjectStorage } from '../../src/daemon/rpc-handlers';

const root = process.argv[2];
if (!root) {
  console.error('reconcile-entry: missing project root argument');
  process.exit(2);
}

const storage = await openProjectStorage(root);
try {
  await reconcileTasks(storage, root);
} finally {
  await storage.close();
}
