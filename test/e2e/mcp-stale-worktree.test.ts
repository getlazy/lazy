/**
 * INVARIANT: a failing lazy tool answers with an error — it never takes the
 * agent's whole tool channel down with it.
 *
 * The incident this encodes: an agent's `~/.claude.json` entry was overwritten
 * by an e2e supervisor, so its MCP server came up bound to a `/tmp/lazy-e2e-*`
 * worktree that had already been cleaned up. `lazy_commit` failed with git's
 * "working directory ... does not exist", and the NEXT call, `lazy_status`,
 * came back "Connection closed" — the server process had exited, so every
 * remaining `lazy_*` tool was gone for the rest of the turn.
 *
 * Two things were wrong and both are asserted here:
 *   1. The stale-cwd failure described a directory the agent never chose.
 *      It now names the worktree, the task, the likely cause and the remedy.
 *   2. `requireStorage()` ended in `process.exit(1)` — fine for a one-shot CLI
 *      command, fatal inside a tool handler. Storage failures now throw and the
 *      server keeps serving (src/preconditions.ts: resolveStorage).
 *
 * Deliberately daemonless and project-less: both failures are meant to be
 * reachable without any of that, and the point of the suite is that the process
 * SURVIVES them. Both entry points are exercised, because they are separate
 * files that have drifted before — the host-process runner spawns `lazy mcp`
 * (src/index.ts), containers spawn `lazy-agent mcp` (src/agent-entry.ts).
 */

import { describe, test, expect } from 'bun:test';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp, rm } from 'fs/promises';
import { MCP_SERVER_ENV_PINS } from '../helpers/mcp-env';

const CLI_ENTRY = resolve(__dirname, '../../src/index.ts');
const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

const TASK_ID = '482b10cc-0000-4000-8000-000000000001';

interface JsonRpcResponse {
  id: number | string | null;
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

/**
 * Drive one MCP server over stdio and return its responses.
 *
 * `entry === 'cli'` runs `lazy mcp`, `'agent'` runs `lazy-agent mcp` — the two
 * spellings a real turn can get.
 */
async function callTools(
  entry: 'cli' | 'agent',
  worktreePath: string,
  calls: Array<{ id: number; name: string; args?: Record<string, unknown> }>,
  extraEnv: Record<string, string> = {},
): Promise<{ responses: JsonRpcResponse[]; stderr: string; exitCode: number | null }> {
  const argv = entry === 'cli'
    ? ['bun', 'run', CLI_ENTRY, 'mcp', '--task-id', TASK_ID, '--worktree', worktreePath]
    : ['bun', 'run', AGENT_ENTRY, 'mcp', '--task-id', TASK_ID, '--worktree', worktreePath];

  const proc = Bun.spawn(argv, {
    cwd: tmpdir(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    // The guards under test must not be reached through the LAZY_TEST bypass,
    // and LAZY_IS_DAEMON leaks across files — see test/helpers/mcp-env.ts.
    // `extraEnv` goes LAST so a test can deliberately re-poison what the pins
    // clear — that is the whole subject of the turn-identity block below.
    env: { ...process.env, ...MCP_SERVER_ENV_PINS, ...extraEnv },
  });

  const stdin = proc.stdin as import('bun').FileSink;
  // A server that refuses to start is gone before the first write lands, so
  // every write is best-effort — those tests assert on stderr and the exit code.
  const write = (msg: Record<string, unknown>) => {
    try {
      stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    } catch {
      // Broken pipe: the process exited before reading. Expected in the
      // turn-identity refusal tests, harmless everywhere else.
    }
  };

  write({ id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
  await Bun.sleep(50);
  write({ method: 'notifications/initialized' });
  for (const call of calls) {
    await Bun.sleep(50);
    write({ id: call.id, method: 'tools/call', params: { name: call.name, arguments: call.args ?? {} } });
  }
  await Bun.sleep(100);
  try {
    stdin.end();
  } catch {
    // Same broken-pipe case as write() above.
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  const responses: JsonRpcResponse[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      // Non-JSON diagnostics on stdout are not part of the protocol stream.
    }
  }
  return { responses, stderr, exitCode };
}

/** The text a tool returned, whether it came back as a result or an error. */
function textOf(response: JsonRpcResponse | undefined): string {
  if (!response) return '';
  if (response.error) return response.error.message;
  return (response.result?.content ?? []).map(c => c.text).join('\n');
}

describe('MCP server bound to a deleted worktree', () => {
  test('lazy_commit and lazy_status explain the dead worktree and the server survives both', async () => {
    // A path shaped exactly like the one from the incident report.
    const gone = join(tmpdir(), 'lazy-e2e-deleted-4c1a', '.lazy', 'worktrees', '482b10cc');

    const { responses, exitCode } = await callTools('agent', gone, [
      { id: 1, name: 'lazy_commit', args: { message: 'wip' } },
      { id: 2, name: 'lazy_status' },
      { id: 3, name: 'lazy_status' },
    ]);

    const commit = textOf(responses.find(r => r.id === 1));
    expect(commit).toContain(gone);
    expect(commit).toContain(TASK_ID);
    expect(commit).toContain('.claude.json');
    // Git's own wording is what the agent used to get, and it named nothing
    // actionable. If this ever reappears the guard has been bypassed.
    expect(commit).not.toContain('working directory');

    const status = textOf(responses.find(r => r.id === 2));
    expect(status).toContain(gone);

    // THE regression: the second call after a failure was "Connection closed".
    expect(responses.find(r => r.id === 3)).toBeDefined();
    expect(textOf(responses.find(r => r.id === 3))).toContain(gone);

    // Exited because stdin closed, not because a handler killed it.
    expect(exitCode).toBe(0);
  }, 30000);

  test('the `lazy mcp` entry behaves identically to `lazy-agent mcp`', async () => {
    const gone = join(tmpdir(), 'lazy-e2e-deleted-7b22', '.lazy', 'worktrees', '482b10cc');

    const { responses, exitCode } = await callTools('cli', gone, [
      { id: 1, name: 'lazy_status' },
      { id: 2, name: 'lazy_status' },
    ]);

    expect(textOf(responses.find(r => r.id === 1))).toContain(gone);
    expect(responses.find(r => r.id === 2)).toBeDefined();
    expect(exitCode).toBe(0);
  }, 30000);
});

describe('MCP server that cannot reach storage', () => {
  // INVARIANT: `resolveStorage()` throws. The CLI wrapper `requireStorage()`
  // still prints and exits — that is right for one command, and fatal for a
  // server that has to answer the next call.
  test('a storage failure is an error response, not a dead process', async () => {
    // A real directory, so the worktree guard passes and the call gets all the
    // way to storage — where no daemon is listening.
    const live = await mkdtemp(join(tmpdir(), 'lazy-mcp-live-'));
    try {
      const { responses, exitCode } = await callTools('agent', live, [
        { id: 1, name: 'lazy_list' },
        { id: 2, name: 'lazy_list' },
      ]);

      const first = textOf(responses.find(r => r.id === 1));
      expect(first.length).toBeGreaterThan(0);
      // Whatever precondition bit first, it must be said out loud rather than
      // exiting: both messages below are LazyPreconditionError text.
      expect(first).toMatch(/not in a lazy project|Daemon is not running/);

      // The channel is still there for the next tool call.
      expect(responses.find(r => r.id === 2)).toBeDefined();
      expect(exitCode).toBe(0);
    } finally {
      await rm(live, { recursive: true, force: true });
    }
  }, 30000);
});

describe('MCP server spawned for a different turn than it claims', () => {
  // INVARIANT: an agent gets its own task's tools or none — never another
  // task's. The supervisor exports the turn it is about to run
  // (LAZY_MCP_EXPECTED_*); a server whose ~/.claude.json entry names a different
  // task refuses to start rather than serving the wrong state.
  //
  // Covered as a unit in mcp-turn-identity.test.ts. This block exists because
  // the unit test cannot see what the ENVIRONMENT does to the check — and that
  // is where the real defect was: the expectation leaks out of a lazy turn into
  // every process below it, so it arrives set in suites that have nothing to do
  // with it.
  const OTHER_TASK = '91290431-0000-4000-8000-00000000beef';

  test('refuses and exits when the expectation names another task', async () => {
    const live = await mkdtemp(join(tmpdir(), 'lazy-mcp-turn-'));
    try {
      const { responses, stderr, exitCode } = await callTools('agent', live, [
        { id: 1, name: 'lazy_status' },
      ], { LAZY_MCP_EXPECTED_TASK_ID: OTHER_TASK });

      expect(stderr).toContain('Refusing to serve lazy MCP tools');
      // Both sides named, so the reader can tell which process to go kill.
      expect(stderr).toContain(OTHER_TASK);
      expect(stderr).toContain(TASK_ID);
      expect(exitCode).not.toBe(0);
      // No tools, rather than the wrong task's tools.
      expect(responses.filter(r => r.id === 1)).toEqual([]);
    } finally {
      await rm(live, { recursive: true, force: true });
    }
  }, 30000);

  test('the CLI entry refuses identically to the agent entry', async () => {
    const live = await mkdtemp(join(tmpdir(), 'lazy-mcp-turn-cli-'));
    try {
      const { stderr, exitCode } = await callTools('cli', live, [
        { id: 1, name: 'lazy_status' },
      ], { LAZY_MCP_EXPECTED_TASK_ID: OTHER_TASK });

      expect(stderr).toContain('Refusing to serve lazy MCP tools');
      expect(exitCode).not.toBe(0);
    } finally {
      await rm(live, { recursive: true, force: true });
    }
  }, 30000);

  test('a matching expectation is served normally', async () => {
    // Guards the other direction: a check that refused unconditionally would
    // pass every assertion above and break every real turn.
    const live = await mkdtemp(join(tmpdir(), 'lazy-mcp-turn-ok-'));
    try {
      const { responses, stderr } = await callTools('agent', live, [
        { id: 1, name: 'lazy_list' },
      ], { LAZY_MCP_EXPECTED_TASK_ID: TASK_ID, LAZY_MCP_EXPECTED_WORKTREE: live });

      expect(stderr).not.toContain('Refusing to serve lazy MCP tools');
      expect(responses.find(r => r.id === 1)).toBeDefined();
    } finally {
      await rm(live, { recursive: true, force: true });
    }
  }, 30000);

  test('MCP_SERVER_ENV_PINS clears an expectation inherited from an outer turn', async () => {
    // THE regression this block was added for. prepareTurnMcp sets
    // LAZY_MCP_EXPECTED_* on the SUPERVISOR's process.env and the agent is
    // spawned with `env: process.env`, so an agent running the e2e suite in its
    // worktree carries its own turn's expectation into every server these
    // suites spawn. Unpinned, each would mismatch its own --task-id and refuse
    // — every MCP suite red, but only when run inside a lazy turn, which is
    // exactly where they are usually run and never where they are debugged.
    const live = await mkdtemp(join(tmpdir(), 'lazy-mcp-turn-pin-'));
    const saved = {
      id: process.env.LAZY_MCP_EXPECTED_TASK_ID,
      wt: process.env.LAZY_MCP_EXPECTED_WORKTREE,
    };
    try {
      // Poison this process's env exactly the way a lazy turn does, then rely on
      // the pins (applied inside callTools) to clear it.
      process.env.LAZY_MCP_EXPECTED_TASK_ID = OTHER_TASK;
      process.env.LAZY_MCP_EXPECTED_WORKTREE = '/tmp/some-other-turn';

      const { responses, stderr } = await callTools('agent', live, [{ id: 1, name: 'lazy_list' }]);

      expect(stderr).not.toContain('Refusing to serve lazy MCP tools');
      expect(responses.find(r => r.id === 1)).toBeDefined();
    } finally {
      // Restore rather than delete: this process's env is shared with every
      // later test FILE in the run (see test/helpers/in-process-daemon.ts).
      if (saved.id === undefined) delete process.env.LAZY_MCP_EXPECTED_TASK_ID;
      else process.env.LAZY_MCP_EXPECTED_TASK_ID = saved.id;
      if (saved.wt === undefined) delete process.env.LAZY_MCP_EXPECTED_WORKTREE;
      else process.env.LAZY_MCP_EXPECTED_WORKTREE = saved.wt;
      await rm(live, { recursive: true, force: true });
    }
  }, 30000);
});
