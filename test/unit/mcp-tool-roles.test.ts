/**
 * INVARIANT: the MCP tool list is scoped by ROLE, and the scoping is an
 * ADVERTISEMENT decision only — never the enforcement one.
 *
 * A caller pays for the whole `tools/list` reply before it sends its first
 * message, so serving the builder tools an agent can never call (and vice
 * versa) is pure context tax plus an invitation to call something that will be
 * refused. The role is known where the server is built: builder launches pass
 * no `--task-id`, task agents always do.
 *
 * The refusal is still what makes it SAFE. A hidden tool stays registered with
 * its real handler, so a caller whose context still lists it — a stale system
 * prompt, a resumed conversation, a hand-written client — gets that handler's
 * actionable refusal rather than the useless "Unknown tool". Narrowing the
 * advertisement must never become the only thing standing between an agent and
 * a builder-only write.
 */

import { describe, test, expect } from 'bun:test';
import {
  AGENT_ONLY_TOOL_NAMES,
  BUILDER_ONLY_TOOL_NAMES,
  isToolForRole,
  roleForTaskId,
} from '../../src/mcp/tool-roles';
import { toolNamesForRole, serializedToolSurface } from '../../src/mcp/tool-surface';
import { allTools, createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import type { Storage } from '../../src/storage';

/**
 * Every role guard under test throws on `ctx.taskId` alone, before it reaches
 * storage — so a context with no storage is enough, and using one keeps the
 * test honest about that: a guard that started touching the store first would
 * fail here loudly instead of passing on a mock.
 */
function ctxFor(taskId: string): McpToolContext {
  return { taskId, worktreePath: '/nonexistent', storage: undefined as unknown as Storage };
}

describe('MCP tool roles', () => {
  test('every role-scoped name is a real tool, and the lists are disjoint', () => {
    const known = new Set(allTools.map(t => t.name));
    for (const name of [...AGENT_ONLY_TOOL_NAMES, ...BUILDER_ONLY_TOOL_NAMES]) {
      expect(known.has(name)).toBe(true);
    }
    for (const name of AGENT_ONLY_TOOL_NAMES) {
      expect(BUILDER_ONLY_TOOL_NAMES).not.toContain(name);
    }
  });

  test('the role is the presence of a task id, nothing else', () => {
    expect(roleForTaskId(undefined)).toBe('builder');
    expect(roleForTaskId('')).toBe('builder');
    expect(roleForTaskId('abc12345')).toBe('agent');
  });

  test('each role is served everything except the other role\'s tools', () => {
    const builder = toolNamesForRole('builder');
    const agent = toolNamesForRole('agent');

    for (const name of AGENT_ONLY_TOOL_NAMES) {
      expect(builder).not.toContain(name);
      expect(agent).toContain(name);
    }
    for (const name of BUILDER_ONLY_TOOL_NAMES) {
      expect(agent).not.toContain(name);
      expect(builder).toContain(name);
    }

    const shared = allTools
      .map(t => t.name)
      .filter(n => !AGENT_ONLY_TOOL_NAMES.includes(n) && !BUILDER_ONLY_TOOL_NAMES.includes(n));
    for (const name of shared) {
      expect(builder).toContain(name);
      expect(agent).toContain(name);
    }
  });

  // Fail OPEN on a name nobody classified: a tool added without a role entry is
  // served to both, which costs context. Hiding it from both would make a new
  // tool silently unreachable, which costs a debugging session.
  test('an unclassified tool is served to both roles', () => {
    expect(isToolForRole('lazy_some_new_tool', 'builder')).toBe(true);
    expect(isToolForRole('lazy_some_new_tool', 'agent')).toBe(true);
  });

  // The half that makes the narrowing safe: every hidden tool still has a
  // handler, and that handler refuses the caller it is hidden from with an
  // actionable sentence — never the "Unknown tool" a de-registered tool would
  // produce, which reads as lazy being broken.
  async function expectRefusal(handler: (a: Record<string, unknown>) => Promise<unknown>) {
    let message = '';
    try {
      await handler({});
      throw new Error('handler resolved instead of refusing');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBe('handler resolved instead of refusing');
    expect(message).not.toContain('Unknown tool');
    // An actionable sentence, not a bare code — every one of these says what
    // the caller should do instead.
    expect(message.length).toBeGreaterThan(30);
    return message;
  }

  test('a builder-only tool still refuses an agent caller', async () => {
    const handlers = createAllHandlers(ctxFor('abc12345'));
    for (const name of BUILDER_ONLY_TOOL_NAMES) {
      const handler = handlers.get(name);
      expect(handler).toBeDefined();
      await expectRefusal(handler!);
    }
  });

  test('an agent-only tool still refuses a builder caller', async () => {
    const handlers = createAllHandlers(ctxFor(''));
    for (const name of AGENT_ONLY_TOOL_NAMES) {
      const handler = handlers.get(name);
      expect(handler).toBeDefined();
      await expectRefusal(handler!);
    }
  });

  // Read-only narrows ON TOP of the role, never instead of it: lazy_scratch is
  // a read, but it is builder-only, so an agent's ask turn must not see it.
  test('read-only narrows within the role', () => {
    const agentReads = toolNamesForRole('agent', { readOnly: true });
    expect(agentReads).not.toContain('lazy_scratch');
    expect(agentReads).not.toContain('lazy_commit');
    expect(agentReads).toContain('lazy_show');
    expect(agentReads.length).toBeLessThan(toolNamesForRole('agent').length);
  });
});

/**
 * INVARIANT: the served tool surface has a byte budget.
 *
 * This is the whole point of the trim — `/context` showed 50 tools costing
 * ~20.7k tokens before the builder's first message. Descriptions grow one
 * reasonable paragraph at a time and nobody ever measures the total, so the
 * budget is the thing that notices.
 *
 * It is a RATCHET, not a distant ceiling, and the difference was measured: at
 * the original 50,000 a 2,000-byte padded description still passed (only a
 * ~6,000-byte one failed), so the assertion would have missed exactly the
 * regression it exists to catch — restoring one trimmed narrative costs about
 * 1.3k. The number sits ~1.3k above the larger role instead, which a normal
 * rule sentence (~100–200 bytes) clears several times over.
 *
 * Tripping this is not a signal to delete the assertion: raise the number
 * deliberately in the same diff and say why. That bump IS the review signal —
 * it puts the context cost in front of a human once, which is the whole point.
 *
 * Baseline before this task: 64,389 bytes for one 52-tool list served to both
 * roles. Measured after: builder 45,071, agent 45,721. See
 * docs/reviews/mcp-tool-context-2026-09.md.
 *
 * After `lazy_link` landed on this hub the agent surface is 47,697 and the
 * builder 47,019. The ratchet sits ~1.3k above the larger role (49,000) so a
 * normal rule sentence still clears, and the bump itself is the review signal.
 *
 * `lazy_regions` (add-review-regions) adds a tool and a `region` parameter on
 * `lazy_diff`: agent 49,090, builder 48,412. Raised deliberately to 50,400,
 * which keeps the same ~1.3k headroom over the larger role. The cost buys the
 * agent surface for review regions — an agent reviewing a large branch a
 * region at a time is what the tool exists for, and it cannot do that without
 * knowing the tool is there.
 *
 * Merging release-v022 into that work takes the agent surface to 51,079, and
 * TWO contributions are in that number — say both, because the point of this
 * ratchet is that a growth goes past a human once:
 *
 *  - the release branch's own tools (the Reviews-as-Raises set) arrived at
 *    49,371 against the 49,000 ceiling in force at the time, i.e. 371 bytes
 *    over it, WITHOUT the ceiling being raised. Verified by type-checking and
 *    running this suite on `origin/lazy/release-v022` in isolation, where it
 *    fails the same way with no region work present at all;
 *  - `lazy_regions` and the `region` parameter account for the remaining
 *    ~1.7k, which is the cost already justified above.
 *
 * Raised to 52,400. The first bullet is a regression someone else owns; it is
 * recorded here rather than quietly absorbed, because absorbing it is exactly
 * how a ratchet stops being a ratchet.
 *
 * Merging the ui-feedback-2026-09-12 branch in adds a THIRD contribution, named
 * here under the same rule the two bullets above follow — agent 51,426, builder
 * 49,987 as measured on the merge:
 *
 *  - ~350 bytes of documented rule prose: the rewritten `lazy_search` grammar
 *    paragraph (`task:` replacing `code:`, and which fields are substring vs
 *    exact), the agent-PROFILE wording on `lazy_create` / `lazy_start` /
 *    `lazy_edit`, `lazy_wait`'s head_sha, and `lazy_raised_item_comment`.
 *
 * The 52,400 ceiling is KEPT rather than re-raised for that: it leaves 974
 * bytes over the larger role, which still does the job this ratchet is sized
 * for — a restored trimmed narrative (~1.3k) trips it, a normal rule sentence
 * (~100–200 bytes) clears it several times over. Headroom is therefore ~1.0k
 * here, not the ~1.3k the bullets above describe; say the real number, since a
 * ratchet whose stated headroom is wrong is one nobody can reason about.
 *
 * Making `lazy_ask` and `lazy_review` ASYNCHRONOUS adds a FOURTH contribution —
 * agent 52,376, builder 50,937 after trimming:
 *
 *  - ~950 bytes of documented rule prose across four tools, because the calling
 *    contract itself changed and an agent that does not know it is stranded:
 *    `lazy_ask` / `lazy_review` must say they START a turn and return, that
 *    there is no time limit, and where the answer is read; `lazy_wait` must say
 *    it returns for those turns too; `lazy_stop` must say it ends one. This is
 *    the "normal rule sentence" case the ratchet is meant to admit, arriving
 *    four times over rather than once.
 *
 * Raised to 53,400. Kept-as-is was not an option: after trimming every sentence
 * that could go without losing a rule, 52,400 left 24 bytes over the agent role
 * — a ratchet a single clause trips is one that no longer distinguishes a rule
 * sentence from a restored narrative, which is the distinction it exists to
 * make. The new number restores ~1.0k headroom over the larger role, the same
 * figure the paragraph above states.
 *
 * `lazy_show` then gained two sections (`notes`, `reviews`) and the sentences
 * describing them, which is a normal rule addition — but it lands against
 * headroom the previous raise had already spent down, so the ceiling is KEPT
 * and the prose was trimmed to fit instead. Real headroom over the agent role
 * is now ~40 bytes, not ~1.0k: the next addition of any size has to trim
 * something or argue for a raise, and there is no longer room to add a
 * sentence quietly. Stated plainly for the same reason as above — a ratchet
 * whose headroom is misstated is one nobody can reason about.
 *
 * `lazy_final` then arrived: a WHOLE NEW TOOL, 695 bytes on the agent role, and
 * the first addition to meet the "trim or argue" rule the paragraph above set
 * out. Both halves were done rather than one. TRIMMED: the description was
 * drafted at 1,169 bytes with the three turn endings spelled out in full, and
 * cut to 695 — the endings belong in the system prompt, which is where an agent
 * reads the contract; the tool only has to carry what calling THIS tool means
 * (a claim about the head, not a turn end), its one refusal, and what cancels
 * it. ARGUED: a new tool is neither of the two things this ratchet
 * distinguishes. It is not a restored narrative and not a rule sentence on an
 * existing tool; it is a capability that did not exist, and refusing it on byte
 * grounds would make the ratchet a cap on the surface rather than a guard
 * against prose creeping back into it.
 *
 * Raised to 55,100, which restores ~1.0k headroom over the agent role (54,048)
 * — the same figure the two raises above targeted, so the next addition faces
 * the same test this one did rather than an accidentally tighter or looser one.
 *
 * `lazy_report`'s `presentation` then documented its three ITEM SHAPES (they
 * were literally `...` before, which is not a schema an agent can write
 * against) and the directory/glob claim that lets a release-sized branch be
 * presented at all. TRIMMED rather than raised: the first draft said the glob
 * rule twice — once in the tool description and again in the property — and
 * the duplicate went, leaving the rule where a caller writing the argument
 * reads it. The ceiling is KEPT and headroom over the agent role (54,739) is
 * now ~360 bytes, so the next addition of any size trims or argues, exactly
 * as the paragraph above required of this one.
 *
 * `lazy_regions` then had to say the two things that changed under it: a
 * walkthrough is filed on every human-facing park rather than only on a final,
 * and a task with landed subtasks is presented by those children. TRIMMED, and
 * the ceiling KEPT again — the provenance rule was stated twice, once in the
 * description and again in the property, exactly as the glob rule had been, so
 * the description now points at the property and the property carries the whole
 * rule. The surface came out smaller than it went in.
 *
 * A `review` argument then landed on `lazy_create`, `lazy_start` and
 * `lazy_edit` — the per-task review MODE (off / low-high / separate), which
 * decides whether a task gets a second reader at all and therefore what it
 * costs to finish. ARGUED and TRIMMED, in that order.
 *
 * ARGUED: this is the third kind of addition the ratchet distinguishes — a
 * capability that did not exist, on three tools rather than one, and the
 * property must carry enough for a caller to CHOOSE between the modes rather
 * than just name them. A driver told only "off | low-high | separate" cannot
 * know that separate costs 3-4x, which is the one fact the choice turns on;
 * refusing the sentence that says so on byte grounds would make the ratchet a
 * cap on what the surface can express.
 *
 * TRIMMED: the description is written ONCE (`REVIEW_ARG_DESCRIPTION`) and
 * shared by all three, rather than three drifting copies, and it was cut from
 * 634 bytes to 441 — the low-high phase breakdown went (an agent choosing a
 * mode does not need the phase list; the docs have it) and `lazy_edit`'s extra
 * sentence about driver escalation went with it, since the cluster contract in
 * the system prompt is where a driver reads that.
 *
 * Raised to 56,800, which restores ~110 bytes of headroom over the agent role
 * (56,687). Deliberately tighter than the ~360 the last raise left: the next
 * addition of any size trims or argues, exactly as this one had to.
 *
 * Then `review_gate` and `review_auto_fix` joined `review` on the same three
 * tools — the engineer's requirement that every review setting be overridable
 * per task, with inheritance. ARGUED and TRIMMED again.
 *
 * ARGUED: the same third category as the `review` addition itself, and for a
 * sharper reason. These three are now the ONLY way an agent can say how its own
 * subtask is reviewed, and the inheritance requirement is what makes them worth
 * their bytes: a cluster driver sets a mode once on itself and every child
 * follows, so the tools that create and start children have to carry it.
 * Offering `review` without `review_gate` would also be the worse shape — a
 * caller able to pick the fast mode but not to say "and still gate on what the
 * self-review found" has half a feature.
 *
 * TRIMMED: the inheritance sentence is now one shared constant
 * (`REVIEW_INHERIT_TAIL`) rather than three near-copies, the mode description
 * lost its parenthetical list of what justifies a cold read (the docs have it),
 * and the two new ones lean on their enums instead of restating the vocabulary
 * in prose. 1,220 bytes of description became 730.
 *
 * Raised to 58,700, restoring ~35 bytes over the agent role (58,665). Tighter
 * again than the last raise, and deliberately: the next addition of any size
 * trims or argues, as each of these has had to.
 *
 * `lazy_usage_limits` then arrived: a WHOLE NEW TOOL, like `lazy_final` — the
 * engineer asked for the builder to read its own remaining usage before
 * planning. ARGUED on the same ground: a capability that did not exist, not
 * prose creeping back. TRIMMED: no arguments, and trimming the description took the agent
 * role from 59,016 to 58,873 bytes — the "check it before planning" advice
 * lives in the builder system prompt, where the builder reads its contract.
 *
 * Raised to 58,910, ~37 bytes over the agent role (58,873).
 */
describe('MCP tool surface byte budget', () => {
  const BUDGET_BYTES = 58_910;

  for (const role of ['builder', 'agent'] as const) {
    test(`the ${role} surface stays under budget`, () => {
      const { count, text } = serializedToolSurface(role);
      // Sanity: an empty or collapsed list would pass a ceiling vacuously.
      expect(count).toBeGreaterThan(30);
      expect(text.length).toBeLessThan(BUDGET_BYTES);
    });
  }
});
