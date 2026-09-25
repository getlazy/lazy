/**
 * The `cluster` type's constraints prompt, and the rule that it rides the TURN.
 *
 * INVARIANT: a cluster's constraints are resolved from `task.type` at launch,
 * not baked into the stored prompt the way `lazy fix`/`document`/`refactor`
 * bake theirs in. A cluster created through lazy_create, the dashboard form or
 * `lazy edit --type cluster` must run under the same rules as one created by
 * `lazy create --type cluster`, and a prompt edit must not be able to drop them
 * mid-run — the daemon enforces the remaining half of the contract
 * (restart-on-added-child) either way.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { typeConstraintsSection } from '../../src/task/type-constraints';
import builderSystemPrompt from '../../src/prompts/builder-system-prompt.md' with { type: 'text' };
import { VALID_TASK_TYPES } from '../../src/types';

describe('typeConstraintsSection', () => {
  test('a cluster task gets the cluster constraints', () => {
    const section = typeConstraintsSection({ type: 'cluster' });
    expect(section).toContain('cluster task');
    expect(section.endsWith('---\n\n')).toBe(true);
  });

  // INVARIANT: no other type gains a per-turn constraints block by accident.
  // fix/document/refactor keep theirs in the stored prompt.
  test('every other type contributes nothing', () => {
    for (const type of VALID_TASK_TYPES) {
      if (type === 'cluster') continue;
      expect(typeConstraintsSection({ type })).toBe('');
    }
    expect(typeConstraintsSection(null)).toBe('');
    expect(typeConstraintsSection(undefined)).toBe('');
  });
});

describe('the cluster contract the prompt states', () => {
  const prompt = typeConstraintsSection({ type: 'cluster' });

  test('states the cycle in terms of the tools that implement it', () => {
    for (const tool of ['lazy_start', 'lazy_wait', 'lazy_review', 'lazy_unblock', 'lazy_accept']) {
      expect(prompt).toContain(tool);
    }
  });

  // INVARIANT: reviewing children by reading their diffs would exhaust a
  // driver's context long before a dozen children were done — lazy_review exists
  // so a separate reviewer agent reads the diff instead.
  test('tells the agent not to review by reading child diffs', () => {
    expect(prompt).toContain('lazy_diff');
    expect(prompt.toLowerCase()).toContain('context');
  });

  // INVARIANT: the contract tells the driver to SCHEDULE, and says nothing
  // about running one child at a time.
  //
  // This REVERSES what the prompt said as `cluster-constraints.md` ("A cluster task
  // may have at most one running child. The daemon enforces this"). The
  // engineer dropped the serial rule on 2026-09-20 — see
  // docs/design/cluster-replaces-loop.md and the e2e twin in
  // test/e2e/cluster-task.test.ts. A contract that still claimed the old limit
  // would make a driver serialise itself out of politeness even though nothing
  // refuses it, which is the whole cost the reversal removed.
  test('tells the driver to decide concurrency, and claims no one-child limit', () => {
    expect(prompt).not.toContain('at most one running child');
    expect(prompt).not.toContain('one at a time');
    // It names the three things the decision turns on.
    expect(prompt).toContain('same files');
    expect(prompt).toContain('dependency');
    // And the mechanism that makes concurrency usable: race the children.
    expect(prompt).toContain('ARRAY');
  });

  test('states how a child is deferred and what happens at the end', () => {
    expect(prompt).toContain('deferred-by-');
    expect(prompt).toContain('lazy_tag');
    expect(prompt).toContain('blocking: true');
  });

  // INVARIANT (prompt-no-subtask-cannibalism): a child's work lands only by
  // accept — never by the parent re-implementing or copying the diff.
  test('states that a child\'s work lands only through accept', () => {
    expect(prompt).toContain('lazy_accept` is the only way');
  });

  test('states how a stopped cluster resumes', () => {
    expect(prompt).toContain('lazy unblock');
    expect(prompt).toContain('new child is added');
  });

  // INVARIANT: the restart exception must be stated WITH its exemption. The
  // daemon skips the restart for a cluster somebody stopped on purpose and
  // leaves the arrival as a comment instead (`src/daemon/cluster-restart.ts`),
  // so a driver told only "a new child starts a fresh turn" is told something
  // false for exactly the case where an operator parked it — and it is the
  // driver, not the builder, that decides whether to treat itself as parked.
  // The builder's half of this contract is pinned below; this is the agent's,
  // which had no pin at all while prompt text drifts silently across rewrites.
  test('states that a deliberate stop is exempt from the restart', () => {
    expect(prompt).toContain('lazy stop');
    expect(prompt).toMatch(/stopped\s+you\s+deliberately/);
    expect(prompt).toMatch(/does\s+not\s+start\s+you/);
  });
});

/**
 * The other side of the same contract: the BUILDER must not drive a cluster's
 * child itself.
 *
 * INVARIANT: the builder hands work to the cluster and reviews through it. A
 * builder that starts, unblocks or reviews a cluster's child directly duplicates
 * the review the driver is there to run, and leaves the cluster's branch without
 * the child's work — a driver never accepts a child it was never told about.
 * The rule is stated in the builder's prompt because nothing in the daemon
 * refuses it: the builder is unrestricted by design.
 */
describe('the builder prompt states that cluster children are the driver\'s to drive', () => {
  test('names the rule, the tools not to use on a child, and the exceptions', () => {
    expect(builderSystemPrompt).toContain("Cluster children are the driver's to drive");
    // The concrete acts the builder must not perform on the child itself.
    // Whitespace-tolerant: the paragraph is hard-wrapped, so the clause moves
    // across line breaks whenever it is reworded.
    expect(builderSystemPrompt).toMatch(
      /Never\s+`lazy_start`,\s+`lazy_unblock`\s+or\s+review\s+the\s+CHILD/,
    );
    // INVARIANT: the mechanic is stated with its precondition. The restart in
    // src/daemon/cluster-restart.ts fires only for a cluster in `blocked`
    // (awaiting review) that has a session; a cluster never started, interrupted
    // or in conflict is "parked" in the plain sense but is NOT woken by an added
    // child. An unconditional promise here is a hand-off the builder walks
    // away from and nobody runs.
    expect(builderSystemPrompt).toMatch(/A\s+cluster\s+parked\s+awaiting\s+review\s+restarts\s+itself/);
    expect(builderSystemPrompt).toMatch(
      /never\s+started,\s+interrupted\s+or\s+in\s+conflict\s+does\s+not/,
    );
    // INVARIANT: the same paragraph must say that a cluster stopped with
    // `lazy_stop` is NOT woken by an added child. Every other passage in this
    // prompt tells the builder a stopped task is not auto-resumed; the restart
    // used to be the one exception, and it was the exception in exactly the
    // case where the operator had deliberately parked it. The daemon now skips
    // a user-stopped cluster and leaves the arrival on it as a note
    // (src/daemon/cluster-restart.ts), so the prompt must say so — a builder that
    // believes the cluster woke up walks away from work nobody is running.
    expect(builderSystemPrompt).toMatch(
      /one\s+you\s+stopped\s+with\s+`lazy_stop`\s+stays\s+stopped/,
    );
    // INVARIANT: and that the stop has a stated END. `user_stopped` is cleared
    // by resetConsecutiveInterruptions; the `actor === 'human'` conditions on
    // unblock and resume decide only who clears it EAGERLY at launch, while
    // every completion path (work, sync, ask, review, wrap-up settle) calls it
    // unconditionally. So the exemption lasts until the cluster's next completed
    // turn, whoever started it — and the builder needs the duration, not just
    // the fact: children added inside that window accumulate as notes it must
    // hand over itself, and after it the automatic restart is live again.
    // (This assertion replaced one pinning "your own unblock does not un-stop
    // it" — a claim that read the launch-time gate as the whole rule. Replaced
    // on the driver's instruction after it verified the completion sites.)
    expect(builderSystemPrompt).toMatch(
      /stop\s+lasts\s+until\s+the\s+cluster.s\s+next\s+completed\s+turn/,
    );
    expect(builderSystemPrompt).toMatch(/Exceptions:\s+an\s+engineer\s+bypass,\s+or\s+pairing/);
  });

  // INVARIANT: the rule is cross-referenced where the builder DECIDES to act on
  // a blocked task, not only where it creates one. The incident this comes from
  // happened at review time: a cluster's child parks in `blocked`, so it shows
  // up in `lazy_blocked` alongside everything else the builder is told to review
  // and unblock, ~70 lines away from the rule.
  test('points back to the rule where blocked tasks are picked up and reviewed', () => {
    const blockedLine = builderSystemPrompt
      .split('\n')
      .find(l => l.startsWith('- `lazy_blocked`') && l.includes('waiting for review'));
    expect(blockedLine).toBeDefined();
    expect(blockedLine).toContain("Cluster children are the driver's to drive");

    const reviewSection = builderSystemPrompt.slice(
      builderSystemPrompt.indexOf('### Reviewing and feedback'),
      builderSystemPrompt.indexOf('### Resuming work'),
    );
    expect(reviewSection).toMatch(/Cluster\s+children\s+are\s+the\s+driver's\s+to\s+drive/);
  });

  test('lists `cluster` as a task type with constraints', () => {
    expect(builderSystemPrompt).toMatch(/\|\s*`cluster`\s*\|/);
    expect(builderSystemPrompt).toContain('`fix`, `refactor`, `document`, `cluster`');
  });
});

/**
 * Source scan: EVERY path that launches a work turn injects the constraints.
 *
 * Mechanical on purpose. "The constraints ride the turn" is only true if every
 * launch path says so, and the ones that forget are exactly the paths nobody
 * exercises by hand: the daemon's own recovery and delivery turns. Three of the
 * five command literals had no injection at all — auto-resume after a crash, manual
 * `lazy resume`, and `autoUnblockTask`, which is the very path
 * `cluster-restart.ts` uses to wake a blocked cluster when a child is added to
 * it. A driver resumed
 * through any of them got a bare "carry on" prompt, with no contract telling it
 * to re-read its tree and drive its children rather than do their work — and a
 * resume often runs on a FRESH agent session, because `agent_session_id` is
 * only recorded when a turn finalizes, so there was no remembered contract
 * either.
 */
describe('every work-turn launch path injects the type constraints', () => {
  // file → the command literal whose `prompt:` must carry the section.
  const LAUNCH_PATHS: Array<{ file: string; what: string }> = [
    { file: 'src/daemon/task-launcher.ts', what: 'start' },
    { file: 'src/daemon/task-lifecycle.ts', what: 'unblock + resume' },
    { file: 'src/utils/auto-resume.ts', what: 'auto-resume after a crash' },
    { file: 'src/daemon/auto-deliver.ts', what: 'auto-unblock / cluster restart' },
  ];

  for (const { file, what } of LAUNCH_PATHS) {
    test(`${file} (${what})`, async () => {
      const src = await readFile(join(import.meta.dir, '..', '..', file), 'utf-8');
      expect(src).toContain('typeConstraintsSection');
    });
  }

  // Both command literals in task-lifecycle.ts need it — unblock (which always
  // had it) and resume (which did not). One `typeConstraintsSection` in the file
  // would satisfy the check above while the other path stayed bare.
  test('task-lifecycle.ts injects it on BOTH of its command paths', async () => {
    const src = await readFile(join(import.meta.dir, '..', '..', 'src/daemon/task-lifecycle.ts'), 'utf-8');
    const uses = src.match(/typeConstraintsSection\(task\)/g) ?? [];
    expect(uses.length).toBe(2);
  });
});
