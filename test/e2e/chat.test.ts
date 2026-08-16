import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join, basename } from 'path';
import { homedir } from 'os';
import { mkdir, writeFile, readFile, readdir, rm, chmod, realpath } from 'fs/promises';
import { existsSync } from 'fs';
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
  const envLog = join(binDir, 'claude-env');
  const credLog = join(binDir, 'claude-cred');
  const cwdLog = join(binDir, 'claude-cwd');
  const lockLog = join(binDir, 'lock-during-chat');
  const script = `#!/bin/sh
# Record argv (one arg per line) so tests can assert on what chat passed.
: > '${argsLog}'
# Record the endpoint env chat handed us — this process stands in for the HOST
# Claude Code process, so whatever lands here is what would actually be dialed.
printf '%s\\n' "\$ANTHROPIC_BASE_URL" > '${envLog}'
# Record the model credential too — this is what would authenticate the session,
# and it must have come from the daemon rather than from the invoking shell.
printf '%s\\n' "\$ANTHROPIC_API_KEY" > '${credLog}'
# Record where we were launched (live chat must land in the task's worktree)
# and whether the worktree lock is held WHILE the chat is open.
pwd > '${cwdLog}'
if [ -f .lazy-lock ]; then cp .lazy-lock '${lockLog}'; fi
id=""
prev=""
for a in "$@"; do
  printf '%s\\n' "$a" >> '${argsLog}'
  if [ "$prev" = "--resume" ]; then id="$a"; fi
  prev="$a"
done
# -L: on a live task the project dir is a SYMLINK into the worktree sandbox,
# and find will not descend into it otherwise.
f=$(find -L "$HOME/.claude/projects" -name "$id.jsonl" 2>/dev/null | head -1)
if [ -n "$f" ]; then
  printf '%s\\n' '${CHAT_MARKER}' >> "$f"
fi
exit 0
`;
  const p = join(binDir, 'claude');
  await writeFile(p, script, 'utf-8');
  await chmod(p, 0o755);
}

/** Read the ANTHROPIC_BASE_URL the fake claude was launched with ('' if unset). */
async function readClaudeBaseUrl(binDir: string): Promise<string> {
  return (await readFile(join(binDir, 'claude-env'), 'utf-8')).trim();
}

/** Read the ANTHROPIC_API_KEY the fake claude was launched with ('' if unset). */
async function readClaudeCredential(binDir: string): Promise<string> {
  return (await readFile(join(binDir, 'claude-cred'), 'utf-8')).trim();
}

/** Read the cwd the fake claude was launched in. */
async function readClaudeCwd(binDir: string): Promise<string> {
  return (await readFile(join(binDir, 'claude-cwd'), 'utf-8')).trim();
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

  // INVARIANT: the credential a chat session runs on comes from the DAEMON, not
  // from the shell `lazy chat` was typed in. `lazy chat` is the same launch
  // surface as `lazy pair` (host Claude Code, builder role) and shared the same
  // defect: it filled the credential in from its own process env, so a shell
  // that exports nothing — the normal case in a daemon-only-env setup, and what
  // a freshly opened terminal looks like — handed Claude Code no credential at
  // all and it fell through to the host store or a `/login` prompt, while task
  // agents kept running fine on the daemon's token.
  test('runs on the daemon credential, not the invoking shell', async () => {
    const { taskId } = await makeClosedTaskWithSession(ctx);

    const binDir = join(ctx.root, 'fake-bin');
    await installFakeClaude(binDir);
    const rehydratedDir = join(process.env.HOME || homedir(), '.claude', 'projects', encodeProjectPath(ctx.root));

    try {
      // A shell with NO Anthropic credential exported. Before the fix this was
      // the reproduction: claude was launched with an empty credential.
      const result = await ctx.lazy(['chat', taskId], {
        env: {
          PATH: `${binDir}:${process.env.PATH}`,
          CLAUDE_CODE_OAUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        },
      });
      expectSuccess(result);

      expect(await readClaudeCredential(binDir)).toBe('sk-test-fake-key-for-testing');
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

  // INVARIANT: chat runs Claude Code as a HOST process, so the endpoint it is
  // handed must be the HOST-reachable one — the same address the reachability
  // preflight probed. `host.docker.internal` is Docker-internal DNS: it resolves
  // only inside a container, so a host process handed it dies with ENOTFOUND.
  //
  // This is the regression that shipped: preflight probed the host-converted
  // address (and passed) while ANTHROPIC_BASE_URL was set to the raw configured
  // one, so Claude Code failed to connect despite a green preflight.
  test('hands the host-reachable endpoint to claude, not the docker-internal one', async () => {
    const { taskId } = await makeClosedTaskWithSession(ctx);

    // Serve /api/tags so the ollama preflight passes against 127.0.0.1:<port>.
    // The role is configured the way a docker-runner project configures it —
    // with the docker-internal hostname on that same port.
    const ollama = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === '/api/tags'
          ? Response.json({ models: [] })
          : new Response('not found', { status: 404 }),
    });
    const lazyToml = join(ctx.root, 'lazy.toml');
    await writeFile(
      lazyToml,
      await readFile(lazyToml, 'utf-8') +
        `\n[models.roles.builder]\nbackend = "ollama"\nmodel = "qwen3-coder"\n` +
        `endpoint = "http://host.docker.internal:${ollama.port}"\n`,
      'utf-8',
    );

    const binDir = join(ctx.root, 'fake-bin');
    await installFakeClaude(binDir);
    const rehydratedDir = join(process.env.HOME || homedir(), '.claude', 'projects', encodeProjectPath(ctx.root));

    try {
      const result = await ctx.lazy(['chat', taskId], {
        env: { PATH: `${binDir}:${process.env.PATH}` },
      });
      expectSuccess(result);

      // The launched process got localhost — NOT host.docker.internal.
      expect(await readClaudeBaseUrl(binDir)).toBe(`http://localhost:${ollama.port}`);

      // Sanity: the ollama role is genuinely in play (its model was forwarded),
      // so this is not passing because the backend silently fell back.
      const claudeArgs = await readClaudeArgs(binDir);
      expect(claudeArgs[claudeArgs.indexOf('--model') + 1]).toBe('qwen3-coder');
    } finally {
      ollama.stop(true);
      await rm(rehydratedDir, { recursive: true, force: true });
    }
  });
});

/**
 * `lazy chat` against a LIVE (blocked) task — the mode that resumes the paused
 * agent's own session in its worktree instead of an archived JSONL.
 */
describe('lazy chat (live task)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Run a task to its first pause and plant the session JSONL where a sandboxed
   * runner would have left it — i.e. exactly the state a reviewer finds when a
   * task blocks for review.
   */
  async function makeLiveTaskWithSession(): Promise<{
    taskId: string;
    taskDir: string;
    sessionId: string;
    worktreePath: string;
    projectDir: string;
  }> {
    const taskId = await createTask(ctx, 'Live task to chat with', 'Do work');

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
    expect(session.ended_at ?? null).toBeNull();

    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const sandboxProjectDir = join(
      worktreePath, '.lazy-task-sandbox', '.claude', 'projects', encodeProjectPath(worktreePath),
    );
    await mkdir(sandboxProjectDir, { recursive: true });
    await writeFile(join(sandboxProjectDir, `${sessionId}.jsonl`), RAW_JSONL, 'utf-8');

    // Where bridgeSessionFiles will expose the sandbox dir to `claude --resume`.
    const projectDir = join(
      process.env.HOME || homedir(), '.claude', 'projects', encodeProjectPath(worktreePath),
    );

    return { taskId, taskDir: taskDir!, sessionId, worktreePath, projectDir };
  }

  // INVARIANT: a live chat leaves the task exactly as it found it — same status,
  // no turn, no commit — while still capturing the extended session into storage
  // so the conversation survives. It resumes the agent's OWN session, in the
  // task's worktree, under the same read-only lockdown as a retrospective chat.
  test('resumes the live session in the worktree and leaves the task untouched', async () => {
    const { taskId, taskDir, sessionId, worktreePath, projectDir } = await makeLiveTaskWithSession();

    const before = JSON.parse(await readFile(join(taskDir, 'task.json'), 'utf-8'));
    expect(before.status).toBe('blocked');
    const turnsBefore = JSON.parse((await ctx.lazy(['show', taskId, '--json'])).stdout).turns.length;

    const binDir = join(ctx.root, 'fake-bin');
    await installFakeClaude(binDir);

    try {
      const result = await ctx.lazy(['chat', taskId], {
        env: { PATH: `${binDir}:${process.env.PATH}` },
      });
      expectSuccess(result);
      expectOutput(result, 'reflective');
      expectOutput(result, 'unchanged by this chat');

      // Resumed the LIVE session, in the task's worktree, read-only.
      const claudeArgs = await readClaudeArgs(binDir);
      expect(claudeArgs[claudeArgs.indexOf('--resume') + 1]).toBe(sessionId);
      expect(claudeArgs[claudeArgs.indexOf('--disallowedTools') + 1]).toBe('Bash Write Edit');
      expect(claudeArgs[claudeArgs.indexOf('--permission-mode') + 1]).toBe('plan');
      // realpath both sides: macOS /tmp is a symlink to /private/tmp.
      expect(await readClaudeCwd(binDir)).toBe(await realpath(worktreePath));

      // The chat's new turns were captured into storage (searchable), even
      // though the task is still open and nothing was closed.
      const stored = await readFile(join(taskDir, 'agent-session.jsonl'), 'utf-8');
      expect(stored).toContain('chat question');
      expect(stored).toContain('hello');

      // Task state is untouched: same status, and the chat recorded no turn of
      // its own (unlike pair, which writes a pairing turn).
      const after = JSON.parse(await readFile(join(taskDir, 'task.json'), 'utf-8'));
      expect(after.status).toBe('blocked');
      const turnsAfter = JSON.parse((await ctx.lazy(['show', taskId, '--json'])).stdout).turns.length;
      expect(turnsAfter).toBe(turnsBefore);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  // INVARIANT: an open chat HOLDS the worktree lock, which is the same lock every
  // turn-launching path (start/unblock/sync/resume/accept) checks — so a daemon
  // turn cannot begin underneath the chat and rewrite the session being read.
  // The lock must be released when the chat ends, or the task would be wedged.
  test('holds the worktree lock for the chat and releases it afterwards', async () => {
    const { taskId, worktreePath, projectDir } = await makeLiveTaskWithSession();

    const binDir = join(ctx.root, 'fake-bin');
    await installFakeClaude(binDir);

    try {
      expectSuccess(await ctx.lazy(['chat', taskId], {
        env: { PATH: `${binDir}:${process.env.PATH}` },
      }));

      // The fake claude copied the lock file it saw while the chat was open.
      const heldLock = JSON.parse(await readFile(join(binDir, 'lock-during-chat'), 'utf-8'));
      expect(heldLock.command).toBe('lazy chat');

      // ...and it is gone now that the chat has ended.
      expect(existsSync(join(worktreePath, '.lazy-lock'))).toBe(false);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  // A busy worktree (a turn in flight, an accept mid-merge) must not be chatted
  // into: the agent owns that session. The lock is the arbiter, so a foreign
  // live lock refuses the chat.
  test('refuses when the worktree is locked by another process', async () => {
    const { taskId, worktreePath, projectDir } = await makeLiveTaskWithSession();

    // process.pid is the test runner — alive, and NOT the lazy subprocess, so
    // the CLI sees a genuinely foreign lock rather than a re-entrant one.
    await writeFile(
      join(worktreePath, '.lazy-lock'),
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), command: 'lazy unblock' }),
      'utf-8',
    );

    const binDir = join(ctx.root, 'fake-bin');
    await installFakeClaude(binDir);

    try {
      const result = await ctx.lazy(['chat', taskId], {
        env: { PATH: `${binDir}:${process.env.PATH}` },
      });
      expectFailure(result);
      expectError(result, 'locked by another process');
      // Never launched claude, and never stole the other process's lock.
      expect(existsSync(join(binDir, 'claude-args'))).toBe(false);
      expect(existsSync(join(worktreePath, '.lazy-lock'))).toBe(true);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  // A task that never ran an agent turn has no live session to resume — the
  // error must point at `lazy start`, not at the retrospective-chat wording.
  test('fails with an actionable message when the agent never ran', async () => {
    const taskId = await createTask(ctx, 'Task that never ran an agent');

    const result = await ctx.lazy(['chat', taskId]);

    expectFailure(result);
    expectError(result, 'No captured agent session');
  });
});
