/**
 * INVARIANT: an agent's `lazy_*` tool channel reaches ITS OWN task's MCP server
 * or none at all — never another task's.
 *
 * Claude Code reads one MCP config per HOME (`$HOME/.claude.json`), and every
 * lazy supervisor rewrites the single `mcpServers.lazy` entry there before each
 * turn. Two host-process supervisors sharing a HOME therefore share the entry,
 * and a stray one has in practice re-pointed a live agent's tools at a deleted
 * temp worktree. The supervisor exports the turn it is running; the server
 * checks its own arguments against that and refuses to serve a mismatch.
 *
 * These tests pass env OBJECTS rather than touching process.env — the guard's
 * variables must not leak between test files (see CLAUDE.md on LAZY_TEST /
 * LAZY_IS_DAEMON cross-file leaks).
 */

import { describe, test, expect } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, writeFile } from 'fs/promises';
import {
  assertMcpServesExpectedTurn,
  McpTurnIdentityError,
  MCP_EXPECTED_TASK_ID_ENV,
  MCP_EXPECTED_WORKTREE_ENV,
  assertWorktreeUsable,
  McpWorktreeMissingError,
} from '../../src/mcp/turn-identity';

const TASK = '6148d734-0000-4000-8000-000000000001';
const OTHER = '99999999-0000-4000-8000-000000000002';
const WORKTREE = '/repo/.lazy/worktrees/my-task';

describe('assertMcpServesExpectedTurn', () => {
  test('accepts a server spawned for the expected task and worktree', () => {
    expect(() =>
      assertMcpServesExpectedTurn(
        { taskId: TASK, worktreePath: WORKTREE },
        { [MCP_EXPECTED_TASK_ID_ENV]: TASK, [MCP_EXPECTED_WORKTREE_ENV]: WORKTREE },
      ),
    ).not.toThrow();
  });

  test('rejects a server spawned for a different task', () => {
    expect(() =>
      assertMcpServesExpectedTurn(
        { taskId: OTHER, worktreePath: '/tmp/lazy-e2e-abc/worktrees/t1' },
        { [MCP_EXPECTED_TASK_ID_ENV]: TASK, [MCP_EXPECTED_WORKTREE_ENV]: WORKTREE },
      ),
    ).toThrow(McpTurnIdentityError);
  });

  // Same task id, different worktree: the shape a stale entry takes after a
  // task's worktree has been recreated elsewhere.
  test('rejects a matching task in a different worktree', () => {
    expect(() =>
      assertMcpServesExpectedTurn(
        { taskId: TASK, worktreePath: '/tmp/somewhere-else' },
        { [MCP_EXPECTED_TASK_ID_ENV]: TASK, [MCP_EXPECTED_WORKTREE_ENV]: WORKTREE },
      ),
    ).toThrow(McpTurnIdentityError);
  });

  test('rejects a server with no task id when a turn is expected', () => {
    expect(() =>
      assertMcpServesExpectedTurn({}, { [MCP_EXPECTED_TASK_ID_ENV]: TASK }),
    ).toThrow(McpTurnIdentityError);
  });

  // INVARIANT: absent expectation is not a mismatch. The builder and any
  // hand-run `lazy mcp` have no turn to be checked against, and treating an
  // unset variable as a failure would take every one of their tools away.
  test('is a no-op when no turn expectation is set', () => {
    expect(() =>
      assertMcpServesExpectedTurn({ taskId: OTHER, worktreePath: '/anywhere' }, {}),
    ).not.toThrow();
  });

  // The worktree is only checked when the supervisor declared one.
  test('checks the task alone when no worktree expectation is set', () => {
    expect(() =>
      assertMcpServesExpectedTurn(
        { taskId: TASK, worktreePath: '/anywhere' },
        { [MCP_EXPECTED_TASK_ID_ENV]: TASK },
      ),
    ).not.toThrow();
  });

  // Per CLAUDE.md "errors are for humans": the message must name both sides and
  // tell the human how to find the stray supervisor.
  test('names both turns and the remedy in the error', () => {
    let message = '';
    try {
      assertMcpServesExpectedTurn(
        { taskId: OTHER, worktreePath: '/tmp/gone' },
        { [MCP_EXPECTED_TASK_ID_ENV]: TASK, [MCP_EXPECTED_WORKTREE_ENV]: WORKTREE },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(TASK);
    expect(message).toContain(OTHER);
    expect(message).toContain(WORKTREE);
    expect(message).toContain('lazy supervise');
  });
});

/**
 * INVARIANT: a tool bound to a worktree that no longer exists says so in its own
 * words, before git gets to describe a directory the agent never chose.
 *
 * The reported incident ended with `lazy_commit` failing on "working directory
 * '/tmp/lazy-e2e-rKAU4R/.lazy/worktrees/482b10cc' does not exist" — a path from
 * a deleted test temp dir, with nothing in it to act on.
 */
describe('assertWorktreeUsable', () => {
  test('accepts an existing directory', async () => {
    await expect(assertWorktreeUsable('lazy_status', tmpdir(), TASK)).resolves.toBeUndefined();
  });

  test('rejects a missing directory', async () => {
    await expect(
      assertWorktreeUsable('lazy_commit', join(tmpdir(), 'lazy-e2e-gone-9f3c', 'worktrees', 'x'), TASK),
    ).rejects.toBeInstanceOf(McpWorktreeMissingError);
  });

  // A file is not a worktree either — same dead-cwd outcome for git.
  test('rejects a path that is not a directory', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'lazy-wt-')), 'not-a-dir');
    await writeFile(file, 'x');
    await expect(assertWorktreeUsable('lazy_status', file, TASK)).rejects.toBeInstanceOf(McpWorktreeMissingError);
  });

  // Per CLAUDE.md "errors are for humans": name the tool, the path, the task,
  // and what to do — the raw git error had none of those.
  test('names the tool, the path and the remedy', async () => {
    const gone = join(tmpdir(), 'lazy-e2e-gone-4a71', 'worktrees', 'x');
    let message = '';
    try {
      await assertWorktreeUsable('lazy_commit', gone, TASK);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('lazy_commit');
    expect(message).toContain(gone);
    expect(message).toContain(TASK);
    expect(message).toContain('.claude.json');
    expect(message).toContain('lazy supervise');
  });
});
