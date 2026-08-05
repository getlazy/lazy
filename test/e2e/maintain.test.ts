/**
 * E2E tests for maintained-files automation (the inverse of protected files).
 *
 * When a turn touches none of a maintained group's files, the supervisor nudges
 * the agent once ("you didn't update <title> — are you sure?"). The nudge is
 * recorded as its OWN discrete turn pair (a system human turn carrying the
 * prompt + an agent turn carrying the reply) — NOT appended to the work turn —
 * so a reviewer can tell a deliberate skip from a silent omission.
 *
 * Like the permissions e2e tests, these run the MOCK supervisor
 * (test/mocks/claude.ts#launchSupervisorAsync), which mirrors the real
 * supervisor's maintain check.
 *
 * Harness notes: this suite is daemonless, so every followed turn is a two-step
 * dance.
 *  - `--follow` makes `lazy start` WAIT for the mock supervisor to write
 *    response.json instead of returning the moment the agent launches.
 *  - `runReconcile` then processes that response (records the work turn and the
 *    nudge turn pair, sets the status). Post-v0.11 only the daemon's reconcile
 *    loop does this — `--follow` no longer reconciles on the way out, so without
 *    the explicit pass no agent turn or nudge is ever recorded.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { runReconcile } from '../helpers/reconcile';
import { readTaskStatus, readTurns } from '../helpers/storage';

/** The first (work) agent turn's content — the clean task summary. */
function readAgentTurnContent(root: string, shortId: string): string {
  const agentTurn = readTurns(root, shortId).find(t => t.role === 'agent');
  if (!agentTurn) throw new Error('No agent turn recorded');
  return agentTurn.content;
}

/** Append [[automation.maintain]] config and commit it. */
function enableMaintain(ctx: TestContext, entries: Array<{ title: string; pattern: string; instructions: string }>): void {
  const configPath = join(ctx.root, 'lazy.toml');
  const existing = readFileSync(configPath, 'utf-8');
  const block = entries
    .map(e => `\n[[automation.maintain]]\ntitle = "${e.title}"\npattern = "${e.pattern}"\ninstructions = "${e.instructions}"\n`)
    .join('');
  writeFileSync(configPath, existing + block);
  ctx.git('add', 'lazy.toml');
  ctx.git('commit', '-m', 'Enable maintained files');
}

const DOCS = { title: 'docs', pattern: 'docs/**/*', instructions: 'Update affected docs.' };
const CHANGELOG = { title: 'changelog', pattern: 'CHANGELOG.md', instructions: 'Add a changelog line.' };

describe('maintained files automation', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    // ctx.cleanup() removes the external storage dir too (see setup.ts).
    await ctx.cleanup();
  });

  // INVARIANT: A turn that touches none of a maintained group's files triggers a
  // one-shot follow-up recorded as its OWN nudge turn pair — the work turn stays
  // clean (no appended review text). This is the whole point of the feature:
  // the nudge must not pollute/garble the work response.
  test('records the nudge as a discrete turn pair, leaving the work turn clean', async () => {
    enableMaintain(ctx, [DOCS, CHANGELOG]);
    const taskId = await createTask(ctx, 'Add a feature', 'Implement the feature');

    // Agent only touches source code — neither docs/ nor CHANGELOG.md.
    const mockFiles = JSON.stringify([{ path: 'src/feature.ts', content: 'export const f = 1;\n' }]);
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: mockFiles,
          LAZY_MOCK_MAINTAIN_RESPONSE: 'Intra-release change; no docs or CHANGELOG update needed.',
        },
      },
    );
    expectSuccess(result);
    await runReconcile(ctx.root, ctx.protocolBase);

    const turns = readTurns(ctx.root, taskId);

    // The work (first agent) turn is CLEAN — the review is not concatenated in.
    const workTurn = turns.find(t => t.role === 'agent');
    expect(workTurn!.content).not.toContain('## Maintained Files Review');
    expect(workTurn!.content).not.toContain('Intra-release change; no docs or CHANGELOG update needed.');

    // The nudge is recorded as its own discrete turn pair, authored by the SUPERVISOR.
    const nudgeTurns = turns.filter(t => t.turn_type === 'nudge');
    expect(nudgeTurns).toHaveLength(2);
    const [nudgeHuman, nudgeAgent] = nudgeTurns;
    expect(nudgeHuman.role).toBe('human');
    expect(nudgeHuman.actor).toBe('supervisor'); // not 'human' / 'system'
    expect(nudgeHuman.content).toContain('## Maintained Files Review');
    expect(nudgeHuman.content).toContain('docs');
    expect(nudgeHuman.content).toContain('changelog');
    expect(nudgeAgent.role).toBe('agent');
    expect(nudgeAgent.content).toContain('Intra-release change; no docs or CHANGELOG update needed.');
    // The supervised reply carries its OWN usage, incl. cache tokens (not zero).
    expect(nudgeAgent.usage?.cacheCreationTokens).toBeGreaterThan(0);
    expect(nudgeAgent.usage?.cacheReadTokens).toBeGreaterThan(0);

    // The nudge turn pair comes AFTER the work turn (work → nudge → nudge reply).
    expect(turns.indexOf(workTurn!)).toBeLessThan(turns.indexOf(nudgeHuman));

    // Maintain is a nudge, not a gate — task still blocks normally (not conflict).
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  });

  // INVARIANT: When the turn touches a maintained group's files, no follow-up fires.
  test('does not fire a follow-up when a maintained file was updated', async () => {
    enableMaintain(ctx, [DOCS]);
    const taskId = await createTask(ctx, 'Update docs too', 'Implement and document');

    // Agent touches docs/ — the maintained group is satisfied.
    const mockFiles = JSON.stringify([
      { path: 'src/feature.ts', content: 'export const f = 1;\n' },
      { path: 'docs/feature.md', content: '# Feature\n' },
    ]);
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: mockFiles,
          LAZY_MOCK_MAINTAIN_RESPONSE: 'should-not-appear',
        },
      },
    );
    expectSuccess(result);
    await runReconcile(ctx.root, ctx.protocolBase);

    const content = readAgentTurnContent(ctx.root, taskId);
    expect(content).not.toContain('should-not-appear');
    // No nudge fired → no nudge turns.
    expect(readTurns(ctx.root, taskId).some(t => t.turn_type === 'nudge')).toBe(false);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  });

  // INVARIANT: A no-op turn (no code changes at all) is never nagged about docs.
  test('does not fire a follow-up on a no-op turn', async () => {
    enableMaintain(ctx, [DOCS, CHANGELOG]);
    const taskId = await createTask(ctx, 'Investigate only', 'Look around, change nothing');

    // No LAZY_MOCK_SHOULD_COMMIT and no files → the mock agent makes zero changes.
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_MAINTAIN_RESPONSE: 'should-not-appear' } },
    );
    expectSuccess(result);
    await runReconcile(ctx.root, ctx.protocolBase);

    // The work turn IS recorded — otherwise the nudge assertion below would pass
    // vacuously on an empty turn list.
    expect(readTurns(ctx.root, taskId).some(t => t.role === 'agent')).toBe(true);
    // No-op turn → no nudge turns at all.
    expect(readTurns(ctx.root, taskId).some(t => t.turn_type === 'nudge')).toBe(false);
  });

  // INVARIANT (maintain-nudge-violation-precedence): the maintain nudge fires AFTER
  // the push-back exchange and is INDEPENDENT of its outcome. When a turn both
  // violates a protected file and skips a maintained one, BOTH nudge pairs are
  // recorded — push-back first, maintain second — and push-back never re-runs.
  // (lazy.toml is itself a protected file, so gating maintain on a clean violation
  // set would make the feature inert on any turn that edits a protected file.)
  //
  // Branch (b): the agent CONFIRMED/kept the violation → task still goes to conflict
  // (the push-back response carries the final violation set; the maintain response
  // carries none), but the maintain nudge still fired.
  test('fires the maintain nudge after push-back even when violations remain', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, readFileSync(configPath, 'utf-8') + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Protected spec files');
    enableMaintain(ctx, [DOCS]);

    // Pre-existing protected file the agent will modify.
    writeFileSync(join(ctx.root, 'unit.spec.ts'), 'describe("x", () => {});\n');
    ctx.git('add', 'unit.spec.ts');
    ctx.git('commit', '-m', 'Add spec');

    const taskId = await createTask(ctx, 'Fix a bug', 'Fix it');

    // Agent modifies the protected file (a violation) and touches no docs. No revert
    // → the violation stands.
    const mockFiles = JSON.stringify([{ path: 'unit.spec.ts', content: 'describe("modified", () => {});\n' }]);
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: mockFiles,
          LAZY_MOCK_PUSHBACK_RESPONSE: 'Intentional — keeping the spec change.',
          LAZY_MOCK_MAINTAIN_RESPONSE: 'No docs update needed.',
        },
      },
    );
    expectSuccess(result);
    await runReconcile(ctx.root, ctx.protocolBase);

    // Violation kept → conflict (the push-back response carries the final set).
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');
    const turns = readTurns(ctx.root, taskId);
    const pushbackIdx = turns.findIndex(t => t.turn_type === 'nudge' && t.content.includes('## Permission Violation Review'));
    const maintainIdx = turns.findIndex(t => t.content.includes('## Maintained Files Review'));
    // BOTH nudges fired, push-back BEFORE maintain.
    expect(pushbackIdx).toBeGreaterThanOrEqual(0);
    expect(maintainIdx).toBeGreaterThan(pushbackIdx);
    // Exactly one push-back human-nudge turn — no second round.
    expect(turns.filter(t => t.turn_type === 'nudge' && t.content.includes('## Permission Violation Review'))).toHaveLength(1);
    // The maintain reply is recorded (not suppressed).
    expect(turns.some(t => t.content.includes('No docs update needed.'))).toBe(true);
  });

  // Branch (a): the agent RESOLVED the violation during push-back → the final set is
  // empty so the task blocks normally, AND the maintain nudge still fires afterwards.
  test('fires the maintain nudge after push-back even when the agent resolved violations', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, readFileSync(configPath, 'utf-8') + '\n[permissions]\nprotected = ["*.spec.*"]\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Protected spec files');
    enableMaintain(ctx, [DOCS]);

    writeFileSync(join(ctx.root, 'unit.spec.ts'), 'describe("x", () => {});\n');
    ctx.git('add', 'unit.spec.ts');
    ctx.git('commit', '-m', 'Add spec');

    const taskId = await createTask(ctx, 'Fix a bug', 'Fix it');

    // Modify the protected file (violation) AND a plain file, so a net non-maintained
    // change survives the revert and the docs group is still "skipped".
    const mockFiles = JSON.stringify([
      { path: 'unit.spec.ts', content: 'describe("modified", () => {});\n' },
      { path: 'src/feature.ts', content: 'export const f = 1;\n' },
    ]);
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: mockFiles,
          // Push-back reverts the protected file → final violation set is empty.
          LAZY_MOCK_PUSHBACK_REVERTS: JSON.stringify(['unit.spec.ts']),
          LAZY_MOCK_PUSHBACK_RESPONSE: 'Reverted the spec file.',
          LAZY_MOCK_MAINTAIN_RESPONSE: 'No docs update needed.',
        },
      },
    );
    expectSuccess(result);
    await runReconcile(ctx.root, ctx.protocolBase);

    // Violation resolved → blocked, not conflict. Maintain still fires.
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    const turns = readTurns(ctx.root, taskId);
    const pushbackIdx = turns.findIndex(t => t.turn_type === 'nudge' && t.content.includes('## Permission Violation Review'));
    const maintainIdx = turns.findIndex(t => t.content.includes('## Maintained Files Review'));
    expect(pushbackIdx).toBeGreaterThanOrEqual(0);
    expect(maintainIdx).toBeGreaterThan(pushbackIdx);
    expect(turns.filter(t => t.turn_type === 'nudge' && t.content.includes('## Permission Violation Review'))).toHaveLength(1);
    expect(turns.some(t => t.content.includes('No docs update needed.'))).toBe(true);
  });
});
