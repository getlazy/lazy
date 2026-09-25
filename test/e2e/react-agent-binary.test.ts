/**
 * Fake-binary e2e: reactive automation through the REAL supervisor.
 *
 * The module-mock suite (test/e2e/react.test.ts) mirrors the check in
 * test/mocks/claude.ts. This file is the production path: daemon → real
 * `lazy supervise` → fake `claude` on PATH, so runReactFollowup wiring in
 * src/supervisor/index.ts is actually exercised.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario, sessionStartEvent, resultEvent, type ClaudeScenario } from '../helpers/fake-claude';
import { agentTurns } from '../helpers/agent-seam';
import { worktreePathFor, readTurns, findFullTaskId } from '../helpers/storage';
import { sandboxSuiteSkipped } from '../helpers/sandbox-deps';
import { protocolDir as getProtocolDir } from '../../src/protocol';
import { PRESENTATION_MARKER_FILE } from '../../src/protocol/presentation-marker';

/**
 * The agent invocations belonging to the WORK TURN — its own invocation plus
 * its wrap-up steps — with the auto-review's excluded.
 *
 * The review is a separate turn the daemon starts once the final settles, and
 * whether its invocation has landed by the time the assertions run is a race:
 * the shorter the wrap-up, the likelier it has. Counting it would make "the
 * wrap-up ran these steps and no more" depend on that timing, so it is filtered
 * out by its prompt rather than being tolerated in the count.
 */
function workTurnInvocations(invocations: Array<{ argv: string[] }>): Array<{ argv: string[] }> {
  return invocations.filter(i => {
    if (!i.argv.includes('-p')) return false;
    const prompt = String(i.argv[1] ?? '');
    return !prompt.includes('Audience: a reviewer') && !prompt.includes('its verdict could not be read');
  });
}

/** Append [[automation.react]] and commit so the worktree branch carries it. */
async function enableReact(
  ctx: TestContext,
  entry: { title: string; pattern: string; instructions: string },
): Promise<void> {
  const configPath = join(ctx.root, 'lazy.toml');
  const existing = await readFile(configPath, 'utf-8');
  await writeFile(
    configPath,
    `${existing}\n[[automation.react]]\ntitle = "${entry.title}"\npattern = "${entry.pattern}"\ninstructions = "${entry.instructions}"\n`,
  );
  ctx.git('add', 'lazy.toml');
  const commit = ctx.git('commit', '-m', 'Enable reactive automation');
  if (commit.exitCode !== 0) {
    throw new Error(`Failed to commit react config: ${commit.stderr}`);
  }
}

describe('reactive automation (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    await mkdir(join(ctx.root, 'src', 'ui'), { recursive: true });
    await writeFile(join(ctx.root, 'src', 'ui', 'page.tsx'), 'export const Page = () => null;\n');
    ctx.git('add', 'src/ui/page.tsx');
    ctx.git('commit', '-m', 'Seed UI');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: touching a react pattern through the real supervisor records a
  // discrete Reactive Automation nudge turn pair (not just the mock path).
  test('real supervisor fires a react follow-up when a matched path is committed', async () => {
    await enableReact(ctx, {
      title: 'take-UI-snapshots',
      pattern: 'src/ui/**/*',
      instructions: 'Screenshot the screens you changed.',
    });
    const taskId = await createTask(ctx, 'Update the UI', 'Change the page');

    // Invocation 0 = work (commits the UI change and declares final via the
    // handoff file — the fake agent has no MCP tools, so the handoff is its
    // pencils-down channel); invocation 1 = the react wrap-up step; invocation
    // 2 = the wrap-up's present step (human-audience plan).
    // The present invocation declares by writing the marker itself — where the
    // daemon-side lazy_report echo leaves it — because the executor clears the
    // marker before that invocation and refuses to complete without one (§6.2).
    const worktree = worktreePathFor(ctx.root, taskId);
    const handoffPath = join(worktree, '.lazy-task-sandbox', 'turn-handoff.jsonl');
    const declaredWork: ClaudeScenario = {
      steps: [
        { kind: 'emit', event: sessionStartEvent('fake-sess-react-work') },
        {
          kind: 'commit',
          message: 'Update UI page',
          files: [{ path: 'src/ui/page.tsx', content: 'export const Page = () => "v2";\n' }],
        },
        { kind: 'write-file', path: handoffPath, content: JSON.stringify({ kind: 'final', content: 'Pencils down.' }) + '\n' },
        { kind: 'emit', event: resultEvent({ result: 'Updated the page component.', sessionId: 'fake-sess-react-work' }) },
      ],
    };
    await ctx.setClaudeScenario({
      sequence: [
        declaredWork,
        successScenario({
          result: 'Took Playwright screenshots of the updated page.',
          sessionId: 'fake-sess-react-work',
        }),
        {
          steps: [
            ...successScenario({
              result: 'Authored the walkthrough and re-sent the report with its presentation groups.',
              sessionId: 'fake-sess-present',
            }).steps!,
            // The declaration the present step requires — written by the
            // invocation itself, where the daemon-side lazy_report echo leaves
            // it (the executor clears the marker before this invocation).
            { kind: 'write-file', path: join(getProtocolDir(findFullTaskId(ctx.root, taskId)), PRESENTATION_MARKER_FILE), content: JSON.stringify({ version: 1, declared_at: new Date().toISOString() }) },
          ],
        },
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turns = readTurns(ctx.root, taskId);
    const nudgeHuman = turns.find(
      t => t.turn_type === 'nudge' && t.role === 'human' && String(t.content).includes('## Reactive Automation'),
    );
    expect(nudgeHuman).toBeDefined();
    expect(nudgeHuman!.actor).toBe('supervisor');
    expect(String(nudgeHuman!.content)).toContain('take-UI-snapshots');

    const agents = await agentTurns(ctx.root, taskId);
    const nudgeReply = agents.find(t => t.turn_type === 'nudge');
    expect(nudgeReply).toBeDefined();
    expect(String(nudgeReply!.content)).toContain('Took Playwright screenshots');

    // Three invocations: the declared-final work turn and its two wrap-up steps
    // (react, present — plan order). The wrap-up chain replaces the per-turn
    // §2.4 nudge for a declared-final turn, so no "Final or Needs-Input?" ask
    // happens. React still fires exactly once; the present invocation is the
    // plan's own last step for a human-audience task, asserted to exist (not
    // skipped, not looped) by the count.
    const invocations = workTurnInvocations(await ctx.claudeInvocations());
    expect(invocations.length).toBe(3);
    // Plan order: react (nudge chain) before the presentation step.
    expect(String(invocations[1].argv[1])).toContain('reactive automation group(s)');
    expect(invocations[2].argv[1]).toContain('presentation.groups');
    // INVARIANT: nothing asks the agent about the PROJECT any more — the
    // systemic check was removed from the wrap-up.
    expect(invocations.some(i => String(i.argv[1]).includes('Anything systemic?'))).toBe(false);
  }, 180_000);

  // INVARIANT: untouched react patterns do not fire on the real supervisor path.
  test('real supervisor does not fire react when no pattern was touched', async () => {
    await enableReact(ctx, {
      title: 'take-UI-snapshots',
      pattern: 'src/ui/**/*',
      instructions: 'Screenshot the screens you changed.',
    });
    const taskId = await createTask(ctx, 'Backend only', 'Change the API');

    await ctx.setClaudeScenario(successScenario({
      result: 'API updated.',
      sessionId: 'fake-sess-react-skip',
      commit: {
        message: 'API change',
        files: [{ path: 'src/api.ts', content: 'export const api = 1;\n' }],
      },
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turns = readTurns(ctx.root, taskId);
    expect(turns.some(t => String(t.content).includes('## Reactive Automation'))).toBe(false);
    // Work + the final nudge, and nothing else: the undeclared turn is asked
    // once where it stands (§2.4), but react did not fire — which is what the
    // absence of the heading above already says and this count corroborates.
    const invocations = (await ctx.claudeInvocations()).filter(i => i.argv.includes('-p'));
    expect(invocations.length).toBe(2);
  }, 180_000);
});

// INVARIANT (host-sandbox + react): the follow-up that is meant for Playwright /
// demo work must receive the same OS-sandbox --settings as the work turn.
// Without this, agent_extra_args can be dropped on runReactFollowup while work
// still looks sandboxed.
describe.skipIf(sandboxSuiteSkipped('react follow-up host sandbox'))(
  'reactive automation follow-up under host OS sandbox',
  () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = await setupTestLazy({ fakeClaude: true, hostPermissionMode: 'sandbox' });
      await mkdir(join(ctx.root, 'src', 'ui'), { recursive: true });
      await writeFile(join(ctx.root, 'src', 'ui', 'page.tsx'), 'export const Page = () => null;\n');
      ctx.git('add', 'src/ui/page.tsx');
      ctx.git('commit', '-m', 'Seed UI');
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    test('react follow-up argv carries the same --settings as the work turn', async () => {
      await enableReact(ctx, {
        title: 'take-UI-snapshots',
        pattern: 'src/ui/**/*',
        instructions: 'Screenshot the screens you changed.',
      });
      const taskId = await createTask(ctx, 'Sandboxed UI update', 'Change the page');

      // Invocation 0 declares final via the handoff file (see the first test in
      // this file for why); invocation 1 is the react wrap-up step; invocation
      // 2 is the wrap-up's present step (human-audience plan), declaring via
      // the marker file it is required to write (§6.2).
      const worktree = worktreePathFor(ctx.root, taskId);
      const handoffPath = join(worktree, '.lazy-task-sandbox', 'turn-handoff.jsonl');
      const declaredWork: ClaudeScenario = {
        steps: [
          { kind: 'emit', event: sessionStartEvent('fake-sess-react-sandbox') },
          {
            kind: 'commit',
            message: 'Update UI page',
            files: [{ path: 'src/ui/page.tsx', content: 'export const Page = () => "v2";\n' }],
          },
          { kind: 'write-file', path: handoffPath, content: JSON.stringify({ kind: 'final', content: 'Pencils down.' }) + '\n' },
          { kind: 'emit', event: resultEvent({ result: 'Updated the page under sandbox.', sessionId: 'fake-sess-react-sandbox' }) },
        ],
      };
      await ctx.setClaudeScenario({
        sequence: [
          declaredWork,
          successScenario({
            result: 'Took screenshots under sandbox.',
            sessionId: 'fake-sess-react-sandbox',
          }),
          {
            steps: [
              ...successScenario({
                result: 'Authored the walkthrough under sandbox.',
                sessionId: 'fake-sess-present',
              }).steps!,
              { kind: 'write-file', path: join(getProtocolDir(findFullTaskId(ctx.root, taskId)), PRESENTATION_MARKER_FILE), content: JSON.stringify({ version: 1, declared_at: new Date().toISOString() }) },
            ],
          },
        ],
      });

      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
      expectSuccess(await ctx.lazy(['wait', taskId]));

      // Work + the two wrap-up steps (react, present — plan order): the
      // declared-final turn runs the wrap-up chain instead of the §2.4 nudge,
      // so there is no further ask. Every one of them is an agent invocation on
      // this task, so every one must carry the sandbox settings — which is the
      // point of the loop below.
      const invocations = workTurnInvocations(await ctx.claudeInvocations());
      expect(invocations.length).toBe(3);

      for (const inv of invocations) {
        const settingsIndex = inv.argv.indexOf('--settings');
        expect(settingsIndex).toBeGreaterThanOrEqual(0);
        const settings = JSON.parse(inv.argv[settingsIndex + 1]) as {
          sandbox: { enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean };
        };
        expect(settings.sandbox.enabled).toBe(true);
        expect(settings.sandbox.failIfUnavailable).toBe(true);
        expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
      }
    }, 180_000);
  },
);
