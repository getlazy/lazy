/**
 * The task half of a daemon restart, run for real in a subprocess: the
 * restart reaper (`reapTaskAgents` → the in-container agent stop →
 * `interruptForDaemonRestart`) and the auto-resume launch it dispatches,
 * against the project's real FileStorage, with the NEW daemon's proxy port in
 * the daemon context. Used by test/e2e/task-sessions-survive-restart.test.ts.
 *
 * A subprocess because the container runtime is a `docker` shim found on PATH:
 * a running test process cannot change where its own spawns resolve `docker`,
 * a child started with the shim's directory on PATH can.
 *
 * argv[2] = project root, argv[3] = store base path, argv[4] = the container
 * (run) name to reap, argv[5] = the new daemon's proxy port. Prints one JSON
 * line: what the reap interrupted and the task's session afterwards.
 */
import { FileStorage } from '../../src/storage';
import { settleAutoResumes } from '../../src/utils/reconcile';
import { reapTaskAgents } from '../../src/daemon/restart-reaper';
import { setDaemonContext } from '../../src/daemon/context';
import { createRunner } from '../../src/runner';

const [root, basePath, runName, port] = process.argv.slice(2);
if (!root || !basePath || !runName || !port) {
  console.error('restart-resume-entry: usage <root> <basePath> <runName> <proxyPort>');
  process.exit(2);
}

setDaemonContext({ webPort: 1, token: 'test', proxyPort: Number(port) });
const storage = new FileStorage(root, { basePath });
await storage.initialize();
try {
  const interrupted = await reapTaskAgents(await createRunner(root), storage, root, [runName]);
  await settleAutoResumes();
  const [task] = await storage.listTasks();
  const session = task ? await storage.getSessionByTaskId(task.id) : null;
  console.log(JSON.stringify({
    interrupted,
    status: task?.status,
    container_name: session?.container_name ?? null,
    container_agent_id: session?.container_agent_id ?? null,
  }));
} finally {
  await storage.close();
}
