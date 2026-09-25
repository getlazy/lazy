/**
 * E2E tests for reactive automations (`[[automation.react]]`).
 *
 * When a turn's commits touch a configured pattern, the supervisor nudges the
 * agent once with that entry's instructions. The nudge is recorded as its own
 * discrete turn pair (supervisor prompt + agent reply) — same shape as
 * maintain / permission push-back.
 *
 * Like the maintain e2e tests, these run the MOCK supervisor
 * (test/mocks/claude.ts#launchSupervisorAsync).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS, setProtectedPatterns } from '../helpers/fixtures';
import { runReconcile } from '../helpers/reconcile';
import { readTaskStatus, readTurns } from '../helpers/storage';

/** Append [[automation.react]] config and commit it. */
function enableReact(ctx: TestContext, entries: Array<{ title: string; pattern: string; instructions: string }>): void {
  const configPath = join(ctx.root, 'lazy.toml');
  const existing = readFileSync(configPath, 'utf-8');
  const block = entries
    .map(e => `\n[[automation.react]]\ntitle = "${e.title}"\npattern = "${e.pattern}"\ninstructions = "${e.instructions}"\n`)
    .join('');
  writeFileSync(configPath, existing + block);
  ctx.git('add', 'lazy.toml');
  ctx.git('commit', '-m', 'Enable reactive automations');
}

const UI = {
  title: 'take-UI-snapshots',
  pattern: 'src/ui/**/*',
  instructions: 'Screenshot the screens you changed.',
};

describe('reactive automations', () => {
  let ctx: TestContext;
  /** Existence declares final for the NEXT mocked turn; contents are the note.
   *  The wrap-up chain (react included) runs once, on a declared-final turn
   *  (final-turn design §14 slice 3), so the match-firing tests seed the
   *  LAZY_MOCK_FINAL flag file — the mock's seam (see the wrap-up gate comment
   *  in test/mocks/claude.ts). Daemonless: per-invocation env reaches the mock. */
  let finalFlag: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    finalFlag = join(tmpdir(), `lazy-final-flag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Seed a UI file so the agent can modify an existing path.
    mkdirSync(join(ctx.root, 'src', 'ui'), { recursive: true });
    writeFileSync(join(ctx.root, 'src', 'ui', 'page.tsx'), 'export const Page = () => null;\n');
    ctx.git('add', 'src/ui/page.tsx');
    ctx.git('commit', '-m', 'Seed UI');
  });

  afterEach(async () => {
    rmSync(finalFlag, { force: true });
    await ctx.cleanup();
  });

  /** The next mocked turn declares final: write the flag before the call and
   *  pass LAZY_MOCK_FINAL in that invocation's env. */
  function seedFinal(): void {
    writeFileSync(finalFlag, '');
  }

  // INVARIANT: Touching a react pattern records a discrete nudge turn pair;
  // the work turn stays clean.
  test('records the react nudge as a discrete turn pair when a pattern is matched', async () => {
    enableReact(ctx, [UI]);
    const taskId = await createTask(ctx, 'Update the UI', 'Change the page');

    const mockFiles = JSON.stringify([
      { path: 'src/ui/page.tsx', content: 'export const Page = () => "v2";\n' },
    ]);
    seedFinal();
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: mockFiles,
          LAZY_MOCK_REACT_RESPONSE: 'Took Playwright screenshots of the updated page.',
          LAZY_MOCK_FINAL: finalFlag,
        },
      },
    );
    expectSuccess(result);
    await runReconcile(ctx.root, ctx.protocolBase);

    const turns = readTurns(ctx.root, taskId);

    const workTurn = turns.find(t => t.role === 'agent');
    expect(workTurn!.content).not.toContain('## Reactive Automation');
    expect(workTurn!.content).not.toContain('Took Playwright screenshots');

    // (A declared-final human-audience turn also runs the wrap-up's present
    // step, which materializes as a supervised pair of its own — so the pair is
    // located by the REACT nudge's heading, the human turn that carries it
    // followed by its agent reply.)
    const nudgeHuman = turns.find(t => t.turn_type === 'nudge' && String(t.content).includes('## Reactive Automation'));
    expect(nudgeHuman).toBeDefined();
    const nudgeAgent = turns[turns.indexOf(nudgeHuman!) + 1];
    expect(nudgeAgent).toBeDefined();
    expect(nudgeHuman!.role).toBe('human');
    expect(nudgeHuman!.actor).toBe('supervisor');
    expect(nudgeHuman!.content).toContain('## Reactive Automation');
    expect(nudgeHuman!.content).toContain('take-UI-snapshots');
    expect(nudgeAgent.role).toBe('agent');
    expect(nudgeAgent.content).toContain('Took Playwright screenshots of the updated page.');

    expect(turns.indexOf(workTurn!)).toBeLessThan(turns.indexOf(nudgeHuman!));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  });

  // INVARIANT: Untouched react patterns do not fire. The turn DECLARES FINAL
  // so the react step actually runs and matches nothing — without that the
  // negative would hold for the wrong reason (the step never ran at all).
  test('does not fire a follow-up when no react pattern was touched', async () => {
    enableReact(ctx, [UI]);
    const taskId = await createTask(ctx, 'Backend only', 'Change the API');
    writeFileSync(finalFlag, '');

    const mockFiles = JSON.stringify([
      { path: 'src/api.ts', content: 'export const api = 1;\n' },
    ]);
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: mockFiles,
          LAZY_MOCK_REACT_RESPONSE: 'should-not-appear',
          LAZY_MOCK_FINAL: finalFlag,
        },
      },
    );
    expectSuccess(result);
    await runReconcile(ctx.root, ctx.protocolBase);

    // Asserted by heading rather than by "no nudge turns at all": other wrap-up
    // steps (the presentation) are recorded as nudge turns too, and a blanket
    // count would fail on their presence instead of on this step's.
    expect(readTurns(ctx.root, taskId).some(
      t => String(t.content).includes('## Reactive Automation'),
    )).toBe(false);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  });

  // INVARIANT: A no-op turn never triggers reactive automations.
  test('does not fire a follow-up on a no-op turn', async () => {
    enableReact(ctx, [UI]);
    const taskId = await createTask(ctx, 'Investigate only', 'Look around, change nothing');

    writeFileSync(finalFlag, '');
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_REACT_RESPONSE: 'should-not-appear', LAZY_MOCK_FINAL: finalFlag } },
    );
    expectSuccess(result);
    await runReconcile(ctx.root, ctx.protocolBase);

    expect(readTurns(ctx.root, taskId).some(t => t.role === 'agent')).toBe(true);
    expect(readTurns(ctx.root, taskId).some(
      t => String(t.content).includes('## Reactive Automation'),
    )).toBe(false);
  });

  // INVARIANT: A react follow-up that newly touches a protected path parks the
  // task in conflict with that file pending on the react nudge turn (e587cff3).
  test('react follow-up that edits a protected file parks in conflict', async () => {
    setProtectedPatterns(ctx.root, ['*.spec.*']);
    enableReact(ctx, [UI]); // commits lazy.toml with both protected + react

    writeFileSync(join(ctx.root, 'seed.spec.ts'), 'describe("seed", () => {});\n');
    ctx.git('add', 'seed.spec.ts');
    ctx.git('commit', '-m', 'Seed protected spec');

    const taskId = await createTask(ctx, 'Update UI and maybe tests', 'Change the page');

    const workFiles = JSON.stringify([
      { path: 'src/ui/page.tsx', content: 'export const Page = () => "v2";\n' },
    ]);
    // React follow-up commits into a protected path — must land as conflict.
    const reactFiles = JSON.stringify([
      { path: 'seed.spec.ts', content: 'describe("seed", () => { /* react edited */ });\n' },
    ]);
    seedFinal();
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: workFiles,
          LAZY_MOCK_REACT_FILES: reactFiles,
          LAZY_MOCK_REACT_RESPONSE: 'Took screenshots; also tweaked the seed spec.',
          LAZY_MOCK_FINAL: finalFlag,
        },
      },
    );
    expectSuccess(result);
    await runReconcile(ctx.root, ctx.protocolBase);

    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');
    const turns = readTurns(ctx.root, taskId);
    const reactAgent = [...turns].reverse().find(
      t => t.role === 'agent' && t.turn_type === 'nudge' && t.violations && t.violations.length > 0,
    );
    expect(reactAgent).toBeDefined();
    expect(reactAgent!.violations!.some(v => v.file === 'seed.spec.ts' && v.status === 'pending')).toBe(true);
  });
});
