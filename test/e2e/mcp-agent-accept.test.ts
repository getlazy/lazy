/**
 * E2E: an agent accepting its OWN subtask over MCP.
 *
 * This closes the self-orchestration loop `agent-subtask-mcp` opened: an agent
 * can create and start subtasks, and now merge them back through the SAME
 * controlled accept path a human uses — instead of reaching for raw `git merge`
 * and stranding the subtask's bookkeeping.
 *
 * Two boundaries are exercised here, both enforced server-side (not by prompt
 * guidance):
 *
 *  1. The MCP ownership gate (`assertAgentMayTargetChildOnly`): an agent may
 *     accept ONLY a DIRECT child of its own task. Its own task, a sibling's
 *     subtask, and its own grandchild are all out of reach — self-accept makes
 *     no sense at any level of the hierarchy, because accepting is the review
 *     decision the agent exists to be subject to.
 *  2. The daemon's active-parent refusal (`acceptTaskPreflight`): merging into
 *     an ACTIVE parent is refused for everyone EXCEPT a caller whose task id IS
 *     that parent. Two parent statuses qualify — `working` (the parent's agent
 *     is the caller, blocked inside this call) and `pairing` (a human is
 *     driving that session and is the sole actor in the worktree). `merging`
 *     and `interrupted` still refuse for everyone.
 *
 * Companion suites: test/e2e/mcp.test.ts (the full gate table),
 * test/e2e/accept-working-parent.test.ts (the refusal these tests carve one
 * narrow hole in), test/e2e/mcp-accept-gated.test.ts (protected-branch gate),
 * test/e2e/pair.test.ts (the pairing status/lock guards on the accepted task).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { resolve, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { spawn } from '../../src/utils/spawn';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { findFullTaskId, readSessionJson, readTaskStatus, setTaskMetadata, setTaskStatus } from '../helpers/storage';
import { MCP_SERVER_ENV_PINS } from '../helpers/mcp-env';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: { content?: Array<{ text: string }>; isError?: boolean; [key: string]: unknown };
  error?: { code: number; message: string };
}

/**
 * A long-lived MCP session scoped to ONE task — i.e. the agent's own surface.
 *
 * It has to be long-lived (rather than the one-shot runMcpSession helper) for
 * the confirmation-code test: pending codes live in the MCP server process, and
 * a real agent's preview + confirm calls arrive on the same connection.
 */
class AgentSession {
  private proc: ReturnType<typeof spawn>;
  private stdin: import('bun').FileSink;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = '';
  private nextId = 1;

  constructor(root: string, taskId: string, worktreePath: string) {
    this.proc = spawn(['bun', 'run', AGENT_ENTRY, 'mcp', '--task-id', taskId, '--worktree', worktreePath], {
      cwd: root,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...MCP_SERVER_ENV_PINS },
    });
    this.stdin = this.proc.stdin as import('bun').FileSink;
    this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
  }

  private async readResponse(id: number): Promise<JsonRpcResponse> {
    const decoder = new TextDecoder();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const nl = this.buffer.indexOf('\n');
      if (nl !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as JsonRpcResponse;
            if (parsed.id === id) return parsed;
          } catch {
            // Non-JSON line (banner, stray log) — keep reading.
          }
        }
        continue;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error(`MCP process exited before replying to id=${id}`);
      this.buffer += decoder.decode(value, { stream: true });
    }
    throw new Error(`Timed out waiting for MCP reply id=${id}`);
  }

  async initialize(): Promise<void> {
    const id = this.nextId++;
    this.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: {} }) + '\n');
    await this.stdin.flush();
    await this.readResponse(id);
  }

  /** Call a tool; returns the flattened text payload and the isError flag. */
  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const id = this.nextId++;
    this.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n',
    );
    await this.stdin.flush();
    const res = await this.readResponse(id);
    if (res.error) return { text: JSON.stringify(res.error), isError: true };
    return {
      text: res.result?.content?.map(c => c.text).join('\n') ?? '',
      isError: res.result?.isError === true,
    };
  }

  async close(): Promise<void> {
    this.stdin.end();
    this.reader.releaseLock();
    await this.proc.exited;
  }
}

/** Extract a child task ID from "Created variant task <id>" output. */
function extractVariantTaskId(output: string): string {
  const match = output.match(/Created variant task ([a-f0-9]{8})/);
  if (!match) throw new Error(`Could not extract variant task ID from output: ${output}`);
  return match[1];
}

async function waitForTask(ctx: TestContext, taskId: string): Promise<void> {
  const result = await ctx.lazy(['wait', taskId]);
  if (result.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${result.stderr}\n${result.stdout}`);
  }
}

/** Start a top-level task and leave it blocked with a session + branch. */
async function startedTask(ctx: TestContext, goal: string): Promise<string> {
  const id = await createTask(ctx, goal, `Do ${goal}`);
  expectSuccess(
    await ctx.lazyMocked(['start', id, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }),
  );
  await waitForTask(ctx, id);
  return id;
}

/**
 * Give `parentId` a started subtask carrying `lines` lines of committed work.
 * The line count decides the accept confirmation level (<= 20 lines and <= 2
 * files is level 'none', i.e. executes without a confirmation code).
 */
async function startedSubtask(
  ctx: TestContext,
  parentId: string,
  goal: string,
  lines = 3,
): Promise<string> {
  const branchResult = await ctx.lazyMocked(
    ['branch', parentId, '--goal', goal, '--prompt', `Do ${goal}`, '--yes'],
    MOCK_CLAUDE_SUCCESS,
    { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
  );
  expectSuccess(branchResult);
  const childId = extractVariantTaskId(branchResult.stdout);
  await waitForTask(ctx, childId);

  const worktree = join(ctx.root, '.lazy', 'worktrees', childId);
  const file = `${goal.replace(/\W+/g, '-')}.txt`;
  writeFileSync(join(worktree, file), `${goal} line\n`.repeat(lines));
  ctx.git('-C', worktree, 'add', file);
  ctx.git('-C', worktree, 'commit', '-m', `Work for ${goal}`);
  return childId;
}

/** The git branch a task's session is on. */
function branchOf(ctx: TestContext, shortId: string): string {
  const session = readSessionJson(ctx.root, shortId);
  const branch = session?.git_branch as string | undefined;
  if (!branch) throw new Error(`No git_branch recorded for ${shortId}`);
  return branch;
}

describe('MCP: agent accepts its own subtask', () => {
  let ctx: TestContext;
  const sessions: AgentSession[] = [];

  /** Open an MCP session as the agent that owns `shortId`. */
  async function asAgent(shortId: string): Promise<AgentSession> {
    const session = new AgentSession(
      ctx.root,
      findFullTaskId(ctx.root, shortId),
      join(ctx.root, '.lazy', 'worktrees', shortId),
    );
    sessions.push(session);
    await session.initialize();
    return session;
  }

  beforeEach(async () => {
    // start/branch/accept all need a real daemon — daemonless the tasks stay
    // 'working' and accept refuses for the wrong reason.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    while (sessions.length) await sessions.pop()!.close();
    await ctx.cleanup();
  });

  // INVARIANT: the merge target for an agent-driven accept is the PARENT
  // TASK's branch — the caller's own branch — never main. That is what makes
  // the boundary safe: the child's work still faces human review when the
  // agent's own task is later accepted.
  //
  // INVARIANT: the parent being `working` does NOT block this accept. The
  // parent is working precisely because its agent is blocked inside this MCP
  // call; nothing else is touching that worktree. Requiring 'blocked' here is
  // what made agent self-orchestration impossible to close. Every other caller
  // still hits the refusal (test/e2e/accept-working-parent.test.ts).
  test('merge lands on the parent task branch, not main, with the parent still working', async () => {
    const parentId = await startedTask(ctx, 'Parent orchestrator');
    const childId = await startedSubtask(ctx, parentId, 'Child piece');
    const parentBranch = branchOf(ctx, parentId);

    // The realistic state: the parent's agent is mid-turn when it accepts.
    setTaskStatus(ctx.root, parentId, 'working');

    const agent = await asAgent(parentId);
    const res = await agent.call('lazy_accept', { task_id: childId, reason: 'LGTM' });
    expect(res.text).toContain('accepted and merged');

    // The child's commit is on the parent's branch...
    expect(ctx.git('log', '--oneline', parentBranch).stdout).toContain('Child piece');
    // ...and NOT on main.
    expect(ctx.git('log', '--oneline', 'main').stdout).not.toContain('Child piece');

    expect(readTaskStatus(ctx.root, childId)).toBe('complete');
  }, 120000);

  // The accept's audit trail must name the AGENT, not the builder and not a
  // human: someone reviewing later needs to see that a parent agent decided
  // this subtask should land.
  test('records the accept with actor "agent"', async () => {
    const parentId = await startedTask(ctx, 'Attribution parent');
    const childId = await startedSubtask(ctx, parentId, 'Attribution child');
    setTaskStatus(ctx.root, parentId, 'working');

    const agent = await asAgent(parentId);
    expect((await agent.call('lazy_accept', { task_id: childId })).text).toContain('accepted and merged');

    const shown = JSON.parse(
      (await agent.call('lazy_show', { task_id: childId, sections: ['status-history'] })).text,
    ) as { status_history?: Array<{ to: string; actor: string | null }> };

    const completeEntry = (shown.status_history ?? []).find(e => e.to === 'complete');
    expect(completeEntry).toBeDefined();
    expect(completeEntry!.actor).toBe('agent');
  }, 120000);

  // An accept big enough to require confirmation must still be completable by
  // an agent: it cannot answer an interactive prompt, so it re-calls the tool
  // with the code from the guidance. Pending codes live in the MCP server
  // process, so preview and confirm must share one session — which is exactly
  // how an agent issues dependent tool calls.
  test('confirmation-code round trip works for an agent caller', async () => {
    const parentId = await startedTask(ctx, 'Confirming parent');
    // 60 lines is over the 20-line 'none' threshold, so a code is required.
    const childId = await startedSubtask(ctx, parentId, 'Big child', 60);
    const parentBranch = branchOf(ctx, parentId);
    setTaskStatus(ctx.root, parentId, 'working');

    const agent = await asAgent(parentId);

    const preview = await agent.call('lazy_accept', { task_id: childId });
    expect(preview.isError).toBe(true);
    const code = preview.text.match(/\bac-[0-9a-f]{4}\b/)?.[0];
    expect(code).toBeDefined();
    // INVARIANT: the preview must not mutate anything — nothing merged yet.
    expect(ctx.git('log', '--oneline', parentBranch).stdout).not.toContain('Big child');
    expect(readTaskStatus(ctx.root, childId)).not.toBe('complete');

    // A wrong code is refused: the code is a real check, not decoration.
    const bogus = await agent.call('lazy_accept', { task_id: childId, confirmation_code: 'ac-dead' });
    expect(bogus.text).toContain('Invalid or expired confirmation code');

    // Re-preview (the bogus attempt above consumed nothing) and confirm.
    const code2 = (await agent.call('lazy_accept', { task_id: childId })).text.match(/\bac-[0-9a-f]{4}\b/)?.[0];
    expect(code2).toBeDefined();
    const confirmed = await agent.call('lazy_accept', { task_id: childId, confirmation_code: code2! });
    expect(confirmed.text).toContain('accepted and merged');
    expect(ctx.git('log', '--oneline', parentBranch).stdout).toContain('Big child');
  }, 120000);

  /**
   * Put a parent into `pairing` the way test/e2e/pair.test.ts does: the status
   * plus a LIVE pid, so the reconciler's stale-pairing sweep doesn't quietly
   * put it back to `blocked` underneath the test.
   */
  function setPairing(shortId: string): void {
    setTaskStatus(ctx.root, shortId, 'pairing');
    setTaskMetadata(ctx.root, shortId, 'pairing_pid', String(process.pid));
    setTaskMetadata(ctx.root, shortId, 'pairing_started_at', new Date().toISOString());
  }

  // INVARIANT: `pairing` is exempt from the active-parent refusal on the same
  // terms as `working` — for an identity-matched caller ONLY. In pairing a
  // human is driving that session interactively and is the sole actor in the
  // worktree, so an accept issued from it is that human's decision, and the
  // quiescence argument is identical to the `working` case.
  //
  // The narrowness is the point: this is keyed on the caller's task id matching
  // the merge DESTINATION. A CLI accept into the same pairing parent still gets
  // refused — test/e2e/accept-working-parent.test.ts asserts exactly that, and
  // test/e2e/pair.test.ts asserts the pairing guards on the accepted task.
  test('accepts into a `pairing` parent for the parent itself', async () => {
    const parentId = await startedTask(ctx, 'Paired parent');
    const childId = await startedSubtask(ctx, parentId, 'Child during pairing');
    const parentBranch = branchOf(ctx, parentId);

    setPairing(parentId);

    const agent = await asAgent(parentId);
    const res = await agent.call('lazy_accept', { task_id: childId, reason: 'LGTM' });
    expect(res.text).toContain('accepted and merged');

    expect(ctx.git('log', '--oneline', parentBranch).stdout).toContain('Child during pairing');
    expect(ctx.git('log', '--oneline', 'main').stdout).not.toContain('Child during pairing');
    expect(readTaskStatus(ctx.root, childId)).toBe('complete');
  }, 120000);

  // In pairing the destination worktree plausibly holds the human's own
  // uncommitted edits. The merge must land AND the edits must survive: the
  // accept stashes them, merges into the now-clean worktree, and pops the stash
  // back on top. Losing that work would be the worst failure mode this feature
  // could have, so it is asserted rather than assumed.
  test('preserves uncommitted work in a `pairing` destination worktree', async () => {
    const parentId = await startedTask(ctx, 'Paired dirty parent');
    const childId = await startedSubtask(ctx, parentId, 'Child into dirty parent');
    const parentBranch = branchOf(ctx, parentId);
    const parentWorktree = join(ctx.root, '.lazy', 'worktrees', parentId);

    // The human's in-progress edit, uncommitted, in the paired worktree.
    writeFileSync(join(parentWorktree, 'human-wip.txt'), 'half-written thought\n');

    setPairing(parentId);

    const agent = await asAgent(parentId);
    const res = await agent.call('lazy_accept', { task_id: childId });
    expect(res.text).toContain('accepted and merged');

    // The merge landed...
    expect(ctx.git('log', '--oneline', parentBranch).stdout).toContain('Child into dirty parent');
    // ...and the human's uncommitted file is still sitting there afterwards.
    expect(existsSync(join(parentWorktree, 'human-wip.txt'))).toBe(true);
    expect(readFileSync(join(parentWorktree, 'human-wip.txt'), 'utf-8')).toBe('half-written thought\n');
    // ...still UNCOMMITTED. This is what proves the stash/restore path actually
    // ran: a file that had been swept into the merge commit would also "exist".
    expect(ctx.git('-C', parentWorktree, 'status', '--porcelain').stdout).toContain('human-wip.txt');
  }, 120000);

  // INVARIANT: an agent may NOT accept its OWN task, at any level of the
  // hierarchy. Accepting itself would merge its work upward and mark itself
  // complete with no human (or builder) review — the whole point of the review
  // boundary. Refused server-side, before any confirmation-code or merge logic.
  test('rejects an agent accepting its own task', async () => {
    const parentId = await startedTask(ctx, 'Self accepting parent');
    const mainBefore = ctx.git('log', '--oneline', 'main').stdout;

    const agent = await asAgent(parentId);
    const res = await agent.call('lazy_accept', { task_id: parentId });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('may not accept their own task');
    // Nothing merged into main, and the task is not complete.
    expect(ctx.git('log', '--oneline', 'main').stdout).toBe(mainBefore);
    expect(readTaskStatus(ctx.root, parentId)).not.toBe('complete');
  }, 120000);

  // INVARIANT: self-accept is refused at EVERY level, not just the top. A child
  // task that itself has a subtask still cannot accept ITSELF — the gate keys
  // on "target is a direct child of the caller", so depth changes nothing.
  test('rejects a mid-hierarchy agent accepting its own task', async () => {
    const parentId = await startedTask(ctx, 'Hierarchy root');
    const childId = await startedSubtask(ctx, parentId, 'Middle task');
    const parentBranch = branchOf(ctx, parentId);

    // The middle task is a parent in its own right — it still cannot self-accept.
    const agent = await asAgent(childId);
    const res = await agent.call('lazy_accept', { task_id: childId });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('may not accept their own task');
    expect(ctx.git('log', '--oneline', parentBranch).stdout).not.toContain('Middle task');
    expect(readTaskStatus(ctx.root, childId)).not.toBe('complete');
  }, 180000);

  // INVARIANT: an agent may NOT accept another task's subtask. Ownership is
  // "direct child of MY task" — sibling subtrees are off limits even though
  // they are equally "not main".
  test('rejects an agent accepting a sibling task\'s subtask', async () => {
    const myParentId = await startedTask(ctx, 'My parent');
    const otherParentId = await startedTask(ctx, 'Other parent');
    const otherChildId = await startedSubtask(ctx, otherParentId, 'Other child');
    const otherParentBranch = branchOf(ctx, otherParentId);

    const agent = await asAgent(myParentId);
    const res = await agent.call('lazy_accept', { task_id: otherChildId });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('own direct subtasks');
    // The other subtree is untouched.
    expect(ctx.git('log', '--oneline', otherParentBranch).stdout).not.toContain('Other child');
    expect(readTaskStatus(ctx.root, otherChildId)).not.toBe('complete');
  }, 180000);

  // INVARIANT: the gate is on the DIRECT parent link, so a grandchild is out
  // of reach too — an agent cannot accept work its own child owns.
  test('rejects an agent accepting a grandchild task', async () => {
    const parentId = await startedTask(ctx, 'Grandparent');
    const childId = await startedSubtask(ctx, parentId, 'Middle child');
    const grandchildId = await startedSubtask(ctx, childId, 'Grandchild');

    const agent = await asAgent(parentId);
    const res = await agent.call('lazy_accept', { task_id: grandchildId });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('own direct subtasks');
    expect(readTaskStatus(ctx.root, grandchildId)).not.toBe('complete');
  }, 180000);
});
