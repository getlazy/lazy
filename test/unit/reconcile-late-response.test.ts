/**
 * INVARIANT: a run that has stopped gets one more read of its response before
 * the reconciler infers anything from its absence. A failed one-shot turn exits
 * 1 right after writing response.json, so the response can land between the
 * reconciler's first read and its liveness probe. Without the re-read, a fatal
 * failure became `interrupted` (auto-resumed as a work turn) and a crashed turn
 * with commits was "recovered" as a finished one.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { reconcileTasks } from '../../src/utils/reconcile';
import { DockerRunner } from '../../src/runner/docker-runner';
import { protocolDir as getProtocolDir, writeResponse, hasResponse } from '../../src/protocol';
import type { ErrorResponse } from '../../src/protocol';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

function git(cwd: string, ...args: string[]): string {
  const result = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.stdout?.toString().trim() ?? '';
}

describe('reconciler reads a response that lands as the run stops', () => {
  let lazyRoot: string;
  let basePath: string;
  let storage: FileStorage;
  let unpin: () => void;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-late-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-late-store-'));
    git(lazyRoot, 'init');
    git(lazyRoot, 'config', 'user.email', 't@lazy.test');
    git(lazyRoot, 'config', 'user.name', 'T');
    git(lazyRoot, 'checkout', '-b', 'main');
    await writeFile(join(lazyRoot, 'README.md'), '# base\n');
    git(lazyRoot, 'add', '.');
    git(lazyRoot, 'commit', '-m', 'base');
    await writeFile(join(lazyRoot, 'lazy.toml'), '[runner]\ntype = "docker"\n\n[agent]\nagent_id = "claude-code"\n');
    unpin = pinConfig(lazyRoot);
    storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
  });

  afterEach(async () => {
    unpin();
    await storage.close();
    await Promise.all([rm(lazyRoot, { recursive: true, force: true }), rm(basePath, { recursive: true, force: true })]);
  });

  test('an error response written between the read and the liveness probe is routed, not inferred away', async () => {
    const baseSha = git(lazyRoot, 'rev-parse', 'HEAD');
    const task = await storage.createTask('late response', undefined, baseSha);
    const session = await storage.createSession(task.id, 'claude-code', `lazy/${task.id}`, baseSha);
    await storage.updateTaskStatus(task.id, 'working', 'system');
    const seq = await storage.getNextTurnSequence(session.id);
    await storage.createTurn({ sessionId: session.id, sequence: seq, role: 'human', content: 'go', actor: 'human' });

    const protoDir = getProtocolDir(task.id);
    await mkdir(protoDir, { recursive: true });
    expect(hasResponse(protoDir)).toBe(false);

    // The response lands as the container stops: first read saw nothing, the
    // probe is what finds the run gone.
    const probe = spyOn(DockerRunner.prototype, 'isRunning').mockImplementation(async () => {
      writeResponse(protoDir, {
        status: 'error',
        error: 'read-only turn wrote files',
        phase: 'work',
        failure_class: 'fatal_config',
      } as unknown as ErrorResponse);
      return false;
    });
    try {
      await reconcileTasks(storage, lazyRoot);
    } finally {
      probe.mockRestore();
    }

    expect(hasResponse(protoDir)).toBe(false); // consumed
    const after = await storage.getTask(task.id);
    expect(after?.status).not.toBe('interrupted');
    expect(after?.status).not.toBe('working');
    const turns = await storage.getSessionTurns(session.id);
    expect(turns.some(t => t.role === 'agent' && t.content.includes('read-only turn wrote files'))).toBe(true);
  });
});
