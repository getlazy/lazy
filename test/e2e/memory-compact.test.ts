import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, fullTaskId, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readCommand, protocolDir as getProtocolDir } from '../../src/protocol';
import type { StartCommand } from '../../src/protocol';
import { createStorage, type Storage } from '../../src/storage';

/**
 * E2E coverage for `lazy memory compact` — the DERIVED compact representation of
 * shared memory used for prompt injection.
 *
 * The load-bearing invariants: the records are never modified, injection is the
 * compact PLUS live lines for anything written since it, every recompact starts
 * from the records (never from the previous compact), and the size threshold
 * only ever produces a warning.
 */
describe('lazy memory compact', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function seed(name: string, description: string, body = `Body for ${name}.`): Promise<void> {
    const r = await ctx.lazy(['memory', 'save', name, '-t', 'project', '-d', description, '-b', body]);
    expectSuccess(r);
  }

  /**
   * Seed a store big enough that MECHANICAL compaction is genuinely a win.
   *
   * Mechanical compaction only saves one `(type)` token per record, so it does
   * not pay for the compact's own explanatory preamble until the store is large
   * — and the generator now (correctly) refuses to write a compact that would
   * grow the injected context. Any test that needs a mechanical compact to exist
   * therefore needs a store where compacting genuinely helps.
   *
   * Written through the Storage interface in-process rather than through 60 CLI
   * subprocesses, which would dominate this suite's runtime.
   */
  async function seedMany(count = 60, prefix = 'store-record'): Promise<void> {
    const storage: Storage = await createStorage(ctx.root, { backend: 'external' });
    try {
      for (let i = 0; i < count; i++) {
        await storage.saveMemory({
          name: `${prefix}-number-${i}`,
          description: `A typical one-line description for record ${i} of the shared memory store.`,
          type: 'project',
          body: `Body for record ${i}.`,
        }, 'human');
      }
    } finally {
      await storage.close();
    }
  }

  test('compact generates, persists, and is inspectable', async () => {
    await seedMany();
    await seed('vm-credentials-idea', 'Inject VM credentials at boot');
    await seed('deploy-window', 'Deploys are Tue/Thu 10am');

    const compact = await ctx.lazy(['memory', 'compact', '--mechanical']);
    expectSuccess(compact);
    expectOutput(compact, 'Compacted 62 memory record(s) using mechanical compaction');
    expectOutput(compact, 'injected context:');
    expectOutput(compact, 'records themselves were not modified');
    // Progress, before the work: the human should never be left wondering what a
    // silent command is waiting on.
    expectOutput(compact, 'Compacting 62 memory record(s)');
    expectOutput(compact, 'last compact: never');

    const show = await ctx.lazy(['memory', 'compact', '--show']);
    expectSuccess(show);
    expectOutput(show, 'covering 62 record(s)');
    expectOutput(show, 'vm-credentials-idea');
    expectOutput(show, 'deploy-window');
    expectOutput(show, 'Injected context:');
    expectOutput(show, 'Every live record is covered at its current revision');

    // `memory list` says what is ACTUALLY injected, so the index listing cannot
    // be mistaken for the injected text.
    const list = await ctx.lazy(['memory', 'list']);
    expectOutput(list, 'Injected as a mechanical compact');
  });

  // INVARIANT: compaction NEVER modifies records. Curation by rewriting or
  // truncating descriptions is exactly what this feature exists to avoid — the
  // records are the source of truth.
  test('records are byte-identical before and after compaction', async () => {
    await seedMany();
    const long = 'L'.repeat(190);
    await seed('imported-note', `${long}`, 'Body stays put.');
    await seed('other-note', 'A second record');

    const before = await ctx.lazy(['memory', 'show', 'imported-note']);
    const historyBefore = await ctx.lazy(['memory', 'history']);

    expectSuccess(await ctx.lazy(['memory', 'compact', '--mechanical']));

    const after = await ctx.lazy(['memory', 'show', 'imported-note']);
    expect(after.stdout).toBe(before.stdout);
    // Compaction is not a write to the records, so it adds no history events.
    expect((await ctx.lazy(['memory', 'history'])).stdout).toBe(historyBefore.stdout);
    // Still revision 1 — no silent rewrite.
    expectOutput(after, 'revision 1');
    expectOutput(after, long);
  });

  // INVARIANT: injection = compact + live index lines for records written since
  // it. A record updated after compaction is represented by its LIVE line, which
  // supersedes whatever the compact says about it.
  test('injection is the compact plus records newer than its watermark', async () => {
    await seedMany();
    await seed('vm-credentials-idea', 'Inject VM credentials at boot');
    expectSuccess(await ctx.lazy(['memory', 'compact', '--mechanical']));

    // Written AFTER the compact: not covered by its watermark.
    await seed('deploy-window', 'Deploys are Tue/Thu 10am');

    // …and `--show` says so, so the question "is a memory I saved after
    // compacting actually injected?" is answerable without starting a task.
    const show = await ctx.lazy(['memory', 'compact', '--show']);
    expectOutput(show, 'Also injected — 1 record(s) written or updated since this compact');
    expectOutput(show, 'deploy-window');

    const taskId = await createTask(ctx, 'Do some work', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));

    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    expect(command).not.toBeNull();
    // The compact is what carries the older record …
    expect(command.system_prompt).toContain('COMPACT SUMMARY');
    expect(command.system_prompt).toContain('vm-credentials-idea');
    // … and the newer record arrives as its own live index line.
    expect(command.system_prompt).toContain('Recorded or updated since that summary');
    expect(command.system_prompt).toContain('- deploy-window (project) — Deploys are Tue/Thu 10am');
    // Names stay referenceable — the compact must never orphan a name, because
    // the name is how lazy_memory_recall finds the body.
    expect(command.system_prompt).toContain('lazy_memory_recall');
  });

  // INVARIANT: a recompact regenerates from the LIVE RECORDS, never from the
  // previous compact — no compounding lossy compression, and an updated record's
  // new description reaches the compact itself.
  test('recompact regenerates from the records, not from the previous compact', async () => {
    await seedMany();
    await seed('deploy-window', 'Deploys are Tue/Thu 10am');
    expectSuccess(await ctx.lazy(['memory', 'compact', '--mechanical']));

    // Update the record. Until a recompact, its live line supersedes the compact.
    expectSuccess(await ctx.lazy(['memory', 'save', 'deploy-window', '-d', 'Deploys moved to Wed 2pm', '-b', 'v2']));

    const staleShow = await ctx.lazy(['memory', 'compact', '--show']);
    expectOutput(staleShow, 'Deploys are Tue/Thu 10am');
    expectOutput(staleShow, 'written or updated since this compact');

    const taskId = await createTask(ctx, 'Work A', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    expect(command.system_prompt).toContain('- deploy-window (project) — Deploys moved to Wed 2pm');
    expect(command.system_prompt).toContain('they win');

    // Recompacting picks up the new description from the record itself.
    expectSuccess(await ctx.lazy(['memory', 'compact', '--mechanical']));
    const fresh = await ctx.lazy(['memory', 'compact', '--show']);
    expectOutput(fresh, 'Deploys moved to Wed 2pm');
    expectOutputExcludes(fresh, 'Deploys are Tue/Thu 10am');
    expectOutputExcludes(fresh, 'written or updated since this compact');
  });

  // A record removed after compaction must be called out, not left in the
  // summary reading as current (its recall would come back empty for no reason).
  test('a record removed after compaction is flagged in the injected context', async () => {
    await seedMany();
    await seed('keeper', 'Still true');
    await seed('doomed', 'Will be removed');
    expectSuccess(await ctx.lazy(['memory', 'compact', '--mechanical']));
    expectSuccess(await ctx.lazy(['memory', 'rm', 'doomed', '--yes']));

    const taskId = await createTask(ctx, 'Work B', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    expect(command.system_prompt).toContain('Removed since that summary');
    expect(command.system_prompt).toContain('doomed');
  });

  // INVARIANT: the size threshold produces a WARNING and nothing else. Memory
  // past it is still knowledge — never truncated, never a blocked launch.
  test('an over-threshold memory context warns but never blocks or truncates', async () => {
    // Enough records that mechanical compaction is a real win (so the compact
    // actually gets written), plus a dozen with distinctive names to prove
    // nothing is truncated.
    await seedMany();
    for (let i = 0; i < 12; i++) {
      await seed(`record-${i}`, `Fact number ${i} — ${'D'.repeat(150)}`);
    }
    // A tiny threshold makes the over-threshold path deterministic.
    await Bun.write(`${ctx.root}/lazy.toml`,
      (await Bun.file(`${ctx.root}/lazy.toml`).text()) + '\n[memory]\nwarn_bytes = 256\n');

    const taskId = await createTask(ctx, 'Work C', 'Do the work');
    const start = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    // The launch SUCCEEDS — the threshold is advisory.
    expectSuccess(start);

    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    // Nothing truncated: every record is still in the prompt.
    for (let i = 0; i < 12; i++) {
      expect(command.system_prompt).toContain(`record-${i}`);
    }

    // The launch says only that something needs attention and points at doctor:
    // one generic line, no sizes, no remedy. `lazy doctor` is the single "check
    // engine light" surface and owns the diagnosis.
    const launchOutput = start.stdout + start.stderr;
    expect(launchOutput).toContain('Run `lazy doctor` for details');
    expect(launchOutput).not.toContain('lazy memory compact');

    // The full diagnosis — actual size, threshold, compact state, remedy — lives
    // in doctor and nowhere else.
    const doctor = await ctx.lazy(['doctor']);
    expectOutput(doctor, 'Injected memory context');
    expectOutput(doctor, 'over the 256B advisory threshold');
    expectOutput(doctor, 'No compact');
    expectOutput(doctor, 'lazy memory compact');

    // The compact command reports the same numbers and says it is over.
    const compact = await ctx.lazy(['memory', 'compact', '--mechanical']);
    expectSuccess(compact);
    expectOutput(compact, 'advisory threshold 256B');
    expectOutput(compact, 'Still over the advisory threshold');

    // With a CURRENT compact that is still too big, recompacting cannot help —
    // doctor must say "curate the records", not send the human in a circle.
    const doctorAfter = await ctx.lazy(['doctor']);
    expectOutput(doctorAfter, 'compact is already current');
  });

  test('no size note when the context is comfortably under the threshold', async () => {
    await seed('small-note', 'One short fact');

    const taskId = await createTask(ctx, 'Work D', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    expect(command.system_prompt).toContain('small-note');
    expect(command.system_prompt).not.toContain('advisory threshold');
  });

  // The LLM path is the default (`auto`). The mock returns a tiny thematic
  // summary; what matters here is that it is persisted as method=llm and that
  // every record NAME survives into it.
  test('the LLM path persists a summary that still names every record', async () => {
    // A store big enough that a summary of it is a genuine saving — below that,
    // compaction is correctly refused and there is nothing to persist.
    await seedMany(20);
    await seed('vm-credentials-idea', 'Inject VM credentials at boot instead of baking them in');
    await seed('deploy-window', 'Deploys are Tue/Thu 10am, never Friday');

    const compact = await ctx.lazyMocked(['memory', 'compact'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(compact);
    expectOutput(compact, 'using llm compaction');
    // Progress before the model call — the command used to sit silent through it.
    expectOutput(compact, 'model: Claude CLI default');
    expectOutput(compact, 'waiting on the model');

    const show = await ctx.lazyMocked(['memory', 'compact', '--show'], MOCK_CLAUDE_SUCCESS);
    expectOutput(show, 'Mocked memory summary');
    expectOutput(show, 'vm-credentials-idea');
    expectOutput(show, 'deploy-window');
  });

  // REPAIR, not rejection: a name the summary skipped would be orphaned (the
  // name is the recall key), so it is appended verbatim and the operator is told.
  test('a summary that omits a name has it appended verbatim', async () => {
    // Long descriptions on the mentioned records keep the plain index bigger than
    // the repaired summary plus the compact preamble, so the "must not grow the
    // injected context" guard does not (correctly) reject the compaction and mask
    // the repair under test.
    for (let i = 0; i < 4; i++) {
      await seed(`mentioned-note-${i}`, `This one makes it into the summary — ${'M'.repeat(150)}`);
    }
    await seed('skipped-note', 'This one is omitted by the model');

    const mentioned = [0, 1, 2, 3].map(i => `\`mentioned-note-${i}\``).join(', ');
    const compact = await ctx.lazyMocked(['memory', 'compact'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_COMPACT_RESPONSE: `Summary about ${mentioned} only.` },
    });
    expectSuccess(compact);
    expectOutput(compact, 'omitted 1 record name(s)');
    expectOutput(compact, 'skipped-note');

    const show = await ctx.lazy(['memory', 'compact', '--show']);
    expectOutput(show, 'Also recorded');
    expectOutput(show, 'skipped-note (project) — This one is omitted by the model');
  });

  // Compaction is optional infrastructure: an LLM failure must degrade to the
  // mechanical generator with the reason reported, never fail the command.
  test('an LLM failure degrades to mechanical compaction with the reason reported', async () => {
    await seedMany();
    await seed('alpha-note', 'First fact');
    await seed('beta-note', 'Second fact');

    const compact = await ctx.lazyMocked(['memory', 'compact'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_COMPACT_FAIL: '1' },
    });
    expectSuccess(compact);
    expectOutput(compact, 'using mechanical compaction');
    expectOutput(compact, 'LLM compaction unavailable');

    const show = await ctx.lazy(['memory', 'compact', '--show']);
    expectOutput(show, 'alpha-note');
    expectOutput(show, 'beta-note');
  });

  // --llm is an explicit demand: it must fail loudly rather than quietly doing
  // something the operator did not ask for.
  test('--llm fails loudly when the model path is unavailable', async () => {
    await seed('alpha-note', 'First fact');
    const compact = await ctx.lazyMocked(['memory', 'compact', '--llm'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_COMPACT_FAIL: '1' },
    });
    expectFailure(compact);
  });

  test('--mechanical and --llm together is rejected', async () => {
    await seed('alpha-note', 'First fact');
    const compact = await ctx.lazy(['memory', 'compact', '--mechanical', '--llm']);
    expectFailure(compact);
  });

  // Clearing the compact is safe by construction: it is derived, so injection
  // simply falls back to the full index.
  test('--clear drops the compact and injection returns to the full index', async () => {
    await seedMany();
    await seed('vm-credentials-idea', 'Inject VM credentials at boot');
    expectSuccess(await ctx.lazy(['memory', 'compact', '--mechanical']));

    const cleared = await ctx.lazy(['memory', 'compact', '--clear']);
    expectSuccess(cleared);
    expectOutput(cleared, 'Cleared the memory compact');
    expectOutput(await ctx.lazy(['memory', 'compact', '--clear']), 'No memory compact to clear');

    const taskId = await createTask(ctx, 'Work E', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    expect(command.system_prompt).toContain('vm-credentials-idea (project) — Inject VM credentials at boot');
    expect(command.system_prompt).not.toContain('COMPACT SUMMARY');
  });

  test('compacting with no records says so and writes nothing', async () => {
    const compact = await ctx.lazy(['memory', 'compact', '--mechanical']);
    expectSuccess(compact);
    expectOutput(compact, 'No memory records to compact');
    expectOutput(await ctx.lazy(['memory', 'compact', '--show']), 'No memory compact yet');
  });

  // INVARIANT: a compact that would GROW the injected context is not a compact.
  // This shipped broken once — the guard compared the summary text against the
  // raw index and ignored the compact's own preamble, so a run that took the
  // injected context from 6.0KB to 6.4KB reported success. Injection size is the
  // only thing compaction exists to improve; growing it is a failure.
  test('compaction that would grow the injected context is rejected, not saved', async () => {
    await seed('alpha-note', 'First fact');
    await seed('beta-note', 'Second fact');

    const compact = await ctx.lazy(['memory', 'compact', '--mechanical']);
    expectFailure(compact);
    expect(compact.stderr).toContain('No compact written');
    expect(compact.stderr).toContain('without a compact:');
    expect(compact.stderr).toContain('What helps:');

    // Nothing was persisted: injection still uses the full index.
    expectOutput(await ctx.lazy(['memory', 'compact', '--show']), 'No memory compact yet');

    const taskId = await createTask(ctx, 'Work F', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    expect(command.system_prompt).toContain('- alpha-note (project) — First fact');
    expect(command.system_prompt).not.toContain('COMPACT SUMMARY');
  });

  // A rejected recompact must leave the GOOD compact that is already in place
  // alone — the failure mode to avoid is losing a working compact to a run that
  // produced something worse.
  test('a rejected recompact leaves the existing compact untouched', async () => {
    await seedMany();
    expectSuccess(await ctx.lazy(['memory', 'compact', '--mechanical']));
    const before = await ctx.lazy(['memory', 'compact', '--show']);

    // A summary that is pure bloat: bigger than the index it would replace.
    const bloat = 'X'.repeat(20000);
    const rejected = await ctx.lazyMocked(['memory', 'compact', '--llm'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_COMPACT_RESPONSE: bloat },
    });
    expectFailure(rejected);
    expect(rejected.stderr).toContain('is unchanged and still injected');

    const after = await ctx.lazy(['memory', 'compact', '--show']);
    expect(after.stdout).toBe(before.stdout);
    expect(after.stdout).not.toContain('XXXXXXXX');
  });

  // CATCH-UP: the design is "compact + everything newer than its watermark", and
  // the question this answers is the one an operator actually asks — does a
  // memory I save AFTER compacting still reach a session?
  test('a record saved after compaction is injected and shown as such', async () => {
    await seedMany();
    expectSuccess(await ctx.lazy(['memory', 'compact', '--mechanical']));

    await seed('written-after-the-compact', 'Saved once the compact already existed');

    const show = await ctx.lazy(['memory', 'compact', '--show']);
    expectOutput(show, 'Also injected — 1 record(s) written or updated since this compact');
    expectOutput(show, 'written-after-the-compact');

    const taskId = await createTask(ctx, 'Work G', 'Do the work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    const command = readCommand(getProtocolDir(await fullTaskId(ctx, taskId))) as StartCommand;
    expect(command.system_prompt).toContain(
      '- written-after-the-compact (project) — Saved once the compact already existed',
    );
    expect(command.system_prompt).toContain('COMPACT SUMMARY');
  });
});
