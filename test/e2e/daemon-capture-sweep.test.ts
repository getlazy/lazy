/**
 * e2e: the daemon's live conversation capture sweep.
 *
 * INVARIANT: a Claude session JSONL for this project that appears on disk must
 * reach the conversation store WITHOUT anyone running
 * `lazy doctor --reimport-conversations`. Lazy runs `claude -p` on the host for
 * fidelity summaries, `lazy report`, and memory compaction; those sessions never
 * enter a builder container, so the daemon sweep is their ONLY capture path.
 * When it rots, the symptom is silent: a reimport months later turns up
 * same-day conversations nobody noticed were missing.
 *
 * The sweep is off under LAZY_TEST by default (it would race the reimport
 * suites), so this test arms it with the LAZY_FORCE_CAPTURE_SWEEP hatch.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { markMachineOneshotPrompt } from '../../src/import/machine-oneshot';

async function seedIsolationSession(
  root: string,
  builderId: string,
  sessionId: string,
  /**
   * Write it as one of lazy's own machine-generated `claude -p` housekeeping
   * runs by stamping the prompt exactly as runClaudeOneshot does.
   */
  opts: { machineOneshot?: boolean } = {},
): Promise<void> {
  const dir = join(root, '.lazy', 'builder-projects', builderId, encodeProjectPath(root));
  await mkdir(dir, { recursive: true });
  const prompt = 'Summarise this diff';
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: `${sessionId}-u0`,
      parentUuid: null,
      timestamp: '2026-07-29T10:00:00Z',
      sessionId,
      cwd: root,
      version: '1.0.0',
      gitBranch: 'main',
      message: {
        role: 'user',
        content: opts.machineOneshot ? markMachineOneshotPrompt(prompt) : prompt,
      },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: `${sessionId}-a0`,
      parentUuid: `${sessionId}-u0`,
      timestamp: '2026-07-29T10:00:05Z',
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'It renames a thing.' }],
        model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  ];
  await writeFile(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf-8');
}

describe('daemon conversation capture sweep', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_FORCE_CAPTURE_SWEEP: '1' },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('captures a session that appears on disk, with no manual reimport', async () => {
    const sessionId = 'abcd1234-1111-2222-3333-444444444444';
    await seedIsolationSession(ctx.root, 'builderA', sessionId);

    const deadline = Date.now() + 20_000;
    let captured = false;
    while (Date.now() < deadline) {
      const list = await ctx.lazy(['builder', 'list']);
      if (list.stdout.includes('abcd1234')) {
        captured = true;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    expect(captured).toBe(true);

    // Doctor agrees: nothing is stranded on disk anymore.
    const doctor = await ctx.lazy(['doctor']);
    expect(doctor.stdout).toContain('All conversations captured');
  }, 45_000);

  /**
   * INVARIANT: the sweep must never capture lazy's own housekeeping runs. Every
   * accept writes a fidelity-summary `claude -p` session into the same dirs the
   * sweep watches; capturing those made them ~83% of the store and buried real
   * conversations in `lazy builder list` and search.
   *
   * The negative is asserted by waiting for the REAL session — seeded at the same
   * time — to land. Once the sweep has demonstrably run and stored that one, the
   * one-shot's continued absence is a verdict, not a race.
   */
  test('never captures a machine-generated one-shot', async () => {
    const oneshot = 'f00d0000-1111-2222-3333-444444444444';
    const real = 'beef0000-1111-2222-3333-444444444444';
    await seedIsolationSession(ctx.root, 'builderA', oneshot, { machineOneshot: true });
    await seedIsolationSession(ctx.root, 'builderA', real);

    const deadline = Date.now() + 20_000;
    let list = await ctx.lazy(['builder', 'list']);
    while (Date.now() < deadline && !list.stdout.includes('beef0000')) {
      await new Promise(r => setTimeout(r, 500));
      list = await ctx.lazy(['builder', 'list']);
    }
    expect(list.stdout).toContain('beef0000');
    expect(list.stdout).not.toContain('f00d0000');
    expect(list.stdout).toContain('1 captured conversation(s)');

    // And the skipped one-shot must not read as capture rot.
    const doctor = await ctx.lazy(['doctor']);
    expect(doctor.stdout).toContain('All conversations captured');
  }, 45_000);
});
