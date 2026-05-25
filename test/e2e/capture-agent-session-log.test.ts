import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join, basename } from 'path';
import { homedir } from 'os';
import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

const RAW_JSONL =
  '{"type":"user","message":{"role":"user","content":"hello"}}\n' +
  '{"type":"assistant","message":{"role":"assistant","content":"hi"}}\n';

/**
 * E2e tests use the default external storage backend, which lives at
 * `~/.lazy/<project-name>` (project name = basename of the test root).
 */
function storageBase(root: string): string {
  return join(process.env.HOME || homedir(), '.lazy', basename(root));
}

/** Resolve the full task dir under external storage from a short id prefix. */
async function findTaskDir(root: string, taskShortId: string): Promise<string | null> {
  const tasksDir = join(storageBase(root), 'tasks');
  let entries: string[];
  try {
    entries = await readdir(tasksDir);
  } catch {
    return null;
  }
  const match = entries.find(e => e.startsWith(taskShortId));
  return match ? join(tasksDir, match) : null;
}

describe('capture agent session log on close', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start` requires a real daemon (storage is daemon-owned since v0.11).
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: When a task is closed, the raw agent session JSONL must be
  // archived into lazy storage BEFORE the worktree (and its sandbox copy of
  // the JSONL) is removed — so it can be rehydrated later for `claude --resume`.
  test('close archives the raw session JSONL into storage', async () => {
    const taskId = await createTask(ctx, 'Task with a session to archive', 'Do work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // Discover the session id the daemon recorded, then plant a JSONL where the
    // sandbox runner would have left it (inside the worktree, removed on close).
    const taskDir = await findTaskDir(ctx.root, taskId);
    expect(taskDir).not.toBeNull();
    const session = JSON.parse(await readFile(join(taskDir!, 'session.json'), 'utf-8'));
    const sessionId: string | null = session.agent_session_id;
    expect(sessionId).toBeTruthy();

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const projectDir = join(
      worktreePath, '.lazy-task-sandbox', '.claude', 'projects', encodeProjectPath(worktreePath),
    );
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), RAW_JSONL, 'utf-8');

    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'Archiving session', '--yes']);
    expectSuccess(closeResult);

    // The raw JSONL must now be retrievable from storage, byte-for-byte.
    const stored = await readFile(join(taskDir!, 'agent-session.jsonl'), 'utf-8');
    expect(stored).toBe(RAW_JSONL);

    const meta = JSON.parse(await readFile(join(taskDir!, 'agent-session.json'), 'utf-8'));
    expect(meta.sessionId).toBe(sessionId);
  });

  // Proves the chokepoint catches a teardown path OUTSIDE task-lifecycle.ts.
  // `lazy redo` abandons the old task and removes its worktree via the shared
  // cleanupWorktreeAndBranch — the same chokepoint — so its session must be
  // archived too. The old sprinkled-call approach missed this path entirely.
  test('redo archives the old task session JSONL via the cleanup chokepoint', async () => {
    const taskId = await createTask(ctx, 'Task to redo', 'Do work');

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    });
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const taskDir = await findTaskDir(ctx.root, taskId);
    expect(taskDir).not.toBeNull();
    const session = JSON.parse(await readFile(join(taskDir!, 'session.json'), 'utf-8'));
    const sessionId: string | null = session.agent_session_id;
    expect(sessionId).toBeTruthy();

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const projectDir = join(
      worktreePath, '.lazy-task-sandbox', '.claude', 'projects', encodeProjectPath(worktreePath),
    );
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), RAW_JSONL, 'utf-8');

    // --no-start keeps the test simple: the old task is still abandoned and its
    // worktree torn down, which is the path under test.
    const redoResult = await ctx.lazy(['redo', taskId, '--no-start', '--yes']);
    expectSuccess(redoResult);

    const stored = await readFile(join(taskDir!, 'agent-session.jsonl'), 'utf-8');
    expect(stored).toBe(RAW_JSONL);
  });

  // A task that never produced a session JSONL is a normal condition — close
  // must succeed and simply skip capture (no log file written).
  test('close succeeds without a session log and writes nothing', async () => {
    const taskId = await createTask(ctx, 'Task with no agent run');

    const closeResult = await ctx.lazy(['close', taskId, '--reason', 'Not needed', '--yes']);
    expectSuccess(closeResult);

    const taskDir = await findTaskDir(ctx.root, taskId);
    expect(taskDir).not.toBeNull();
    let captured = false;
    try {
      await readFile(join(taskDir!, 'agent-session.jsonl'), 'utf-8');
      captured = true;
    } catch {
      captured = false;
    }
    expect(captured).toBe(false);
  });
});
