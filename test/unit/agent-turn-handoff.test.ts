/**
 * Unit tests for the end-of-turn agent handoff file.
 *
 * WHY IT EXISTS: the `lazy_*` MCP tools are an agent's only channel to lazy
 * state, and that channel can die mid-turn (a daemon restart moving the port, a
 * dead stdio child). Agents then reached the end of a turn holding the most
 * expensive thing to lose — their journal entry and follow-ups — with nowhere to
 * put it. The CLI fallback they improvised fails with EROFS in a container and
 * would bypass the daemon's storage ownership even if it could write.
 *
 * So the agent appends NDJSON to `<worktree>/.lazy-task-sandbox/
 * turn-handoff.jsonl`, the supervisor collects it (on the success path AND the
 * failure path), and the reconciler persists it through Storage.
 *
 * INVARIANTS pinned here:
 *   1. Collection is non-fatal: no file, a truncated line, or junk never throws
 *      — this runs on the way OUT of a turn, including a crashed one.
 *   2. A stale file from a previous turn is cleared before the agent runs.
 *   3. Handoff entries land as an `agent`-actored journal entry / a follow-up.
 *   4. Persistence is idempotent by CONTENT — a reconciler re-run, or an agent
 *      whose tools came back and ALSO made the tool call, must not double-write.
 *   5. It works on the ERROR path: a watchdog kill still lands the agent's
 *      account of the turn.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { handleCompletedResponses, handleErrorResponse } from '../../src/utils/reconcile';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import type { CompletedResponse, ErrorResponse } from '../../src/protocol';
import { getWorktreePathForRef, taskRef } from '../../src/cli/helpers';
import { spawnSync } from '../../src/utils/spawn';
import { SANDBOX_DIR } from '../../src/utils/sandbox';
import {
  clearTurnHandoff,
  collectTurnHandoff,
  appendTurnHandoff,
  turnHandoffPath,
  TURN_HANDOFF_FILENAME,
} from '../../src/supervisor/turn-handoff';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.stdout?.toString().trim() ?? '';
}

describe('turn handoff file (agent side)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-handoff-'));
    await mkdir(join(dir, SANDBOX_DIR), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('lives in the gitignored sandbox dir', () => {
    expect(turnHandoffPath(dir)).toBe(join(dir, SANDBOX_DIR, TURN_HANDOFF_FILENAME));
  });

  // INVARIANT 1: the normal case is "no file at all" — the tools worked.
  test('no file collects nothing and never throws', async () => {
    expect(await collectTurnHandoff(dir)).toEqual([]);
  });

  test('collects journal entries and follow-ups in order', async () => {
    await appendTurnHandoff(dir, { kind: 'journal', content: 'Chose X over Y.' });
    await appendTurnHandoff(dir, { kind: 'followup', content: 'foo.ts swallows errors.' });

    expect(await collectTurnHandoff(dir)).toEqual([
      { kind: 'journal', content: 'Chose X over Y.' },
      { kind: 'followup', content: 'foo.ts swallows errors.' },
    ]);
  });

  // INVARIANT 1: one bad line must not discard the good ones around it. An agent
  // killed mid-write leaves exactly this shape.
  test('skips unusable lines and keeps the rest', async () => {
    await writeFile(turnHandoffPath(dir), [
      '{"kind":"journal","content":"kept"}',
      'not json at all',
      '{"kind":"nonsense","content":"wrong kind"}',
      '{"kind":"journal"}',
      '{"kind":"followup","content":"   "}',
      '{"kind":"journal","content":"also kept"',   // truncated mid-write
      '{"kind":"followup","content":"kept too"}',
      '',
    ].join('\n'));

    expect(await collectTurnHandoff(dir)).toEqual([
      { kind: 'journal', content: 'kept' },
      { kind: 'followup', content: 'kept too' },
    ]);
  });

  // INVARIANT 2: a file left by a previous turn would be re-journaled against a
  // turn whose agent never wrote it.
  test('clearing removes a stale file and is safe when there is none', async () => {
    await appendTurnHandoff(dir, { kind: 'journal', content: 'from last turn' });
    await clearTurnHandoff(dir);
    expect(await collectTurnHandoff(dir)).toEqual([]);
    await clearTurnHandoff(dir);  // idempotent
  });
});

interface Env {
  lazyRoot: string;
  storage: FileStorage;
  baseSha: string;
  cleanup: () => Promise<void>;
}

async function setupEnv(): Promise<Env> {
  const lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-handoff-root-'));
  const basePath = await mkdtemp(join(tmpdir(), 'lazy-handoff-store-'));

  git(lazyRoot, 'init');
  git(lazyRoot, 'config', 'user.email', 'test@lazy.test');
  git(lazyRoot, 'config', 'user.name', 'Lazy Test');
  git(lazyRoot, 'checkout', '-b', 'main');
  await writeFile(join(lazyRoot, 'README.md'), '# base\n');
  git(lazyRoot, 'add', '.');
  git(lazyRoot, 'commit', '-m', 'base');
  const baseSha = git(lazyRoot, 'rev-parse', 'HEAD');

  const storage = new FileStorage(lazyRoot, { basePath });
  await storage.initialize();

  return {
    lazyRoot,
    storage,
    baseSha,
    cleanup: async () => {
      await storage.close();
      await Promise.all([
        rm(lazyRoot, { recursive: true, force: true }),
        rm(basePath, { recursive: true, force: true }),
      ]);
    },
  };
}

async function makeWorkingTask(env: Env, goal: string) {
  const task = await env.storage.createTask(goal, undefined, env.baseSha);
  const ref = taskRef(task);
  const branch = `lazy/${ref}`;
  const session = await env.storage.createSession(task.id, 'claude-code', branch, env.baseSha);
  await env.storage.updateTaskStatus(task.id, 'working', 'system');

  git(env.lazyRoot, 'branch', branch, env.baseSha);
  const worktreePath = getWorktreePathForRef(env.lazyRoot, ref);
  await mkdir(dirname(worktreePath), { recursive: true });
  git(env.lazyRoot, 'worktree', 'add', worktreePath, branch);

  return { ref, taskId: task.id, sessionId: session.id, worktreePath, session };
}

describe('reconciler: persisting an agent handoff', () => {
  let env: Env;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    env = await setupEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  const sessionArg = (s: { id: string; agent_session_id: string | null; git_start_sha: string; container_name: string | null }) => ({
    id: s.id,
    agent_session_id: s.agent_session_id,
    git_start_sha: s.git_start_sha,
    container_name: s.container_name,
  });

  // INVARIANT 3: what the agent could not write through a tool still reaches the
  // store — through the daemon, like every other write.
  test('a completed turn lands the journal entry and the follow-up', async () => {
    const { taskId, worktreePath, session } = await makeWorkingTask(env, 'handoff work');
    const protoDir = getProtocolDir(taskId);

    const response: CompletedResponse = {
      status: 'completed',
      result: 'Done. My lazy tools were unavailable — see the handoff file.',
      session_id: 'sess-1',
      usage: { input_tokens: 1, output_tokens: 1 },
      agent_handoff: [
        { kind: 'journal', content: 'Chose the handoff file over a daemon-routed CLI.' },
        { kind: 'followup', content: 'The retry path in foo.ts swallows errors.' },
      ],
    };

    await handleCompletedResponses(env.storage, taskId, sessionArg(session), [response], worktreePath, protoDir);

    const journal = await env.storage.getTaskJournal(taskId);
    expect(journal.map(e => e.content)).toContain('Chose the handoff file over a daemon-routed CLI.');
    expect(journal.find(e => e.content.startsWith('Chose the handoff'))!.actor).toBe('agent');

    const followUps = await env.storage.getTaskFollowUps(taskId);
    expect(followUps.map(f => f.content)).toEqual(['The retry path in foo.ts swallows errors.']);
  });

  // INVARIANT 4: the reconciler can re-run over a response it already consumed,
  // and an agent whose tools came back may have BOTH written the file and made
  // the call. Neither may double-write.
  test('re-running does not duplicate entries', async () => {
    const { taskId, worktreePath, session } = await makeWorkingTask(env, 'handoff idempotent');
    const protoDir = getProtocolDir(taskId);

    // The agent's own tool call landed first — the file repeats it.
    await env.storage.appendJournalEntry(taskId, 'Same entry, twice over.', 'agent');

    const response: CompletedResponse = {
      status: 'completed',
      result: 'done',
      session_id: 'sess-1',
      usage: { input_tokens: 1, output_tokens: 1 },
      agent_handoff: [{ kind: 'journal', content: 'Same entry, twice over.' }],
    };

    await handleCompletedResponses(env.storage, taskId, sessionArg(session), [response], worktreePath, protoDir);
    await handleCompletedResponses(env.storage, taskId, sessionArg(session), [response], worktreePath, protoDir);

    const journal = await env.storage.getTaskJournal(taskId);
    expect(journal.filter(e => e.content === 'Same entry, twice over.').length).toBe(1);
  });

  // INVARIANT 5: a watchdog kill is exactly when the agent's own account of the
  // turn is most worth keeping.
  test('a failed turn still lands the handoff', async () => {
    const { taskId, session } = await makeWorkingTask(env, 'handoff on crash');
    const protoDir = getProtocolDir(taskId);

    const response: ErrorResponse = {
      status: 'error',
      error: 'Work phase failed: agent produced no output for 30 minutes',
      phase: 'work',
      watchdog_timeout_ms: 1_800_000,
      agent_handoff: [{ kind: 'journal', content: 'Was halfway through the migration when tools died.' }],
    };

    await handleErrorResponse(env.storage, taskId, { id: session.id }, response, protoDir, env.lazyRoot);

    const journal = await env.storage.getTaskJournal(taskId);
    expect(journal.map(e => e.content)).toContain('Was halfway through the migration when tools died.');
  });
});
