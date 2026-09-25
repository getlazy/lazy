/**
 * E2E for the `lazy_regions` MCP tool and `lazy_diff`'s `region` parameter,
 * driven through a real `lazy-agent mcp` subprocess and a real daemon.
 *
 * TWO SOURCES, ONE SHAPE (final-turn design §6.3). By default the tool reads
 * the walkthrough the task's final turn DECLARED — the same groups every
 * human surface navigates by, slugged to stable ids, with a residual
 * "Other changes" region for anything no group claimed. `provenance: true`
 * opts into the git carve instead: the agent-facing hint that tells a
 * present step where the branch's files came from, whose response alone
 * carries the carve-mode extras (areas, superseded, computing).
 *
 * The pair is the point: an agent reviewing a large branch lists the regions
 * once and then reads them one at a time. Either half alone is not the
 * feature.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { runMcpSession, mcpPayload as payload } from '../helpers/mcp-session';

/**
 * A task whose agent filed a real walkthrough through the MCP report tool:
 * three files on the branch, two groups claiming two of them. The declared
 * order (core first, docs second) is deliberately the REVERSE of the display
 * order the surfaces sort to, so a read of the raw cover is distinguishable
 * from a re-sorted copy.
 */
async function presentedTask(ctx: TestContext): Promise<{ taskId: string; worktree: string }> {
  const taskId = await createTask(ctx, 'MCP regions walkthrough', 'Some work');
  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);
  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }

  const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktree, 'alpha.txt'), 'alpha one\nalpha two\n');
  writeFileSync(join(worktree, 'notes.md'), 'docs one\n');
  writeFileSync(join(worktree, 'extra.txt'), 'extra one\n');
  expect(ctx.git('-C', worktree, 'add', 'alpha.txt', 'notes.md', 'extra.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktree, 'commit', '-m', 'Add alpha, notes, extra').exitCode).toBe(0);

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
          sections: [{ kind: 'what_was_done', body: 'Shipped the MCP regions fixture' }],
          presentation: {
            groups: [
              { title: 'Alpha work', tier: 'core', items: [{ kind: 'file', file: 'alpha.txt' }] },
              { title: 'Docs pages', tier: 'docs', items: [{ kind: 'file', file: 'notes.md' }] },
            ],
          },
        },
      },
    },
  ]);

  return { taskId, worktree };
}

/** A task whose agent filed no walkthrough — the default read has an answer for that. */
async function unpresentedTask(ctx: TestContext): Promise<string> {
  const taskId = await createTask(ctx, 'MCP unpresented', 'Some work');
  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);
  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }
  const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktree, 'alpha.txt'), 'alpha one\n');
  expect(ctx.git('-C', worktree, 'add', 'alpha.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktree, 'commit', '-m', 'Add alpha only').exitCode).toBe(0);
  return taskId;
}

/** A branch carrying two merged side branches, each with two authors. */
async function carveTask(ctx: TestContext): Promise<string> {
  const taskId = await createTask(ctx, 'MCP regions carve', 'Do work');
  await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  await ctx.lazy(['wait', taskId]);

  const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: worktree });
    if (r.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr)}`);
    }
  };
  git('config', 'user.email', 'test@lazy.test');
  git('config', 'user.name', 'Lazy Test');
  const start = new TextDecoder()
    .decode(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: worktree }).stdout)
    .trim();

  for (const [branch, file, author] of [
    ['side-alpha', 'alpha.txt', 'Ada Lovelace <ada@test>'],
    ['side-beta', 'beta.txt', 'Grace Hopper <grace@test>'],
  ] as const) {
    git('checkout', '-q', '-b', branch, start);
    writeFileSync(join(worktree, file), `${file} one\n${file} two\n${file} three\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `${branch}: first`, '--no-verify');
    writeFileSync(join(worktree, file), `${file} one\n${file} two\n${file} three\n${file} four\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `${branch}: second`, '--author', author, '--no-verify');
    git('checkout', '-q', '-');
    git('merge', '-q', '--no-ff', '-m', `Merge pull request #1 from acme/${branch}`, branch);
    git('branch', '-q', '-D', branch);
  }
  return taskId;
}

/**
 * A HUB-shaped branch: enough accepted units that the coarse grouping kicks
 * in, spread over three path areas.
 */
async function hubShapedTask(ctx: TestContext): Promise<string> {
  const taskId = await createTask(ctx, 'MCP hub regions', 'Do work');
  await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  await ctx.lazy(['wait', taskId]);

  const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: worktree });
    if (r.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(r.stderr)}`);
    }
  };
  git('config', 'user.email', 'test@lazy.test');
  git('config', 'user.name', 'Lazy Test');

  const areas = ['src/alpha', 'src/beta', 'docs'];
  for (let i = 0; i < 9; i++) {
    const path = `${areas[i % areas.length]}/file-${i}.ts`;
    mkdirSync(join(worktree, path, '..'), { recursive: true });
    writeFileSync(join(worktree, path), `unit ${i}\nline two\nline three\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `Accept task unit-${i}: Unit number ${i}`, '--no-verify');
  }
  return taskId;
}

describe('lazy_regions (MCP)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('by default reads the DECLARED walkthrough: the cover, one region in full, then a diff scoped to it', async () => {
    const { taskId, worktree } = await presentedTask(ctx);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/list', id: 2, params: {} },
      { method: 'tools/call', id: 3, params: { name: 'lazy_regions', arguments: { task_id: taskId } } },
      {
        method: 'tools/call',
        id: 4,
        params: { name: 'lazy_regions', arguments: { task_id: taskId, region: 'alpha-work' } },
      },
      {
        method: 'tools/call',
        id: 5,
        params: { name: 'lazy_diff', arguments: { task_id: taskId, full: true, region: 'alpha-work' } },
      },
    ]);

    // The tool is on the advertised surface — an agent that cannot see it
    // cannot use it, whatever the handler does.
    const tools = (responses.find(r => r.id === 2)?.result?.tools ?? []) as Array<{ name: string }>;
    expect(tools.map(t => t.name)).toContain('lazy_regions');

    // The listing is the walkthrough in the agent's DECLARED order, residual
    // last: the order is the story to review by, and this fixture declares it
    // reverse of display order on purpose.
    const cover = payload(responses.find(r => r.id === 3));
    expect(cover.computing).toBeUndefined();
    expect(cover.region_count as number).toBe(3);
    const rows = cover.regions as Array<{ id: string; provenance: string; depth: number; shared_files: unknown[] }>;
    expect(rows.map(r => r.id)).toEqual(['alpha-work', 'docs-pages', 'other-changes']);
    expect(rows.every(r => r.provenance === 'presentation')).toBe(true);
    expect(rows.every(r => r.depth === 0)).toBe(true);
    // Summaries carry no file lists — the map before the detail.
    expect(rows[0]).not.toHaveProperty('files_list');

    const one = payload(responses.find(r => r.id === 4));
    const region = one.region as { files: string[]; shared_files: unknown[]; id: string; unit: string };
    expect(region.id).toBe('alpha-work');
    expect(region.unit).toBe('presentation');
    // INVARIANT: `files` is the region's OWNED share — the partition — so a
    // sibling's file is never in it, and a walkthrough row attributes to
    // itself (the walkthrough IS the attribution).
    expect(region.files).toEqual(['alpha.txt']);
    expect(region.shared_files).toEqual([]);
    // The named row carries the hash its sign-off is current against.
    expect(one.region_hash as string).toBeTruthy();

    // And the whole cover partitions: no file is claimed by two top-level
    // regions, whatever the reviewer opens.
    const everyOwned = (cover.regions as Array<{ depth: number; files: number }>)
      .filter(r => r.depth === 0)
      .reduce((n, r) => n + r.files, 0);
    expect(everyOwned).toBe(3);

    const diff = payload(responses.find(r => r.id === 5));
    expect(diff.region).toBe('alpha-work');
    expect(diff.diff as string).toContain('alpha.txt');
    expect(diff.diff as string).toContain('alpha one');
    expect(diff.diff as string).not.toContain('docs one');
  });

  test('a task whose agent filed no walkthrough answers with the note, immediately, never an error', async () => {
    // INVARIANT: the first listing of a task with no walkthrough costs a
    // report read, not a git walk — it answers at once with an explanatory
    // note instead of spending the caller's seconds deriving a partition the
    // agent never asked for, and instead of an error reading as "this task
    // cannot be reviewed".
    const taskId = await unpresentedTask(ctx);

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_regions', arguments: { task_id: taskId } } },
    ]);

    const cover = payload(responses.find(r => r.id === 2));
    // "Computing" is the carve's answer, never the walkthrough's — a
    // presentation read is instant however big the branch.
    expect(cover.computing).toBeUndefined();
    expect((cover.regions as unknown[]).length).toBe(0);
    expect(cover.region_count as number).toBe(0);
    expect((cover.notes as string[]).join('\n')).toContain('no presented regions yet');
  });

  test('provenance: true reads the git carve — the first listing answers "computing", a named region waits', async () => {
    // INVARIANT: the carve is a read on a task this agent may not even own,
    // and must never spend the caller's seconds walking somebody else's git
    // history. A listing answers at once with `computing` while the background
    // carve runs; NAMING a region is a different question, and it WAITS —
    // answering "still computing" to "show me region X" reads as "there is no
    // region X".
    const taskId = await carveTask(ctx);

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 3, params: { name: 'lazy_regions', arguments: { task_id: taskId, provenance: true } } },
      {
        method: 'tools/call',
        id: 4,
        params: {
          name: 'lazy_regions',
          arguments: { task_id: taskId, provenance: true, region: 'branch:side-alpha' },
        },
      },
      {
        method: 'tools/call',
        id: 5,
        params: {
          name: 'lazy_diff',
          arguments: { task_id: taskId, region: 'branch:side-alpha', full: true },
        },
      },
      // The listing again, now that call 4 has waited for the carve.
      { method: 'tools/call', id: 6, params: { name: 'lazy_regions', arguments: { task_id: taskId, provenance: true } } },
    ]);

    // The first listing: computing, not a silent wait and not an error.
    const first = payload(responses.find(r => r.id === 3));
    expect(first.computing).toBe(true);
    expect((first.regions as unknown[]).length).toBe(0);

    // Naming a region waits for the real carve.
    const one = payload(responses.find(r => r.id === 4));
    const region = one.region as { files: string[]; shared_files: unknown[]; id: string };
    expect(region.id).toBe('branch:side-alpha');
    expect(region.files).toContain('alpha.txt');
    // INVARIANT: `files` is the region's OWNED share — the partition — so a
    // sibling's file is never in it.
    expect(region.files).not.toContain('beta.txt');

    // Scoping a DIFF is the walkthrough's privilege alone: `lazy_diff`'s
    // region parameter resolves against the DECLARED groups, so a carve-unit
    // ref is refused here — an agent scopes diffs by the groups it went on
    // to declare, reading a carve unit in full through this tool instead.
    const refused = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_diff',
          arguments: { task_id: taskId, region: 'branch:side-alpha', full: true },
        },
      },
    ]);
    const diffReply = refused.find(r => r.id === 2);
    expect(diffReply?.result?.isError === true || diffReply?.error !== undefined).toBe(true);
    expect(JSON.stringify(diffReply)).toContain('branch:side-alpha');
    // And the cover now lists the carved units, with no "computing" echo.
    const cover = payload(responses.find(r => r.id === 6));
    expect(cover.computing).toBeUndefined();
    expect(cover.region_count as number).toBeGreaterThan(2);
    const rows = cover.regions as Array<{ id: string; files: number }>;
    expect(rows.map(r => r.id)).toContain('branch:side-alpha');
    expect(rows.map(r => r.id)).toContain('branch:side-beta');
  });
  test('a hub (provenance) comes back with the area axis, and an area never scopes a diff', async () => {
    // INVARIANT: an agent authoring a walkthrough for a release hub gets the
    // coarse grouping too. Three hundred provenance rows is an accurate map
    // and a useless one to author groups from; areas are the axis the branch
    // is actually split along, and they are selectable exactly where a region
    // id is. This axis is the carve's alone — the walkthrough read never
    // carries it.
    const taskId = await hubShapedTask(ctx);

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      // Naming a region waits for the first carve, so the listing below is not
      // the "computing" answer.
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_regions',
          arguments: { task_id: taskId, provenance: true, region: 'area:src/alpha' },
        },
      },
      {
        method: 'tools/call',
        id: 3,
        params: { name: 'lazy_regions', arguments: { task_id: taskId, provenance: true } },
      },
    ]);

    const area = payload(responses.find(r => r.id === 2));
    const selected = area.region as { id: string; unit: string; files: string[] };
    expect(selected.id).toBe('area:src/alpha');
    expect(selected.unit).toBe('area');
    expect(selected.files.every(f => f.startsWith('src/alpha/'))).toBe(true);

    const cover = payload(responses.find(r => r.id === 3));
    const areas = cover.areas as Array<{ id: string; files: number; region_ids: string[] }>;
    expect(areas.map(a => a.id)).toContain('area:src/alpha');
    expect(areas.map(a => a.id)).toContain('area:docs');
    // Areas partition the same files, so they sum to what the regions do.
    const areaFiles = areas.reduce((n, a) => n + a.files, 0);
    const regionFiles = (cover.regions as Array<{ depth: number; files: number }>)
      .filter(r => r.depth === 0)
      .reduce((n, r) => n + r.files, 0);
    expect(areaFiles).toBe(regionFiles);

    // Scoping a DIFF is the walkthrough's privilege alone: `lazy_diff`'s
    // region parameter resolves against the DECLARED groups (its schema says
    // so, and it takes no provenance flag at all), so a carve-unit ref —
    // like an area ref — reaches the reading aid above but never the diff.
    // An agent scopes diffs by the groups it went on to declare.
    const refused = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_diff',
          arguments: { task_id: taskId, region: 'area:src/alpha', full: true },
        },
      },
    ]);
    const reply = refused.find(r => r.id === 2);
    expect(reply?.result?.isError === true || reply?.error !== undefined).toBe(true);
    expect(JSON.stringify(reply)).toContain('area:src/alpha');
  });

  test('depth and limit page the cover; a named region is still found', async () => {
    const { taskId, worktree } = await presentedTask(ctx);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      { method: 'initialize', id: 1, params: {} },
      // The presented cover is stored state — no warming carve is needed, so
      // the paging calls below are about paging rather than about the cover
      // not existing yet.
      { method: 'tools/call', id: 2, params: { name: 'lazy_regions', arguments: { task_id: taskId, depth: 0 } } },
      {
        method: 'tools/call',
        id: 3,
        params: {
          name: 'lazy_regions',
          arguments: { task_id: taskId, limit: 1, region: 'docs-pages' },
        },
      },
    ]);

    const shallow = payload(responses.find(r => r.id === 2));
    const rows = shallow.regions as Array<{ depth: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.depth === 0)).toBe(true);

    const paged = payload(responses.find(r => r.id === 3));
    expect((paged.regions as unknown[]).length).toBe(1);
    expect(paged.truncated).toBe(true);
    expect(paged.region_count as number).toBeGreaterThan(1);
    // INVARIANT: a named region is looked up in the WHOLE cover, never in the
    // page. Paging must not be able to report a region as missing.
    expect((paged.region as { id: string }).id).toBe('docs-pages');
  });

  test('an unknown region is a tool error, never a silently unfiltered diff', async () => {
    const { taskId, worktree } = await presentedTask(ctx);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: { name: 'lazy_diff', arguments: { task_id: taskId, full: true, region: 'nope' } },
      },
    ]);

    const reply = responses.find(r => r.id === 2);
    const text = JSON.stringify(reply);
    expect(reply?.result?.isError === true || reply?.error !== undefined).toBe(true);
    expect(text).toContain('nope');
  });

  test('INVARIANT: a sign-off is judged against the REGION\'s OWN content, not the branch head. The walkthrough rows this tool returns are keyed to their own files, so a commit moving the branch for an UNRELATED reason — a sibling group\'s file — leaves the approval standing, and only a change to the signed-off group\'s own files stales it. Head-keyed staleness (what the carve answered by before) rendered a plain "signed off" row stale the moment ANY commit moved the branch, teaching reviewers to ignore the one signal that matters.', async () => {
    const { taskId, worktree } = await presentedTask(ctx);

    // Sign off one group. The presented cover is stored state, so the row is
    // current the moment the sign-off lands.
    const signed = await ctx.lazy(['regions', taskId, '--region', 'alpha-work', '--sign-off']);
    expect(signed.exitCode).toBe(0);

    // Move the branch WITHOUT touching that group's files — a sibling group's
    // file is the exact case the old head-keyed check got wrong.
    writeFileSync(join(worktree, 'notes.md'), 'docs one\ndocs two\n');
    expect(ctx.git('-C', worktree, 'add', 'notes.md').exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', 'a commit to a sibling group').exitCode).toBe(0);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_regions', arguments: { task_id: taskId } } },
    ]);

    const result = payload(responses.find(r => r.id === 2));
    const rows = result.regions as Array<{ id: string; signed_off_sha?: string; signed_off_current?: boolean }>;
    const alpha = rows.find(r => r.id === 'alpha-work');
    expect(alpha?.signed_off_sha).toBeTruthy();
    // Its own files are untouched, so the approval survives.
    expect(alpha?.signed_off_current).toBe(true);

    // Now a commit to the signed-off group's OWN file stales it.
    writeFileSync(join(worktree, 'alpha.txt'), 'alpha one\nalpha two\nalpha three\n');
    expect(ctx.git('-C', worktree, 'add', 'alpha.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', 'a commit to the signed-off group').exitCode).toBe(0);

    const later = await runMcpSession(ctx.root, taskId, worktree, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_regions', arguments: { task_id: taskId } } },
    ]);
    const after = payload(later.find(r => r.id === 2));
    const staleRows = after.regions as Array<{ id: string; signed_off_current?: boolean }>;
    expect(staleRows.find(r => r.id === 'alpha-work')?.signed_off_current).toBe(false);
  });

  test('INVARIANT: a depth the tool cannot use is REFUSED, never silently replaced. The schema advertises type ["number","string"] so that "all" works, which makes depth: "2" the obvious next thing a caller tries — and it used to fall through to the default while the response echoed "depth": 0, reading as confirmation. An agent then concludes the hub has no nested regions.', async () => {
    const { taskId, worktree } = await presentedTask(ctx);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      { method: 'initialize', id: 1, params: {} },
      // A numeric STRING is understood — the caller meant a number.
      { method: 'tools/call', id: 3, params: { name: 'lazy_regions', arguments: { task_id: taskId, depth: '1' } } },
      // Anything else is an error naming the value, not a quiet depth 0.
      { method: 'tools/call', id: 4, params: { name: 'lazy_regions', arguments: { task_id: taskId, depth: 'deep' } } },
      { method: 'tools/call', id: 5, params: { name: 'lazy_regions', arguments: { task_id: taskId, limit: 'lots' } } },
    ]);

    const coerced = payload(responses.find(r => r.id === 3));
    expect(coerced.depth).toBe(1);

    // A non-numeric depth reaches the handler (the schema allows strings, for
    // "all") and is refused there, naming the value the caller sent.
    const badDepth = JSON.stringify(responses.find(r => r.id === 4));
    expect(badDepth).toContain('deep');
    expect(badDepth).toContain('error');
    // An error, not a successful answer to a different question.
    expect(badDepth).not.toContain('"depth":0');

    // `limit` is typed as a plain number, so the MCP schema refuses a string
    // before the handler sees it. Different layer, same outcome: refused and
    // named, never silently dropped to the default.
    const badLimit = JSON.stringify(responses.find(r => r.id === 5));
    expect(badLimit).toContain('error');
    expect(badLimit).toContain('limit');
  });

  test('a group claiming a DIRECTORY and a GLOB is one region owning every file it matched', async () => {
    // INVARIANT: a file item may be a directory or a glob, and it claims every
    // changed file it matches as ONE item. This is what makes a release-sized
    // branch presentable at all — the 64-item ceiling put ~200 of a 277-file
    // hub's files back into the residual the walkthrough exists to replace.
    const taskId = await createTask(ctx, 'MCP regions globs', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    mkdirSync(join(worktree, 'src', 'review'), { recursive: true });
    mkdirSync(join(worktree, 'test', 'e2e'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'review', 'report.ts'), 'export const a = 1;\n');
    writeFileSync(join(worktree, 'src', 'review', 'policy.ts'), 'export const b = 2;\n');
    writeFileSync(join(worktree, 'test', 'e2e', 'regions-web.test.ts'), 'test one\n');
    writeFileSync(join(worktree, 'test', 'e2e', 'regions-cli.test.ts'), 'test two\n');
    writeFileSync(join(worktree, 'leftover.txt'), 'unclaimed\n');
    expect(ctx.git('-C', worktree, 'add', '-A').exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', 'Add review code, region tests, a leftover').exitCode).toBe(0);

    const reported = await runMcpSession(ctx.root, taskId, worktree, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Claimed masses by pattern' }],
            presentation: {
              groups: [
                {
                  title: 'The review code',
                  tier: 'core',
                  items: [{ kind: 'file', file: 'src/review/', note: 'the walkthrough code' }],
                },
                {
                  title: 'Region tests',
                  tier: 'tests',
                  items: [{ kind: 'file', file: 'test/e2e/regions*.test.ts' }],
                },
              ],
            },
          },
        },
      },
      { method: 'tools/call', id: 3, params: { name: 'lazy_regions', arguments: { task_id: taskId } } },
      {
        method: 'tools/call',
        id: 4,
        params: { name: 'lazy_regions', arguments: { task_id: taskId, region: 'the-review-code' } },
      },
      {
        method: 'tools/call',
        id: 5,
        params: { name: 'lazy_diff', arguments: { task_id: taskId, full: true, region: 'region-tests' } },
      },
    ]);

    // The stored walkthrough carries the pattern AND what it resolved to, so
    // the partition is the same set of files after the next commit.
    const report = payload(reported.find(r => r.id === 2));
    const claim = (report.presentation as { groups: Array<{ items: Array<{ file: string; matched?: string[] }> }> })
      .groups[0]!.items[0]!;
    expect(claim.file).toBe('src/review/');
    expect(claim.matched?.sort()).toEqual(['src/review/policy.ts', 'src/review/report.ts']);

    const cover = payload(reported.find(r => r.id === 3));
    const rows = cover.regions as Array<{ id: string; files: number; note?: string }>;
    expect(rows.map(r => r.id)).toEqual(['the-review-code', 'region-tests', 'other-changes']);
    // One item, two files: the group is a region owning both.
    expect(rows[0]!.files).toBe(2);
    expect(rows[1]!.files).toBe(2);
    expect(rows[2]!.files).toBe(1);

    const one = payload(reported.find(r => r.id === 4));
    expect((one.region as { files: string[] }).files.sort()).toEqual([
      'src/review/policy.ts',
      'src/review/report.ts',
    ]);

    // The residual states how much of the change the walkthrough did not name.
    expect(rows[2]!.note).toContain('1 of 5 changed files');

    // A diff scoped to a glob-claimed region shows exactly its files.
    const diff = payload(reported.find(r => r.id === 5));
    expect(diff.diff as string).toContain('regions-web.test.ts');
    expect(diff.diff as string).toContain('regions-cli.test.ts');
    expect(diff.diff as string).not.toContain('leftover.txt');
  });

  test('a changed path containing glob punctuation is claimed verbatim, not read as a glob', async () => {
    // INVARIANT: a value that IS one of the task's changed paths is a literal
    // claim, before any pattern interpretation. `app/blog/[slug]/page.tsx` is
    // the standard Next.js/SvelteKit dynamic route, and read as a glob its
    // `[slug]` is a character class matching nothing — which failed the whole
    // report call, on a file item that is a plain correct path with no other
    // spelling available.
    const taskId = await createTask(ctx, 'MCP regions dynamic route', 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    const route = 'app/blog/[slug]/page.tsx';
    mkdirSync(join(worktree, 'app', 'blog', '[slug]'), { recursive: true });
    writeFileSync(join(worktree, route), 'export default function Page() {}\n');
    writeFileSync(join(worktree, 'app', 'layout.tsx'), 'export default function Layout() {}\n');
    expect(ctx.git('-C', worktree, 'add', '-A').exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', 'Add a dynamic route').exitCode).toBe(0);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Added a route' }],
            presentation: {
              groups: [
                {
                  title: 'The route',
                  tier: 'core',
                  items: [{ kind: 'file', file: route }, { kind: 'file', file: 'app/layout.tsx' }],
                },
              ],
            },
          },
        },
      },
      { method: 'tools/call', id: 3, params: { name: 'lazy_regions', arguments: { task_id: taskId } } },
    ]);

    // The call SUCCEEDS — this used to fail outright, losing the whole report.
    const report = responses.find(r => r.id === 2);
    expect(report?.result?.isError === true || report?.error !== undefined).toBe(false);
    const stored = payload(report);
    const item = (stored.presentation as { groups: Array<{ items: Array<{ file: string; matched?: string[] }> }> })
      .groups[0]!.items[0]!;
    expect(item.file).toBe(route);
    expect(item.matched).toBeUndefined();

    // And the region owns it, so the partition is complete.
    const cover = payload(responses.find(r => r.id === 3));
    const rows = cover.regions as Array<{ id: string; files: number }>;
    expect(rows.map(r => r.id)).toEqual(['the-route']);
    expect(rows[0]!.files).toBe(2);
  });

  test('a pattern matching nothing this task changed is refused, naming it', async () => {
    // INVARIANT (external-surfaces-validate-inputs): a typo'd pattern must
    // not be stored as a group that claims nothing — the group's real files
    // would show up in "Other changes" with nothing saying why.
    const { taskId, worktree } = await presentedTask(ctx);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'A typo in the pattern' }],
            presentation: {
              groups: [
                { title: 'Nothing here', tier: 'core', items: [{ kind: 'file', file: 'src/reivew/' }] },
              ],
            },
          },
        },
      },
    ]);

    const reply = responses.find(r => r.id === 2);
    expect(reply?.result?.isError === true || reply?.error !== undefined).toBe(true);
    expect(JSON.stringify(reply)).toContain('src/reivew/');
  });

  test('a cap refusal never costs the walkthrough already filed for that turn', async () => {
    // INVARIANT: recording a refusal must not take the revocation path. The
    // fixture's agent already filed a good walkthrough; it then sends a
    // bigger one that trips a cap and does NOT re-send. If the refusal write
    // dropped the stored walkthrough, the reviewer would open the task and
    // find no regions at all — the "unregioned branch" failure this feature
    // exists to prevent, arriving through the code that reports the cap.
    const { taskId, worktree } = await presentedTask(ctx);

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'A walkthrough that does not fit' }],
            presentation: {
              groups: Array.from({ length: 33 }, (_, i) => ({
                title: `Group ${i}`,
                tier: 'core',
                items: [{ kind: 'prose', body: `Story ${i}` }],
              })),
            },
          },
        },
      },
      // No re-send: this is the turn ending right here.
      { method: 'tools/call', id: 3, params: { name: 'lazy_regions', arguments: { task_id: taskId } } },
    ]);

    const refused = responses.find(r => r.id === 2);
    expect(refused?.result?.isError === true || refused?.error !== undefined).toBe(true);
    // The error says what was and was not stored, so the agent does not have
    // to guess whether its earlier walkthrough survived.
    expect(JSON.stringify(refused)).toContain('was NOT stored');

    const cover = payload(responses.find(r => r.id === 3));
    const rows = cover.regions as Array<{ id: string; note?: string }>;
    // The ORIGINAL walkthrough is still the task's regions.
    expect(rows.map(r => r.id)).toEqual(['alpha-work', 'docs-pages', 'other-changes']);
    // And the cap the agent hit is on the residual row, where a reviewer sees it.
    expect(rows.find(r => r.id === 'other-changes')?.note).toContain('the 32-group cap');
  });

  test('a cap refused with no walkthrough ever filed still names the cap', async () => {
    // The case the record exists for: the agent hits the cap and stops. There
    // is no walkthrough to hang the line on, so it rides the cover notes —
    // "no walkthrough yet" and "the walkthrough was refused for being too
    // big" are different answers, and only the second tells the reviewer to
    // go looking.
    const taskId = await unpresentedTask(ctx);

    const responses = await runMcpSession(ctx.root, taskId, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Could not fit a walkthrough' }],
            presentation: {
              groups: Array.from({ length: 33 }, (_, i) => ({
                title: `Group ${i}`,
                tier: 'core',
                items: [{ kind: 'prose', body: `Story ${i}` }],
              })),
            },
          },
        },
      },
      { method: 'tools/call', id: 3, params: { name: 'lazy_regions', arguments: { task_id: taskId } } },
    ]);

    const cover = payload(responses.find(r => r.id === 3));
    expect((cover.regions as unknown[]).length).toBe(0);
    const notes = (cover.notes as string[]).join('\n');
    expect(notes).toContain('the 32-group cap');
    expect(notes).toContain('no walkthrough because of the cap');
    // The standing "not filed yet" hint is still there — both are true.
    expect(notes).toContain('no presented regions yet');
  });

  test('a walkthrough refused for a cap is RECORDED, and the reviewer sees the cap on the regions', async () => {
    // INVARIANT (engineer, 2026-09-20): a cap that is hit is visible to the
    // REVIEWER, not only to the agent that hit it. Before this, the only
    // signal was a refused tool call the agent quietly worked around, so a
    // walkthrough cut down to fit read exactly like one that chose to leave
    // files out.
    const { taskId, worktree } = await presentedTask(ctx);

    const tooMuchProse = Array.from({ length: 65 }, (_, i) => ({
      kind: 'prose',
      body: `Paragraph number ${i}`,
    }));

    const responses = await runMcpSession(ctx.root, taskId, worktree, [
      { method: 'initialize', id: 1, params: {} },
      {
        method: 'tools/call',
        id: 2,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'A walkthrough that does not fit' }],
            presentation: {
              groups: [{ title: 'Far too much story', tier: 'core', items: tooMuchProse }],
            },
          },
        },
      },
      // The agent's next move: a walkthrough that fits. The record must
      // survive it — the smaller walkthrough is what it explains.
      {
        method: 'tools/call',
        id: 3,
        params: {
          name: 'lazy_report',
          arguments: {
            sections: [{ kind: 'what_was_done', body: 'Rewritten to fit' }],
            presentation: {
              groups: [
                { title: 'Alpha work', tier: 'core', items: [{ kind: 'file', file: 'alpha.txt' }] },
              ],
            },
          },
        },
      },
      { method: 'tools/call', id: 4, params: { name: 'lazy_regions', arguments: { task_id: taskId } } },
    ]);

    const refused = responses.find(r => r.id === 2);
    expect(refused?.result?.isError === true || refused?.error !== undefined).toBe(true);
    expect(JSON.stringify(refused)).toContain('64-snippet/prose-item cap');

    const cover = payload(responses.find(r => r.id === 4));
    const rows = cover.regions as Array<{ id: string; note?: string }>;
    const residual = rows.find(r => r.id === 'other-changes');
    expect(residual?.note).toContain('the 64-snippet/prose-item cap');
    expect(residual?.note).toContain('65 declared');
  });
});
