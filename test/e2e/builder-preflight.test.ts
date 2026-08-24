/**
 * Symptom-1 guardrail: the loud-failure preflight for a broken lazy-agent binary.
 *
 * When the wrong file is mounted at /usr/local/bin/lazy-agent (bare Bun, a stale
 * build, or a text placeholder), Claude Code's MCP child (`lazy-agent mcp …`)
 * exits immediately and the builder silently loses every lazy_* tool — the only
 * signal is an opaque "Failed to reconnect to lazy: -32000" in Claude's logs.
 *
 * Two mechanisms make that failure loud:
 *   1. `lazy-agent selfcheck` prints a stable sentinel identifying the real agent.
 *      A bare Bun binary prints its own version / errors "Script not found".
 *   2. The builder supervisor runs the preflight before launching Claude Code and
 *      throws an actionable error instead of handing off into a silent -32000.
 */

import { describe, test, expect } from 'bun:test';
import { resolve } from 'path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { preflightAgentBinary } from '../../src/supervisor/builder';

const AGENT_ENTRY = resolve(__dirname, '../../src/agent-entry.ts');

describe('agent-entry selfcheck sentinel', () => {
  // INVARIANT: `selfcheck` prints the 'lazy-agent ok' sentinel and exits 0. This
  // is what the builder preflight matches on to distinguish the real compiled
  // agent from a bare Bun binary. Changing the sentinel breaks the preflight.
  test('selfcheck prints the sentinel and exits 0', () => {
    const res = spawnSyncUnsupervised(['bun', 'run', AGENT_ENTRY, 'selfcheck'], { stdout: 'pipe', stderr: 'pipe' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toContain('lazy-agent ok');
  });

  // INVARIANT: --version / --revision self-identify too (a bare Bun binary would
  // print Bun's version here), so the agent is never mistaken for bare Bun.
  test('--version self-identifies as the lazy agent', () => {
    const res = spawnSyncUnsupervised(['bun', 'run', AGENT_ENTRY, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toContain('lazy-agent ok');
  });
});

describe('preflightAgentBinary', () => {
  // A command that exists but does NOT emit the sentinel simulates a bare Bun
  // binary / wrong file at /usr/local/bin/lazy-agent: `echo selfcheck` exits 0
  // but prints "selfcheck", not "lazy-agent ok". The preflight must reject it.
  test('rejects a binary that does not emit the sentinel', async () => {
    await expect(preflightAgentBinary('echo')).rejects.toThrow(/did not identify the lazy agent/);
  });

  // The field failure, reproduced exactly: the file mounted at
  // /usr/local/bin/lazy-agent was a bare Bun runtime. `bun selfcheck` behaves
  // identically to what the human saw — exit 1, EMPTY stdout, and the one line
  // that explains it (`error: Script not found "selfcheck"`) on stderr.
  //
  // INVARIANT: the preflight reads stderr. It used to pipe it and never read it,
  // so the report said `output: <no output>` while the binary had said precisely
  // what it was — and the same runtime then failed the container's real argv as
  // `Script not found "builder"`, looking like an unrelated second bug.
  test('surfaces the stderr of a bare Bun runtime and names the diagnosis', async () => {
    await expect(preflightAgentBinary('bun')).rejects.toThrow(/Script not found/);
    await expect(preflightAgentBinary('bun')).rejects.toThrow(/BARE BUN RUNTIME/);
  });

  // A non-existent command simulates a missing / non-executable mount. The
  // preflight must fail loudly with an actionable exec error, not hang or pass.
  test('rejects a missing binary with an actionable error', async () => {
    await expect(preflightAgentBinary('lazy-agent-does-not-exist-xyz'))
      .rejects.toThrow(/Builder preflight failed/);
  });
});
