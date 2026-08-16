/**
 * INVARIANT: every agent-facing MCP tool is classified read or write in
 * src/mcp/tool-access.ts.
 *
 * That table decides which tools survive a read-only (ask) turn and which are
 * pre-approved for the builder. An unclassified tool would fail closed — it
 * would simply vanish from ask turns with no error anywhere — so drift must be
 * a failing test, not a silent behavior change. Adding a tool means classifying
 * it; the author is the one who knows whether it mutates anything.
 */

import { describe, test, expect } from 'bun:test';
import { allTools } from '../../src/mcp/tools';
import { TOOL_ACCESS, READ_ONLY_TOOL_NAMES, isReadOnlyTool } from '../../src/mcp/tool-access';

describe('MCP tool access classification', () => {
  test('classifies exactly the tools the server serves', () => {
    const served = allTools.map(t => t.name).sort();
    const classified = Object.keys(TOOL_ACCESS).sort();

    const unclassified = served.filter(n => !(n in TOOL_ACCESS));
    const stale = classified.filter(n => !served.includes(n));

    expect(unclassified).toEqual([]);
    expect(stale).toEqual([]);
    expect(classified).toEqual(served);
  });

  test('READ_ONLY_TOOL_NAMES holds every read and no write', () => {
    for (const name of READ_ONLY_TOOL_NAMES) {
      expect(TOOL_ACCESS[name]).toBe('read');
    }
    const reads = Object.entries(TOOL_ACCESS).filter(([, a]) => a === 'read').map(([n]) => n);
    expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual(reads.sort());
  });

  test('an unknown tool is not read-only — the classification fails closed', () => {
    expect(isReadOnlyTool('lazy_not_a_tool')).toBe(false);
    expect(isReadOnlyTool('')).toBe(false);
  });

  test('the obvious mutators are writes', () => {
    // Spot-check the ones a careless edit would most plausibly get wrong.
    // lazy_ask launches an agent turn on another task; lazy_wait only polls.
    expect(isReadOnlyTool('lazy_ask')).toBe(false);
    expect(isReadOnlyTool('lazy_commit')).toBe(false);
    expect(isReadOnlyTool('lazy_comment')).toBe(false);
    expect(isReadOnlyTool('lazy_journal')).toBe(false);
    expect(isReadOnlyTool('lazy_memory_save')).toBe(false);
    expect(isReadOnlyTool('lazy_wait')).toBe(true);
    expect(isReadOnlyTool('lazy_show')).toBe(true);
  });
});
