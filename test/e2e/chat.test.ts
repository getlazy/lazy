import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join, basename } from 'path';
import { homedir } from 'os';
import { mkdir, writeFile, readFile, readdir, rm, chmod } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

const RAW_JSONL =
  '{"type":"user","message":{"role":"user","content":"hello"}}\n' +
  '{"type":"assistant","message":{"role":"assistant","content":"hi"}}\n';

/** Marker line a fake `claude` appends to the resumed JSONL to prove resume ran. */
const CHAT_MARKER = '{"type":"user","message":{"role":"user","content":"chat question"}}';

function storageBase(root: string): string {
  return join(process.env.HOME || homedir(), '.lazy', basename(root));
}

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

/**
 * Create a fake `claude` executable that (a) records the exact argv it was
 * launched with to `<binDir>/claude-args` and (b) appends CHAT_MARKER to the
 * resumed session JSONL. `chat` resumes in the project root, so the JSONL
 * lives at ~/.claude/projects/<encoded-root>/<sessionId>.jsonl. Returns the
 * bin dir to prepend to PATH.
 */
async function installFakeClaude(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const argsLog = join(binDir, 'claude-args');
  const script = `#!/bin/sh
# Record argv (one arg per line) so tests can assert on what chat passed.
: > '${argsLog}'
id=""
prev=""
for a in "$@"; do
  printf '%s\\n' "$a" >> '${argsLog}'
  if [ "$prev" = "--resume" ]; then id="$a"; fi
  prev="$a"
done
f=$(find "$HOME/.claude/projects" -name "$id.jsonl" 2>/dev/null | head -1)
if [ -n "$f" ]; then
  printf '%s\\n' '${CHAT_MARKER}' >> "$f"
fi
exit 0
`;
  const p = join(binDir, 'claude');
  await writeFile(p, script, 'utf-8');
  await chmod(p, 0o755);
}

/** Read the recorded argv the fake claude was launched with. */
async function readClaudeArgs(binDir: string): Promise<string[]> {
  const raw = await readFile(join(binDir, 'claude-args'), 'utf-8');
  return raw.split('\n').filter(l => l.length > 0);
}

/** Run a task to completion and close it, leaving a captured session log in storage. */
async function makeClosedTaskWithSession(ctx: TestContext): Promise<{ taskId: string; taskDir: string; sessionId: string }> {
  const taskId = await createTask(ctx, 'Finished task to chat with', 'Do work');

  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);
  expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

  const taskDir = await findTaskDir(ctx.root, taskId);
  expect(taskDir).not.toBeNull();
  const session = JSON.parse(await readFile(join(taskDir!, 'session.json'), 'utf-8'));
  const sessionId: string = session.agent_session_id;
  expect(sessionId).toBeTruthy();

  // Plant the JSONL where the sandbox runner left it, then close to capture it.
  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  const sandboxProjectDir = join(
    worktreePath, '.lazy-task-sandbox', '.claude', 'projects', encodeProjectPath(worktreePath),
  );
  await mkdir(sandboxProjectDir, { recursive: true });
  await writeFile(join(sandboxProjectDir, `${sessionId}.jsonl`), RAW_JSONL, 'utf-8');

  const closeResult = await ctx.lazy(['close', taskId, '--reason', 'done', '--yes']);
  expectSuccess(closeResult);

  // Sanity: capture landed.
  const stored = await readFile(join(taskDir!, 'agent-session.jsonl'), 'utf-8');
  expect(stored).toBe(RAW_JSONL);

  return { taskId, taskDir: taskDir!, sessionId };
}

describe('lazy chat', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // `start` requires a real daemon (storage is daemon-owned since v0.11).
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: chat rehydrates the captured JSONL to where `claude --resume`
  // looks for it, then writes the (extended) session back to storage when the
  // chat ends. The fake `claude` appends a marker so we can observe both ends
  // of the loop: it could only find the file if rehydrate ran, and the marker
  // only reaches storage if write-back ran.
  test('rehydrates the session and writes it back after the chat', async () => {
    const { taskId, taskDir, sessionId } = await makeClosedTaskWithSession(ctx);

    const binDir = join(ctx.root, 'fake-bin');
    await installFakeClaude(binDir);
    const rehydratedDir = join(process.env.HOME || homedir(), '.claude', 'projects', encodeProjectPath(ctx.root));

    try {
      const result = await ctx.lazy(['chat', taskId], {
        env: { PATH: `${binDir}:${process.env.PATH}` },
      });
      expectSuccess(result);
      expectOutput(result, 'Resuming agent session');
      expectOutput(result, 'read-only');

      // Rehydrate happened: the JSONL was placed where claude resumes from.
      const rehydrated = await readFile(join(rehydratedDir, `${sessionId}.jsonl`), 'utf-8');
      expect(rehydrated).toContain('hello');

      // Write-back happened: the marker the fake claude appended is now in storage.
      const storedAfter = await readFile(join(taskDir, 'agent-session.jsonl'), 'utf-8');
      expect(storedAfter).toContain('chat question');
      // Original content is preserved (byte-for-byte append, not overwrite).
      expect(storedAfter).toContain('hello');

      // Read-only lockdown + resume are passed through to claude.
      const claudeArgs = await readClaudeArgs(binDir);
      expect(claudeArgs).toContain('--resume');
      expect(claudeArgs).toContain('--disallowedTools');
      expect(claudeArgs[claudeArgs.indexOf('--disallowedTools') + 1]).toBe('Bash Write Edit');
    } finally {
      await rm(rehydratedDir, { recursive: true, force: true });
    }
  });

  // INVARIANT: a retrospective chat is lightweight — it must default to medium
  // effort, NOT inherit the (often high/xhigh) task/builder defaults.
  test('defaults to --effort medium', async () => {
    const { taskId, sessionId } = await makeClosedTaskWithSession(ctx);

    const binDir = join(ctx.root, 'fake-bin');
    await installFakeClaude(binDir);
    const rehydratedDir = join(process.env.HOME || homedir(), '.claude', 'projects', encodeProjectPath(ctx.root));

    try {
      const result = await ctx.lazy(['chat', taskId], {
        env: { PATH: `${binDir}:${process.env.PATH}` },
      });
      expectSuccess(result);
      expectOutput(result, 'medium');

      const claudeArgs = await readClaudeArgs(binDir);
      const idx = claudeArgs.indexOf('--effort');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(claudeArgs[idx + 1]).toBe('medium');
      // Silence unused-var lint without weakening the rehydrate assertion above.
      expect(sessionId).toBeTruthy();
    } finally {
      await rm(rehydratedDir, { recursive: true, force: true });
    }
  });

  // --effort overrides the medium default and is passed through to claude.
  test('--effort overrides the default and is passed to claude', async () => {
    const { taskId } = await makeClosedTaskWithSession(ctx);

    const binDir = join(ctx.root, 'fake-bin');
    await installFakeClaude(binDir);
    const rehydratedDir = join(process.env.HOME || homedir(), '.claude', 'projects', encodeProjectPath(ctx.root));

    try {
      const result = await ctx.lazy(['chat', taskId, '--effort', 'high'], {
        env: { PATH: `${binDir}:${process.env.PATH}` },
      });
      expectSuccess(result);

      const claudeArgs = await readClaudeArgs(binDir);
      const idx = claudeArgs.indexOf('--effort');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(claudeArgs[idx + 1]).toBe('high');
    } finally {
      await rm(rehydratedDir, { recursive: true, force: true });
    }
  });

  // An invalid effort value fails fast with a clear message, before launching.
  test('rejects an invalid --effort value', async () => {
    const { taskId } = await makeClosedTaskWithSession(ctx);

    const result = await ctx.lazy(['chat', taskId, '--effort', 'turbo']);

    expectFailure(result);
    expectError(result, "Invalid effort 'turbo'");
  });

  // A task with no captured agent session has nothing to resume.
  test('fails when the task has no captured agent session', async () => {
    const taskId = await createTask(ctx, 'Task that never ran an agent');

    const result = await ctx.lazy(['chat', taskId]);

    expectFailure(result);
    expectError(result, 'No captured agent session');
  });

  test('fails when no task argument is given', async () => {
    const result = await ctx.lazy(['chat']);

    expectFailure(result);
    expectOutput(result, 'Usage: lazy chat <task>');
  });
});
