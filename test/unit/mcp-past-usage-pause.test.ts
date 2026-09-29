/**
 * `past_usage_pause` — "let this task's next turn through the usage pause" —
 * on the builder's lazy_start / lazy_unblock / lazy_resume.
 */
import { describe, test, expect } from 'bun:test';
import { toolsForRole } from '../../src/mcp/tool-surface';

describe('past_usage_pause on the MCP surface', () => {
  // INVARIANT: the builder is offered the per-task usage-pause allowance and a
  // task agent is not (engineer decision 2026-09-26: a person or the builder,
  // never a task agent). The handlers and the daemon refuse an agent anyway;
  // withholding it from the schema keeps it from being suggested at all.
  const launchTools = ['lazy_start', 'lazy_unblock', 'lazy_resume', 'lazy_review', 'lazy_ask'];
  const argOf = (role: 'builder' | 'agent', name: string) =>
    toolsForRole(role).find((t) => t.name === name)?.inputSchema.properties?.past_usage_pause;

  test('the builder sees it on every launch tool', () => {
    for (const name of launchTools) expect(argOf('builder', name)).toBeDefined();
  });

  test('a task agent sees it on none', () => {
    for (const name of launchTools) {
      expect(toolsForRole('agent').some((t) => t.name === name)).toBe(true);
      expect(argOf('agent', name)).toBeUndefined();
    }
  });
});

describe('past_usage_pause at the MCP handlers', () => {
  // INVARIANT: every launch tool's handler refuses past_usage_pause from a
  // task agent's context (a task-scoped token) before anything launches, and
  // passes it on as usagePausePastOnce from the builder's (empty taskId). The
  // daemon refuses the agent channel too; this is the door in front of it.
  test('a task agent is refused; the builder passes it on', async () => {
    const { parsePastUsagePauseArg } = await import('../../src/mcp/tools');
    const agent = { taskId: 'aaaaaaaa-0000-4000-8000-000000000001' } as never;
    const builder = { taskId: '' } as never;
    expect(() => parsePastUsagePauseArg(agent, { past_usage_pause: true })).toThrow(/never a task agent/);
    expect(parsePastUsagePauseArg(agent, {})).toEqual({});
    expect(parsePastUsagePauseArg(builder, { past_usage_pause: true })).toEqual({ usagePausePastOnce: true });
    expect(parsePastUsagePauseArg(builder, { past_usage_pause: false })).toEqual({});
    expect(() => parsePastUsagePauseArg(builder, { past_usage_pause: 'yes' })).toThrow(/expected true or false/);
  });
});
