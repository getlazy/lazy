/**
 * Unit tests for `readAgentReportFromSessionLog`.
 *
 * This helper is the load-bearing half of incremental turn persistence: it
 * reads the agent's written report back from the Claude Code session transcript
 * that was written to disk incrementally as the agent produced it. That is what
 * lets stranded-turn recovery surface the real report instead of a placeholder
 * when the supervisor's finalize is lost.
 *
 * INVARIANTS encoded here:
 *   1. The report is the latest-timestamped assistant message that has text.
 *   2. Discovery works WITHOUT a known session id (the realistic stranded
 *      first-turn case, where `agent_session_id` was never persisted).
 *   3. Tool-only assistant messages (no text) are skipped.
 *   4. A missing/empty transcript yields null (caller falls back to placeholder),
 *      never a throw.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readAgentReportFromSessionLog } from '../../src/import/recover-agent-report';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

async function projectDir(worktree: string): Promise<string> {
  const dir = join(worktree, '.lazy-task-sandbox', '.claude', 'projects', encodeProjectPath(worktree));
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('readAgentReportFromSessionLog', () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'lazy-report-wt-'));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  // INVARIANT 1 + 2: latest assistant text is the report, found without a session id.
  test('returns the latest assistant text, discovered without a session id', async () => {
    const dir = await projectDir(worktree);
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-06-16T10:00:00Z', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-16T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'first thought' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-16T10:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'FINAL REPORT' }] } }),
    ];
    await writeFile(join(dir, 'whatever-session.jsonl'), lines.join('\n') + '\n');

    const report = await readAgentReportFromSessionLog(worktree, null);
    expect(report).toBe('FINAL REPORT');
  });

  // INVARIANT 3: a trailing tool-only assistant message must not shadow the report.
  test('skips tool-only assistant messages with no text', async () => {
    const dir = await projectDir(worktree);
    const lines = [
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-16T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'the report' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-16T10:02:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'lazy_commit', input: {} }] } }),
    ];
    await writeFile(join(dir, 's.jsonl'), lines.join('\n') + '\n');

    const report = await readAgentReportFromSessionLog(worktree, null);
    expect(report).toBe('the report');
  });

  // INVARIANT 4: no transcript → null, no throw.
  test('returns null when there is no transcript on disk', async () => {
    const report = await readAgentReportFromSessionLog(worktree, 'missing-session');
    expect(report).toBeNull();
  });
});
