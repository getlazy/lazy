/**
 * INVARIANT (cursor-first-class-agent §1): every supervisor handler that runs
 * the COMMAND's agent verifies that agent's binary exists first.
 *
 * The startup tool checks cannot do this — they run before any command has
 * been read, on a runner built by createRunnerFromType with no agent set, so
 * they only cover the base environment. A cursor task on a custom-Dockerfile
 * image without cursor-agent sailed past them and crash-looped in the work
 * phase ("spawn failed: binary 'cursor-agent' not found", classified unknown)
 * for a whole session. The per-command check turns that into one actionable
 * turn failure.
 *
 * Same source-text coverage pattern as test/unit/supervisor-mcp-setup.test.ts:
 * a new agent-running handler that forgets the call would fail silently, and
 * only in environments whose image lacks the agent.
 *
 * What is checked is the HARNESS, not `cmd.agent_id`: since agent profiles,
 * `agent_id` carries a PROFILE name (`local-ollama-pi`), and there is no binary
 * by that name — `commandHarness(cmd)` resolves the profile to the registered
 * implementation whose binary the image must actually contain.
 */
import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

describe('supervisor agent-binary coverage', () => {
  test('every handler that runs the command agent checks its binary first', async () => {
    const source = await readFile(
      join(import.meta.dir, '..', '..', 'src', 'supervisor', 'index.ts'),
      'utf-8',
    );

    // handleSyncCommand is deliberately absent: its conflict-resolution turn
    // always runs Claude Code (src/supervisor/merge.ts), whatever the task's
    // agent, and claude is in every base image.
    const handlers = ['handleTurnCommand', 'handleAskCommand'];
    const allHandlers = [...handlers, 'handleSyncCommand'];

    for (const name of handlers) {
      const start = source.indexOf(`async function ${name}(`);
      expect(start, `${name} not found — rename it here too`).toBeGreaterThan(-1);
      const next = allHandlers
        .map(h => source.indexOf(`async function ${h}(`))
        .filter(idx => idx > start);
      const end = next.length ? Math.min(...next) : source.length;
      const body = source.slice(start, end);
      expect(
        body.includes('await checkCommandAgentBinary(harness)'),
        `${name} must call checkCommandAgentBinary before running the agent`,
      ).toBe(true);
      // ...and on the harness it is about to RUN, resolved from the command,
      // rather than on a name that happens to be in scope.
      expect(
        body.includes('const harness = commandHarness(cmd)'),
        `${name} must resolve the harness from the command`,
      ).toBe(true);
    }
  });
});
