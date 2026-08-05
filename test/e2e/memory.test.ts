import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, fullTaskId, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readCommand, protocolDir as getProtocolDir } from '../../src/protocol';
import type { StartCommand } from '../../src/protocol';

/**
 * E2E coverage for lazy-owned shared memory: the CLI round-trip, the search
 * scope, and — the load-bearing one — that the rendered index actually reaches
 * an agent's system prompt.
 */
describe('lazy memory', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('save/list/show round-trip', async () => {
    const save = await ctx.lazy([
      'memory', 'save', 'vm-credentials-idea',
      '--type', 'project',
      '--description', 'Inject VM credentials at boot instead of baking them into images',
      '--body', 'Credentials should be injected at boot time.',
    ]);
    expectSuccess(save);
    expectOutput(save, "Saved memory record 'vm-credentials-idea' (revision 1)");

    const list = await ctx.lazy(['memory', 'list']);
    expectSuccess(list);
    expectOutput(list, 'vm-credentials-idea');
    expectOutput(list, 'Inject VM credentials at boot');

    const show = await ctx.lazy(['memory', 'show', 'vm-credentials-idea']);
    expectSuccess(show);
    expectOutput(show, 'Credentials should be injected at boot time.');
    expectOutput(show, 'revision 1');
  });

  // INVARIANT: a save under an existing name SUPERSEDES that record (same name,
  // new revision) rather than creating a near-duplicate second record.
  test('saving an existing name updates it in place', async () => {
    await ctx.lazy(['memory', 'save', 'deploy-window', '-t', 'reference', '-d', 'Deploys Tue/Thu', '-b', 'v1']);
    const update = await ctx.lazy(['memory', 'save', 'deploy-window', '-d', 'Deploys Tue/Thu 10am', '-b', 'v2']);
    expectSuccess(update);
    expectOutput(update, "Updated memory record 'deploy-window' (revision 2)");

    const list = await ctx.lazy(['memory', 'list']);
    expectOutput(list, '1 memory record(s)');
    expectOutput(list, 'Deploys Tue/Thu 10am');

    const show = await ctx.lazy(['memory', 'show', 'deploy-window']);
    expectOutput(show, 'v2');
    expectOutputExcludes(show, 'v1');
  });

  // INVARIANT: names are normalized to a kebab-case slug, so "Deploy Window"
  // and "deploy-window" are the same record, not two near-duplicates.
  test('names normalize to a kebab-case slug', async () => {
    await ctx.lazy(['memory', 'save', 'Deploy Window', '-t', 'reference', '-d', 'When deploys happen', '-b', 'Tue/Thu']);
    const show = await ctx.lazy(['memory', 'show', 'deploy-window']);
    expectSuccess(show);
    expectOutput(show, '# deploy-window');
  });

  // INVARIANT: rm is a TOMBSTONE — the record leaves the index but its
  // append-only write history survives. History is never rewritten.
  test('rm tombstones the record but preserves its history', async () => {
    await ctx.lazy(['memory', 'save', 'stale-note', '-t', 'project', '-d', 'Something outdated', '-b', 'body']);
    const rm = await ctx.lazy(['memory', 'rm', 'stale-note', '--yes']);
    expectSuccess(rm);

    const list = await ctx.lazy(['memory', 'list']);
    expectOutput(list, 'No memory records yet');

    const listAll = await ctx.lazy(['memory', 'list', '--all']);
    expectOutput(listAll, 'stale-note (deleted)');

    const history = await ctx.lazy(['memory', 'history', 'stale-note']);
    expectOutput(history, 'create');
    expectOutput(history, 'delete');
  });

  // INVARIANT: every write is attributed to an actor. CLI writes are 'human'.
  test('history records the actor for every write', async () => {
    await ctx.lazy(['memory', 'save', 'who-wrote-this', '-t', 'user', '-d', 'Attribution check', '-b', 'body']);
    const history = await ctx.lazy(['memory', 'history']);
    expectSuccess(history);
    expectOutput(history, 'by human');
  });

  test('save rejects an unknown type', async () => {
    const result = await ctx.lazy(['memory', 'save', 'bad-type', '-t', 'nonsense', '-d', 'x', '-b', 'y']);
    expectFailure(result);
    expectError(result, 'Invalid memory type');
  });

  // INVARIANT: `lazy memory save` is an AUTHORING surface — the one-line
  // description budget lives here (and on lazy_memory_save), NOT on the import
  // path, which stores harness records verbatim however long they are.
  test('save rejects a description over the authoring limit', async () => {
    const result = await ctx.lazy(['memory', 'save', 'too-wordy', '-t', 'project', '-d', 'x'.repeat(201), '-b', 'y']);
    expectFailure(result);
    expectError(result, 'maximum is 200');

    // Rejected outright — never silently truncated and saved.
    const list = await ctx.lazy(['memory', 'list']);
    expectOutputExcludes(list, 'too-wordy');
  });

  // INVARIANT: `lazy memory list` elides a long description at DISPLAY time so
  // the table stays one row per record — but that is a rendering choice only.
  // The store keeps the full text and `lazy memory show` prints it verbatim.
  // Never make list's elision a reason to shorten what is stored.
  test('list elides a long description; show returns it in full', async () => {
    const long = `Long description that ${'wraps '.repeat(28)}end`.trim();
    expect(long.length).toBeGreaterThan(150);
    const save = await ctx.lazy(['memory', 'save', 'wordy-note', '-t', 'project', '-d', long, '-b', 'body']);
    expectSuccess(save);

    const list = await ctx.lazy(['memory', 'list']);
    expectSuccess(list);
    expectOutput(list, 'wordy-note');
    expectOutput(list, 'Long description that wraps');
    expectOutput(list, '…');
    expectOutputExcludes(list, long);
    expectOutput(list, 'lazy memory show <name>');

    // The stored record is untouched — show is the full-text surface.
    const show = await ctx.lazy(['memory', 'show', 'wordy-note']);
    expectSuccess(show);
    expectOutput(show, long);
  });

  test('show reports a missing record actionably', async () => {
    const result = await ctx.lazy(['memory', 'show', 'does-not-exist']);
    expectFailure(result);
    expectError(result, 'lazy memory list');
  });

  test('in:memories search scope finds record bodies', async () => {
    await ctx.lazy([
      'memory', 'save', 'vm-credentials-idea', '-t', 'project',
      '-d', 'VM credential handling', '-b', 'Credentials are injected at boot.',
    ]);

    const result = await ctx.lazy(['search', 'in:memories "injected at boot"']);
    expectSuccess(result);
    expectOutput(result, 'vm-credentials-idea');
    expectOutput(result, 'memory');
  });

  test('--memories filters search results to memory records', async () => {
    await createTask(ctx, 'A task about credentials', 'Handle credentials');
    await ctx.lazy(['memory', 'save', 'creds-note', '-t', 'project', '-d', 'About credentials', '-b', 'credentials body']);

    const result = await ctx.lazy(['search', 'credentials', '--memories']);
    expectSuccess(result);
    expectOutput(result, 'creds-note');
    expectOutputExcludes(result, 'A task about credentials');
  });

  // INVARIANT (recall): the rendered index is auto-injected into agent launches.
  // Without this, memory exists but is never recalled — the failure mode that
  // made harness memory useless in the first place.
  test('the memory index is injected into an agent system prompt', async () => {
    await ctx.lazy([
      'memory', 'save', 'vm-credentials-idea', '-t', 'project',
      '-d', 'Inject VM credentials at boot', '-b', 'Long body that should NOT be injected.',
    ]);

    const taskId = await createTask(ctx, 'Do some work', 'Do the work');
    const start = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(start);

    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    expect(command).not.toBeNull();
    expect(command.system_prompt).toContain('Project memory (shared, curated)');
    expect(command.system_prompt).toContain('vm-credentials-idea (project) — Inject VM credentials at boot');
    // Only the index — bodies are recalled on demand, not injected wholesale.
    expect(command.system_prompt).not.toContain('Long body that should NOT be injected.');
    // And the agent is told, in the prompt too, that memory is read-only.
    expect(command.system_prompt).toContain('READ-ONLY');
  });

  // INVARIANT: with no records there is nothing to recall, so nothing is
  // injected — an empty index would be pure prompt noise.
  test('no memory section is injected when the project has no records', async () => {
    const taskId = await createTask(ctx, 'Do some work', 'Do the work');
    const start = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(start);

    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    expect(command).not.toBeNull();
    expect(command.system_prompt).not.toContain('Project memory (shared, curated)');
  });
});
