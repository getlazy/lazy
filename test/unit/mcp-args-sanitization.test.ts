/**
 * Unit tests: MCP tool arguments are sanitized at the intake boundary.
 *
 * MCP travels as JSON, where a JSON `\u0000` escape decodes to a real NUL. The 2026-07-26
 * incident arrived exactly this way: a builder's lazy_unblock feedback carried
 * two literal NULs, which lazy persisted and then handed to `claude -p` as
 * argv[2], crash-looping the turn and silently dropping the feedback.
 *
 * createAllHandlers wraps every handler with the sanitizer, so this is the
 * single seam that has to hold — including for tools added later.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

const NUL = String.fromCharCode(0);

describe('MCP argument sanitization', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-mcp-sanitize-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });

    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
    ctx = { taskId: '', worktreePath: testDir, storage };
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  // INVARIANT: a NUL arriving over MCP must never be persisted raw. It would
  // become argv[2] of `claude -p` on the next turn and crash-loop it.
  test('lazy_create escapes NUL in goal and prompt before persisting', async () => {
    const handlers = createAllHandlers(ctx);
    const result: any = await handlers.get('lazy_create')!({
      goal: `Fix${NUL}the parser`,
      prompt: `Reject${NUL}NUL bytes`,
    });

    expect(result.goal.includes(NUL)).toBe(false);
    expect(result.goal).toBe('Fix\\u0000the parser');

    const task = await storage.getTask(result.id);
    expect(task!.goal.includes(NUL)).toBe(false);

    const prompts = await storage.getPromptHistory(result.id);
    expect(prompts[prompts.length - 1]!.content.includes(NUL)).toBe(false);
    expect(prompts[prompts.length - 1]!.content).toContain('Reject\\u0000NUL bytes');
    // Free-text args disclose the substitution rather than rewriting silently.
    expect(prompts[prompts.length - 1]!.content).toContain('lazy sanitized');
  });

  test('lazy_comment escapes NUL in the message before persisting', async () => {
    const handlers = createAllHandlers(ctx);
    const created: any = await handlers.get('lazy_create')!({ goal: 'Commentable task' });

    await handlers.get('lazy_comment')!({
      task_id: created.id,
      message: `careful${NUL}here`,
    });

    const comments = await storage.getTaskComments(created.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.content.includes(NUL)).toBe(false);
    expect(comments[0]!.content).toContain('careful\\u0000here');
  });

  test('lazy_journal escapes NUL in the entry', async () => {
    const handlers = createAllHandlers(ctx);
    const created: any = await handlers.get('lazy_create')!({ goal: 'Journal task' });

    await handlers.get('lazy_journal')!({
      task_id: created.id,
      message: `decision${NUL}rationale`,
    });

    const entries = await storage.getTaskJournal(created.id);
    expect(entries[0]!.content.includes(NUL)).toBe(false);
    expect(entries[0]!.content).toContain('decision\\u0000rationale');
  });

  // INVARIANT: sanitization must be a no-op for ordinary arguments. If it
  // rewrote clean text, every MCP call would be silently corrupted.
  test('ordinary arguments pass through byte-for-byte', async () => {
    const handlers = createAllHandlers(ctx);
    const goal = 'Fix the off-by-one in the parser';
    const prompt = 'See line 42.\n\nUse the existing helper.\tThanks.';

    const result: any = await handlers.get('lazy_create')!({ goal, prompt });
    expect(result.goal).toBe(goal);

    const prompts = await storage.getPromptHistory(result.id);
    expect(prompts[prompts.length - 1]!.content).toBe(prompt);
  });

  // INVARIANT: the wrapper must not disturb non-string arguments (booleans,
  // numbers, arrays) — it only touches strings.
  test('non-string arguments are untouched', async () => {
    const handlers = createAllHandlers(ctx);
    await handlers.get('lazy_create')!({ goal: 'Typed args task' });

    const listed: any = await handlers.get('lazy_list')!({ all: true });
    expect(listed.count).toBe(1);
  });

  // INVARIANT: strings nested inside array arguments must be sanitized too.
  // `files` / `approved_files` elements become git argv, where a NUL is just as
  // fatal as it is in a prompt. Nested strings are NOT annotated — appending an
  // explanatory paragraph to a file path would corrupt the path.
  test('strings nested in array arguments are sanitized without annotation', async () => {
    // lazy_commit needs a task context; the path never exists, so git add fails
    // — that is fine. What matters is HOW it fails.
    const handlers = createAllHandlers({ ...ctx, taskId: 'deadbeef' });

    let err: Error | undefined;
    try {
      await handlers.get('lazy_commit')!({
        message: 'Add parser',
        files: [`src/par${NUL}ser.ts`],
      });
    } catch (e) {
      err = e as Error;
    }

    // A raw NUL would have tripped the spawn guard ("contains a NUL byte") or
    // Bun's own argv error. Instead git reports an ordinary missing pathspec,
    // proving the sanitized path is what reached argv — escaped, not annotated.
    expect(err).toBeDefined();
    expect(err!.message.includes(NUL)).toBe(false);
    expect(err!.message).not.toContain('contains a NUL byte');
    expect(err!.message).not.toContain('lazy sanitized');
    expect(err!.message).toContain('git add failed');
    expect(err!.message).toContain('par\\u0000ser.ts');
  });
});
