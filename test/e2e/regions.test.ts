/**
 * E2E for `lazy regions` and `lazy diff --region`, against a PRESENTATION
 * source — the regions a human surface shows are the walkthrough the agent
 * declared in its final-turn report (`lazy_report` with a `presentation`),
 * never a carve guessed from git (§6.3: the carve/areas/superseded axes left
 * every human surface; they survive only as the agent's own `lazy_regions`
 * hint, which the MCP e2e covers).
 *
 * The presentation mechanics themselves are unit-tested (see
 * test/unit/regions-presentation.test.ts). What is tested HERE is the thing
 * only an end-to-end run can show: that a real report filed through the
 * daemon's MCP surface becomes the regions a CLI reader lists, scopes a real
 * diff by, and keys a reviewer overlay (owner, name, sign-off) to — and that
 * a task whose agent filed no walkthrough answers with the hint instead of
 * an error or an invented grouping.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { worktreePathFor } from '../helpers/storage';
import { runMcpSession } from '../helpers/mcp-session';

/**
 * A started, blocked task whose branch carries three files, two of which the
 * agent's walkthrough claims — `feature.txt` under a core group, `notes.md`
 * under a docs one — leaving `extra.txt` for the residual group. The declared
 * order (core, docs) deliberately disagrees with display order (docs above
 * core); the CLI is a DATA surface and reads the declared order.
 */
async function presentedTask(ctx: TestContext): Promise<{ taskId: string; worktree: string }> {
  const taskId = await createTask(ctx, 'Regions e2e', 'Some work');
  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);
  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }

  const worktree = worktreePathFor(ctx.root, taskId);
  writeFileSync(join(worktree, 'feature.txt'), 'feature one\nfeature two\n');
  writeFileSync(join(worktree, 'notes.md'), 'docs one\n');
  writeFileSync(join(worktree, 'extra.txt'), 'extra one\n');
  expect(ctx.git('-C', worktree, 'add', 'feature.txt', 'notes.md', 'extra.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktree, 'commit', '-m', 'Add feature, notes, extra').exitCode).toBe(0);

  await runMcpSession(ctx.root, taskId, worktree, [
    {
      method: 'initialize',
      id: 1,
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    },
    {
      method: 'tools/call',
      id: 2,
      params: {
        name: 'lazy_report',
        arguments: {
          sections: [{ kind: 'what_was_done', body: 'Shipped the regions e2e fixture' }],
          presentation: {
            groups: [
              { title: 'Core first', tier: 'core', items: [{ kind: 'file', file: 'feature.txt' }] },
              { title: 'Docs later', tier: 'docs', items: [{ kind: 'file', file: 'notes.md' }] },
            ],
          },
        },
      },
    },
  ]);

  return { taskId, worktree };
}

/** A started, blocked task whose agent filed no walkthrough at all. */
async function unpresentedTask(ctx: TestContext): Promise<string> {
  const taskId = await createTask(ctx, 'Unpresented e2e', 'Some work');
  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);
  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }
  return taskId;
}

/** A tiny git helper for the staleness fixtures — commits one file's rewrite. */
function commitFile(worktree: string, file: string, content: string, message: string): void {
  writeFileSync(join(worktree, file), content);
  const add = Bun.spawnSync(['git', '-C', worktree, 'add', file]);
  if (add.exitCode !== 0) {
    throw new Error(`git add ${file}: ${new TextDecoder().decode(add.stderr)}`);
  }
  const commit = Bun.spawnSync(['git', '-C', worktree, 'commit', '-q', '-m', message, '--no-verify']);
  if (commit.exitCode !== 0) {
    throw new Error(`git commit: ${new TextDecoder().decode(commit.stderr)}`);
  }
}

/** File a walkthrough for `taskId` at whatever its head is right now. */
async function fileWalkthrough(ctx: TestContext, taskId: string, worktree: string): Promise<void> {
  await runMcpSession(ctx.root, taskId, worktree, [
    {
      method: 'initialize',
      id: 1,
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    },
    {
      method: 'tools/call',
      id: 2,
      params: {
        name: 'lazy_report',
        arguments: {
          sections: [{ kind: 'what_was_done', body: 'Re-filed at the current head' }],
          presentation: {
            groups: [
              { title: 'Core first', tier: 'core', items: [{ kind: 'file', file: 'feature.txt' }] },
            ],
          },
        },
      },
    },
  ]);
}

/** Create, run and ACCEPT one child into `hubId`, so its work lands. */
async function landChild(ctx: TestContext, hubId: string, goal: string, file: string): Promise<void> {
  const child = await ctx.lazy(['create', '--goal', goal, '--prompt', 'Add a file', '--parent', hubId]);
  expectSuccess(child);
  const childId = child.stdout.match(/([a-f0-9]{8})/)![1]!;
  expectSuccess(await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  }));
  expect((await ctx.lazy(['wait', childId])).exitCode).toBe(0);
  commitFile(worktreePathFor(ctx.root, childId), file, 'from the child\n', `Add ${file}`);
  expectSuccess(await ctx.lazy(['accept', childId, '--yes']));
}

describe('lazy regions — the walkthrough as regions', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lists the walkthrough groups, in the agent\'s declared order', async () => {
    const { taskId } = await presentedTask(ctx);

    const result = await ctx.lazy(['regions', taskId]);
    expectSuccess(result);
    // The counts line, then one row per group — DECLARED order (the CLI is a
    // data surface; display order is the review page's concern).
    expectOutput(result, '3 region(s)');
    expectOutput(result, 'core-first');
    expectOutput(result, 'Core first');
    expectOutput(result, 'docs-later');
    expectOutput(result, 'Docs later');
    expectOutput(result, 'other-changes');
    expectOutputExcludes(result, 'no presented regions yet');
    // The regions strip and this listing both promise a scoping command.
    expectOutput(result, '--region');
  });

  test('the residual row says how much of the change the walkthrough did not name', async () => {
    // A reader deciding how much is unaccounted for should not have to count
    // rows: the size of what was left out goes on the row that holds it.
    const { taskId } = await presentedTask(ctx);

    const result = await ctx.lazy(['regions', taskId]);
    expectSuccess(result);
    expectOutput(result, '1 of 3 changed files is not named in the walkthrough.');
  });

  test('every file of the review belongs to exactly one region', async () => {
    // INVARIANT: regions are a PARTITION. The top-level regions' file counts
    // sum to the number of files in the review's own diff, and no file is in
    // two of them — which is what makes signing one off mean something. The
    // file the walkthrough never claimed still belongs somewhere: the
    // residual group, which the listing never suppresses.
    const { taskId } = await presentedTask(ctx);

    const listed = await ctx.lazy(['regions', taskId, '--json']);
    expectSuccess(listed);
    const cover = JSON.parse(listed.stdout) as {
      regions: Array<{ id: string; depth: number; files: number }>;
    };
    const top = cover.regions.filter((r) => r.depth === 0);
    expect(top.map((r) => r.id)).toEqual(['core-first', 'docs-later', 'other-changes']);

    const owned: string[] = [];
    for (const region of top) {
      const detail = await ctx.lazy(['regions', taskId, '--region', region.id, '--json']);
      expectSuccess(detail);
      owned.push(...(JSON.parse(detail.stdout).region.files as string[]));
    }
    expect(new Set(owned).size).toBe(owned.length);
    expect(owned.length).toBe(top.reduce((n, r) => n + r.files, 0));
    expect(owned.sort()).toEqual(['extra.txt', 'feature.txt', 'notes.md']);
  });

  test('--region names one group, and --files lists its files', async () => {
    const { taskId } = await presentedTask(ctx);

    const result = await ctx.lazy(['regions', taskId, '--region', 'core-first', '--files']);
    expectSuccess(result);
    expectOutput(result, 'feature.txt');
    expectOutputExcludes(result, 'notes.md');
    expectOutputExcludes(result, 'extra.txt');
  });

  test('--owner records who a group is to review, and it shows on the list', async () => {
    const { taskId } = await presentedTask(ctx);

    const set = await ctx.lazy([
      'regions', taskId, '--region', 'core-first', '--owner', 'ierceg',
    ]);
    expectSuccess(set);
    expectOutput(set, 'owner ierceg');

    const listed = await ctx.lazy(['regions', taskId]);
    expectSuccess(listed);
    expectOutput(listed, 'owner ierceg');

    // An empty owner clears it — no second verb for unassigning.
    const cleared = await ctx.lazy([
      'regions', taskId, '--region', 'core-first', '--owner', '',
    ]);
    expectSuccess(cleared);
    expectOutput(cleared, 'owner cleared');
    expectOutputExcludes(await ctx.lazy(['regions', taskId]), 'owner ierceg');
  });

  test('--name and --sign-off key to the group\'s own content', async () => {
    const { taskId, worktree } = await presentedTask(ctx);

    const named = await ctx.lazy([
      'regions', taskId, '--region', 'core-first', '--name', 'The core slab',
    ]);
    expectSuccess(named);

    const signed = await ctx.lazy(['regions', taskId, '--region', 'core-first', '--sign-off']);
    expectSuccess(signed);
    expectOutput(signed, 'signed off');

    const after = await ctx.lazy(['regions', taskId]);
    expectSuccess(after);
    expectOutput(after, 'The core slab');
    expectOutput(after, 'signed off @');
    expectOutputExcludes(after, 'STALE');

    // A commit to ANOTHER group's file moves the branch but leaves this
    // group's own content untouched.
    // INVARIANT: a sign-off is keyed to the region's own content hash, not
    // to the branch head — the thing it approved is the files the group
    // owns, so a sibling group changing must not stale it (§14).
    commitFile(worktree, 'notes.md', 'docs one\ndocs two\n', 'Touch the docs group only');
    const afterSibling = await ctx.lazy(['regions', taskId]);
    expectSuccess(afterSibling);
    expectOutput(afterSibling, 'signed off @');
    expectOutputExcludes(afterSibling, 'STALE');
    expectOutput(afterSibling, 'The core slab');

    // And a commit to the group's OWN file is what stales it: the row keeps
    // the sign-off but reads as approval of code nobody has looked at — the
    // one failure a per-region sign-off exists to prevent.
    commitFile(worktree, 'feature.txt', 'feature one\nfeature two\nfeature three\n', 'Rewrite the core file');
    const afterOwn = await ctx.lazy(['regions', taskId]);
    expectSuccess(afterOwn);
    expectOutput(afterOwn, 'STALE');
    // The sibling group was never signed off, and still is not.
    expectOutput(afterOwn, 'docs-later');
  });

  test('an unknown region is refused by name, not answered with an empty list', async () => {
    const { taskId } = await presentedTask(ctx);

    const result = await ctx.lazy(['regions', taskId, '--region', 'nope']);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("No region 'nope' in this task's cover (3 region(s))");
  });

  test('scopes a real diff to one group\'s files, and refuses an unknown one', async () => {
    const { taskId } = await presentedTask(ctx);

    const all = await ctx.lazy(['diff', taskId, '--full']);
    expectSuccess(all);
    expectOutput(all, 'feature.txt');
    expectOutput(all, 'notes.md');
    expectOutput(all, 'extra.txt');

    const scoped = await ctx.lazy(['diff', taskId, '--full', '--region', 'core-first']);
    expectSuccess(scoped);
    expectOutput(scoped, 'feature.txt');
    expectOutputExcludes(scoped, 'notes.md');
    expectOutputExcludes(scoped, 'extra.txt');

    // The residual group scopes too — an unclaimed file is reviewable the
    // same way, through the group the partition put it in.
    const residual = await ctx.lazy(['diff', taskId, '--full', '--region', 'other-changes']);
    expectSuccess(residual);
    expectOutput(residual, 'extra.txt');
    expectOutputExcludes(residual, 'feature.txt');

    const unknown = await ctx.lazy(['diff', taskId, '--full', '--region', 'nope']);
    expect(unknown.exitCode).not.toBe(0);
    expect(`${unknown.stdout}${unknown.stderr}`).not.toContain('+feature one');
  });
});

describe('lazy regions — a task whose agent filed no walkthrough', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lists nothing, with the hint — and refuses to scope by a made-up id', async () => {
    // INVARIANT: a human surface reads the PRESENTATION, never a carve
    // guessed from git (§6.3), so a task whose final turn has not filed a
    // walkthrough yet answers with empty regions and the hint — never a
    // carve, and never an error that reads as a bug in the command.
    const taskId = await unpresentedTask(ctx);

    const listed = await ctx.lazy(['regions', taskId]);
    expect(listed.exitCode).toBe(0);
    expectOutput(listed, '0 region(s)');
    expectOutput(listed, 'no presented regions yet');

    const addressed = await ctx.lazy(['regions', taskId, '--region', 'core-first']);
    expect(addressed.exitCode).not.toBe(0);
    // The query's resolver refuses by name, with the zero the listing shows.
    expect(`${addressed.stdout}${addressed.stderr}`).toContain(
      "No region 'core-first' in this task's cover (0 region(s))",
    );

    // The overlay verbs refuse the same way, naming the same hint.
    const overlay = await ctx.lazy([
      'regions', taskId, '--region', 'core-first', '--owner', 'ierceg',
    ]);
    expect(overlay.exitCode).not.toBe(0);
    expect(`${overlay.stdout}${overlay.stderr}`).toContain('No presented regions for this task yet.');

    // And a diff scoped to a region that does not exist refuses loudly
    // instead of rendering the whole diff.
    const scoped = await ctx.lazy(['diff', taskId, '--full', '--region', 'core-first']);
    expect(scoped.exitCode).not.toBe(0);
    expect(`${scoped.stdout}${scoped.stderr}`).not.toContain('+');
  });

  // INVARIANT (this task): a task WITH CHILDREN presents by those children,
  // derived, with no walkthrough and no model turn. "What has landed and what
  // is still out" is the question a hub raises, and the accepted children are
  // already carved off their accept tags — so a hub never gets the empty-cover
  // hint a childless task gets, and never pays a turn for a walkthrough of
  // every feature in a release.
  test('a hub with no walkthrough presents its children, and names the ones still out', async () => {
    const hubId = await unpresentedTask(ctx);

    const child = await ctx.lazy([
      'create', '--goal', 'Landed child', '--prompt', 'Add a file', '--parent', hubId,
    ]);
    expectSuccess(child);
    const childId = child.stdout.match(/([a-f0-9]{8})/)![1]!;
    expectSuccess(await ctx.lazyMocked(['start', childId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', childId])).exitCode).toBe(0);
    const childWorktree = worktreePathFor(ctx.root, childId);
    commitFile(childWorktree, 'child-feature.txt', 'from the child\n', 'Add child-feature.txt');
    expectSuccess(await ctx.lazy(['accept', childId, '--yes']));

    // A second child that has NOT landed — the listing must say so, because
    // its work is not in any region above.
    const outstanding = await ctx.lazy([
      'create', '--goal', 'Still going', '--prompt', 'Not done', '--parent', hubId,
    ]);
    expectSuccess(outstanding);

    const listed = await ctx.lazy(['regions', hubId]);
    expectSuccess(listed);
    // NOT the childless answer.
    expectOutputExcludes(listed, 'no presented regions yet');
    // The derived map says it is derived, and names what is still out.
    expectOutput(listed, 'nobody wrote this walkthrough');
    expectOutput(listed, '1 child task not accepted into this branch yet');

    // INVARIANT (review ba94e310): SIGN-OFF IS REFUSED on a derived map, and
    // the refusal is the whole point. Those rows are carve units with a commit
    // range rather than a file-set claim, so there is no per-region content to
    // hash — the approval would be stored as '' and read back as "never signed
    // off" on every later visit, while the command reported success. A human
    // decision discarded under a surface that said it was taken is the exact
    // failure per-region sign-off exists to prevent.
    const regionId = JSON.parse(
      (await ctx.lazy(['regions', hubId, '--json'])).stdout,
    ).regions[0].id as string;
    const signed = await ctx.lazy(['regions', hubId, '--region', regionId, '--sign-off']);
    expect(signed.exitCode).not.toBe(0);
    expect(`${signed.stdout}${signed.stderr}`).toContain('DERIVED map');

    // Naming still works — it is keyed on the region id and stores fine.
    expectSuccess(await ctx.lazy([
      'regions', hubId, '--region', regionId, '--name', 'The landed child',
    ]));
    expectOutput(await ctx.lazy(['regions', hubId]), 'The landed child');
  }, 120_000);

  // INVARIANT (review 6ac1a2b8): an authored walkthrough outranks the derived
  // children map only while it is CURRENT.
  //
  // This is the combination neither earlier test reached: a walkthrough AND a
  // landed child. Before this rule the two halves of the hub rule trapped it —
  // `wrapUpPlanFor` drops `present` from both lists for a hub, so it never
  // authors another; and "authored always wins" made the derived map
  // unreachable — so whichever walkthrough happened to be on record when the
  // first child landed was served for the life of the task, with every later
  // file in "Other changes" and nothing saying the map predated the branch.
  //
  // The path is ordinary: a parent that did its own work, filed a walkthrough
  // while it was still a leaf, and later accepted a subtask. That is exactly
  // what this test builds.
  test('a hub whose walkthrough predates its head falls back to the children map', async () => {
    const { taskId } = await presentedTask(ctx);

    // The walkthrough IS being served while the task is a leaf — so the
    // assertions below are about the CHANGE, not about it never having worked.
    expectOutput(await ctx.lazy(['regions', taskId]), 'core-first');

    // One child lands, which both makes it a hub and moves its head past the
    // walkthrough's stamp.
    await landChild(ctx, taskId, 'Landed child', 'child-feature.txt');

    const listed = await ctx.lazy(['regions', taskId]);
    expectSuccess(listed);
    // The derived map, not the frozen walkthrough.
    expectOutput(listed, 'nobody wrote this walkthrough');
    expectOutputExcludes(listed, 'core-first');
    // And it SAYS why, naming the head the walkthrough was written at — a
    // reader who remembers filing one is owed that rather than silence.
    expectOutput(listed, 'An authored walkthrough is on record');
    expectOutput(listed, 'branch has moved since');
  }, 120_000);

  // The other half of the same rule, and the reason it is a currency test
  // rather than a ban: a hub that files a walkthrough AT its current head is
  // presented by it. The design's "a hub agent MAY still attach a
  // presentation" is about exactly this, and it must keep working — otherwise
  // the rule would read as "a hub can never author one", which is not what was
  // decided.
  test('a hub whose walkthrough is at the current head still wins', async () => {
    const { taskId, worktree } = await presentedTask(ctx);
    await landChild(ctx, taskId, 'Landed child', 'child-feature.txt');
    // Re-filed AFTER the accept, so the stamp is the head the reviewer sees.
    await fileWalkthrough(ctx, taskId, worktree);

    const listed = await ctx.lazy(['regions', taskId]);
    expectSuccess(listed);
    expectOutput(listed, 'core-first');
    expectOutputExcludes(listed, 'nobody wrote this walkthrough');
    expectOutputExcludes(listed, 'An authored walkthrough is on record');
  }, 120_000);

  // INVARIANT (review f2c997a9): a task whose only subtask was CLOSED is not a
  // hub. `lazy close` and `lazy reject` both land on `abandoned`, so without
  // this a leaf task that spawned one exploratory subtask would be routed to
  // the derived map forever — losing the walkthrough this change promises on
  // every human-facing park, and carrying a note promising a child that can
  // never land.
  test('a task whose only child was closed is not treated as a hub', async () => {
    const { taskId } = await presentedTask(ctx);

    const child = await ctx.lazy([
      'create', '--goal', 'Exploratory', '--prompt', 'Have a look', '--parent', taskId,
    ]);
    expectSuccess(child);
    const childId = child.stdout.match(/([a-f0-9]{8})/)![1]!;
    expectSuccess(await ctx.lazy(['close', childId, '--reason', 'Not needed after all', '--yes']));

    // The authored walkthrough still wins, exactly as it did before the child
    // existed — no derived map, and no note about a child that will not land.
    const listed = await ctx.lazy(['regions', taskId]);
    expectSuccess(listed);
    expectOutput(listed, 'core-first');
    expectOutputExcludes(listed, 'nobody wrote this walkthrough');
    expectOutputExcludes(listed, 'not accepted into this branch yet');
  }, 120_000);
});