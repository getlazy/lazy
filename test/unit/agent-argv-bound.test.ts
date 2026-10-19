/**
 * The argv rule, held for EVERY registered harness at once.
 *
 * Linux refuses an argv element over 128 KiB (MAX_ARG_STRLEN) with E2BIG at
 * posix_spawn: the agent never starts and the task crash-loops. It was fixed
 * three times, one harness at a time (Cursor, pi, Codex), and Claude Code was
 * still passing `claude -p <prompt>` when it hit a user. This test iterates the
 * registry, so a harness added later is covered without anyone remembering to.
 */

import { describe, test, expect } from 'bun:test';
import { listAgents, getAgent } from '../../src/agent/registry';
import { ARGV_ELEMENT_MAX_BYTES, ARGV_TOTAL_MAX_BYTES, assertArgvBounded } from '../../src/agent/argv-safety';
import { SYSTEM_PROMPT_FILE_ARG, type AgentExecArgs } from '../../src/agent/interface';
import { composeBuilderClaudeArgs } from '../../src/supervisor/builder';
import { buildBuilderHeadlessClaudeArgs } from '../../src/runner/builder-headless';
import { buildOneshotAgentArgv } from '../../src/oneshot/args';

const MIB = 1024 * 1024;
const BIG_PROMPT = 'P'.repeat(MIB);
const BIG_SYSTEM = 'S'.repeat(MIB);

function expectBounded(argv: readonly string[]): void {
  for (const element of argv) {
    expect(Buffer.byteLength(element, 'utf8')).toBeLessThanOrEqual(ARGV_ELEMENT_MAX_BYTES);
  }
  const total = argv.reduce((sum, a) => sum + Buffer.byteLength(a, 'utf8') + 1, 0);
  expect(total).toBeLessThanOrEqual(ARGV_TOTAL_MAX_BYTES);
}

describe('every harness keeps unbounded text out of argv', () => {
  const variants = [
    { name: 'work turn', opts: { dangerouslySkipPermissions: true } },
    { name: 'resumed turn', opts: { dangerouslySkipPermissions: true, sessionId: '0b6f2a4c-1111-4222-8333-944455556666' } },
    { name: 'read-only turn', opts: { dangerouslySkipPermissions: false, permissionMode: 'plan' as const } },
  ];

  for (const harness of listAgents()) {
    for (const variant of variants) {
      // INVARIANT: no harness puts a prompt or system prompt in argv, whatever
      // their size. A 1 MiB prompt in argv is an E2BIG at spawn — a crash loop.
      test(`${harness}: ${variant.name} with a 1 MiB prompt and system prompt`, () => {
        const args: AgentExecArgs = getAgent(harness).buildExecArgs({
          prompt: BIG_PROMPT,
          systemPrompt: BIG_SYSTEM,
          modelId: 'claude-sonnet-5-5',
          ...variant.opts,
        });
        expectBounded(args);
        expect(() => assertArgvBounded(args, harness)).not.toThrow();
        // Nothing was dropped to get there: the prompt rides stdin, and the
        // system prompt rides stdin (folded in) or a file.
        expect(args.stdinInput).toContain(BIG_PROMPT);
        const systemCarried = (args.stdinInput ?? '').includes(BIG_SYSTEM)
          || (args.systemPromptInput === BIG_SYSTEM && args.includes(SYSTEM_PROMPT_FILE_ARG));
        // qa-agent is a scripted test harness that ignores the system prompt.
        if (harness !== 'qa-agent') expect(systemCarried).toBe(true);
      });
    }
  }

  test('one-shots, for every harness', () => {
    for (const harness of listAgents()) {
      const args = buildOneshotAgentArgv(harness, BIG_PROMPT, 'claude-sonnet-5-5');
      expectBounded(args);
      expect(args.stdinInput).toContain(BIG_PROMPT);
    }
  });

  test('builder launches', () => {
    expectBounded(composeBuilderClaudeArgs({ systemPrompt: BIG_SYSTEM, systemPromptFile: '/x/prompt.txt', resumeId: null, extraArgs: [] }));
    const headless = buildBuilderHeadlessClaudeArgs('/x/prompt.txt', BIG_PROMPT, null, 'claude-sonnet-5-5');
    expectBounded(headless);
    expect(headless.stdinInput).toBe(BIG_PROMPT);
  });

  // INVARIANT: the spawn seam refuses an oversize argv with a message naming
  // it, instead of an anonymous E2BIG from the kernel.
  test('the seam refuses an oversize element by name', () => {
    expect(() => assertArgvBounded(['claude', '-p', BIG_PROMPT], 'Claude Code'))
      .toThrow(/Claude Code was not launched: argv element 2 is \d+ bytes/);
  });
});

describe('a launch too big to spawn is never retried, on any harness', () => {
  // INVARIANT: E2BIG (and lazy's own argv-bound refusal) is fatal_config for
  // EVERY harness. Claude Code classified it `unknown`, retried the identical
  // argv and ended in "Crash loop detected" — the in-the-wild failure.
  // qa-agent is a scripted stand-in that never spawns a real agent binary.
  for (const harness of listAgents().filter(h => h !== 'qa-agent')) {
    test(harness, () => {
      const agent = getAgent(harness);
      expect(agent.classifyFailure({ message: "E2BIG: argument list too long, posix_spawn 'x'" }).class).toBe('fatal_config');
      let refusal = '';
      try { assertArgvBounded(['x', BIG_PROMPT], harness); } catch (err) { refusal = (err as Error).message; }
      expect(agent.classifyFailure({ message: refusal }).class).toBe('fatal_config');
    });
  }
});
