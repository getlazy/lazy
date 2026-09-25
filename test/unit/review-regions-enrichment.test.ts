/**
 * The half of the carving that depends on lazy's own task history.
 *
 * The git-only fixtures (review-regions-compute.test.ts) deliberately have no
 * store, so they cannot notice a refactor that drops the chunk level, the
 * goal/actor/model enrichment, or the caps. On a lazy project this is the path
 * a reviewer actually sees, so it gets its own suite — driven through the
 * one-method enrichment PORT, which exists precisely so this needs no store
 * and no daemon.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { realpathSync } from 'fs';
import { runGit } from '../../src/utils/git';
import { computeRegionCover, type RegionEnrichment, type RegionTaskFacts } from '../../src/regions/compute';
import { chunkFacts } from '../../src/regions/store-enrichment';
import type { Turn } from '../../src/types';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function write(dir: string, path: string, content: string): Promise<void> {
  const full = join(dir, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

async function commit(dir: string, message: string): Promise<string> {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', message, '--no-verify');
  return git(dir, 'rev-parse', 'HEAD');
}

async function newRepo(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'lazy-regions-enrich-')));
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@lazy.test');
  await git(dir, 'config', 'user.name', 'Lazy Test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

/** A stub store. Every field is what a real one would hand back. */
function stubEnrichment(facts: Record<string, Partial<RegionTaskFacts>>): RegionEnrichment {
  return {
    async lookupTask(code: string) {
      const hit = facts[code];
      if (!hit) return null;
      return {
        code,
        goal: '',
        actors: [],
        agents: [],
        models: [],
        chunks: [],
        ...hit,
      };
    },
  };
}

function turn(over: Partial<Turn>): Turn {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    session_id: 's1',
    sequence: over.sequence ?? 0,
    role: over.role ?? 'agent',
    content: over.content ?? '',
    timestamp: over.timestamp ?? 0,
    usage: null,
    start_sha: null,
    start_sha_work: over.start_sha_work ?? null,
    end_sha_work: over.end_sha_work ?? null,
    end_sha: null,
    ...over,
  } as Turn;
}

describe('chunkFacts — turning turns into diffable chunk ranges', () => {
  test('groups turns into chunks and takes the work-only SHA span of each', () => {
    const facts = chunkFacts([
      turn({ sequence: 1, role: 'human', content: 'do the first thing', actor: 'human' }),
      turn({ sequence: 2, role: 'agent', start_sha_work: 'aaa', end_sha_work: 'bbb' }),
      turn({ sequence: 3, role: 'agent', start_sha_work: 'bbb', end_sha_work: 'ccc' }),
      turn({ sequence: 4, role: 'human', content: 'now the second thing', actor: 'human' }),
      turn({ sequence: 5, role: 'agent', start_sha_work: 'ccc', end_sha_work: 'ddd' }),
    ]);

    expect(facts).toHaveLength(2);
    // INVARIANT: a chunk's range is start_sha_work..end_sha_work across ALL its
    // turns — first start, last end. The work-only SHAs deliberately exclude
    // the pre/post-turn sync merges, so a chunk region shows what the chunk
    // DID rather than what upstream moved underneath it.
    expect(facts[0]).toMatchObject({ from: 'aaa', to: 'ccc' });
    expect(facts[1]).toMatchObject({ from: 'ccc', to: 'ddd' });
    // The boundary turn supplies the intent.
    expect(facts[0]!.title).toBe('do the first thing');
  });

  test('a chunk with no work SHAs is dropped, never given an invented range', () => {
    // INVARIANT: a region pointing at the wrong commits is worse than one
    // region fewer. Legacy turns and turns that crashed before recording have
    // no work SHAs, and must not become a chunk over some other range.
    const facts = chunkFacts([
      turn({ sequence: 1, role: 'human', content: 'legacy', actor: 'human' }),
      turn({ sequence: 2, role: 'agent' }),
    ]);
    expect(facts).toHaveLength(0);
  });

  test('a chunk whose work start and end are the same commit is dropped', () => {
    const facts = chunkFacts([
      turn({ sequence: 1, role: 'human', content: 'no-op turn', actor: 'human' }),
      turn({ sequence: 2, role: 'agent', start_sha_work: 'aaa', end_sha_work: 'aaa' }),
    ]);
    expect(facts).toHaveLength(0);
  });
});

describe('review regions — store enrichment on a real repo', () => {
  let dir: string;
  let base: string;
  let shas: string[];

  beforeEach(async () => {
    dir = await newRepo();
    await write(dir, 'README.md', 'seed\n');
    base = await commit(dir, 'seed');

    // The task's own work lives on its branch and reaches main as ONE squash,
    // which is the shape lazy's accept really produces. It also keeps the
    // chunks' ranges inside the task's own files: a chunk partitions its
    // parent region, so a chunk range covering commits the top level carved
    // elsewhere would have nothing of the parent's to own.
    shas = [];
    await git(dir, 'checkout', '-q', '-b', 'lazy/feature-x', base);
    await write(dir, 'src/one.ts', 'one\n');
    shas.push(await commit(dir, 'work: first'));
    await write(dir, 'src/two.ts', 'two\n');
    shas.push(await commit(dir, 'work: second'));
    await git(dir, 'checkout', '-q', 'main');
    await git(dir, 'merge', '-q', '--squash', 'lazy/feature-x');
    await write(dir, 'src/three.ts', 'three\n');
    shas.push(await commit(dir, 'Accept task feature-x: Build the feature'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a task's goal replaces the commit subject as the region title", async () => {
    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD',
      enrichment: stubEnrichment({
        'feature-x': { goal: 'Build the feature, properly', actors: ['human'], agents: ['claude-code'], models: ['opus'] },
      }),
    });
    const region = cover.regions.find((r) => r.id === 'task:feature-x')!;
    expect(region.title).toBe('Build the feature, properly');
    expect(region.actors).toEqual(['human']);
    expect(region.agents).toEqual(['claude-code']);
    expect(region.models).toEqual(['opus']);
    // And the "no store" note is NOT emitted when a store is present.
    expect(cover.notes.some((n) => n.includes('No store enrichment'))).toBe(false);
  });

  test('turns that differ in model expand the task into its review CHUNKS', async () => {
    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD',
      enrichment: stubEnrichment({
        'feature-x': {
          goal: 'Build the feature',
          models: ['opus', 'sonnet'],
          chunks: [
            { index: 0, title: 'first pass', from: base, to: shas[0]! },
            { index: 1, title: 'second pass', from: shas[0]!, to: shas[1]! },
          ],
        },
      }),
    });

    // INVARIANT: "the turns differ in actor/agent/model" expands into CHUNKS,
    // never into bare commits. It is a statement about intervals of work, and
    // a chunk is exactly that interval; shattering the task into commits
    // instead is what made a carved review unreviewable.
    const chunks = cover.regions.filter((r) => r.unit === 'chunk');
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.id)).toEqual(['chunk:feature-x#0', 'chunk:feature-x#1']);
    expect(chunks[0]!.parent_id).toBe('task:feature-x');
    expect(chunks[0]!.files).toContain('src/one.ts');
    expect(cover.regions.find((r) => r.id === 'task:feature-x')!.expansion_reasons.join(' '))
      .toContain('turns differ in models');
  });

  test('a chunk whose SHAs this worktree does not have is skipped, not invented', async () => {
    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD',
      enrichment: stubEnrichment({
        'feature-x': {
          goal: 'Build the feature',
          models: ['opus', 'sonnet'],
          chunks: [
            { index: 0, title: 'gone', from: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', to: shas[0]! },
            { index: 1, title: 'also gone', from: shas[0]!, to: 'cafebabecafebabecafebabecafebabecafebabe' },
          ],
        },
      }),
    });
    expect(cover.regions.filter((r) => r.unit === 'chunk')).toHaveLength(0);
  });

  test('fewer than two usable chunks is not a carving, and expands nothing', async () => {
    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD',
      enrichment: stubEnrichment({
        'feature-x': {
          goal: 'Build the feature',
          models: ['opus', 'sonnet'],
          chunks: [{ index: 0, title: 'only one', from: base, to: shas[0]! }],
        },
      }),
    });
    // INVARIANT: one chunk is the task again, not a carving of it. It must not
    // be emitted, and the accounting it would have consumed must be given back
    // — otherwise the region cap drifts down on every such task.
    expect(cover.regions.filter((r) => r.unit === 'chunk')).toHaveLength(0);
    expect(cover.regions.find((r) => r.id === 'task:feature-x')!.expansion_reasons).toEqual([]);
  });

  test('the size backstop expands a unit that trips nothing else', async () => {
    // A task branch that SURVIVES, squashed onto main by one person with
    // nothing nested inside it: no structural test fires, so the backstop is
    // the only thing that can open it. Without it, a unit like this at 400
    // files would stay one unreadable region.
    await git(dir, 'checkout', '-q', '-b', 'lazy/big-task', base);
    await write(dir, 'src/big-a.ts', 'a\n');
    await commit(dir, 'big: first');
    await write(dir, 'src/big-b.ts', 'b\n');
    await commit(dir, 'big: second');
    await git(dir, 'checkout', '-q', 'main');
    await git(dir, 'merge', '-q', '--squash', 'lazy/big-task');
    await commit(dir, 'Accept task big-task: A big task');

    const relaxed = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD',
      limits: { sizeBackstopFiles: 1 },
      enrichment: null,
    });
    const big = relaxed.regions.find((r) => r.id === 'task:big-task')!;
    expect(big.expansion_reasons.join(' ')).toContain('size backstop');
    expect(relaxed.regions.filter((r) => r.parent_id === 'task:big-task')).toHaveLength(2);

    // And with the real threshold it stays ONE region — expansion is earned.
    const strict = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD',
      enrichment: null,
    });
    expect(strict.regions.find((r) => r.id === 'task:big-task')!.expansion_reasons).toEqual([]);
    expect(strict.regions.filter((r) => r.parent_id === 'task:big-task')).toHaveLength(0);
  });

  test('the region cap stops the walk and says so', async () => {
    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD',
      // The backstop is what makes the one top-level unit expand at all, so
      // there is something for the cap to stop.
      limits: { maxRegions: 1, sizeBackstopFiles: 1 },
    });
    // INVARIANT: the caps are the guard against a pathological history walking
    // forever. A guard with no test is a guard nobody notices removing — and
    // hitting one must be SAID, never silently truncated.
    expect(cover.regions.length).toBeLessThanOrEqual(1);
    expect(cover.notes.join(' ')).toContain('region cap');
  });

  test('the depth cap stops recursion', async () => {
    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD',
      limits: { sizeBackstopFiles: 1, maxDepth: 0 },
    });
    expect(cover.regions.every((r) => r.depth === 0)).toBe(true);
  });

  test('a merge of a stacked parent that has since been accepted is a sync', async () => {
    // The residual case git alone cannot see. A stacked parent's commits are
    // NOT ancestors of the base — its accept SQUASHED them — so "is the second
    // parent in the base" says no, and the merge is carved as a region. On
    // lazy's own v0.22 there were four of these, the largest a 250-file region
    // of pure noise. Lazy's accept tag is what resolves it: the parent task is
    // complete and its accept commit IS on the base.
    await git(dir, 'checkout', '-q', '-b', 'lazy/parent-hub', base);
    await write(dir, 'src/parent-work.ts', 'parent\n');
    await commit(dir, 'parent hub work');
    const parentTip = await git(dir, 'rev-parse', 'HEAD');

    await git(dir, 'checkout', '-q', 'main');
    await git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge origin/lazy/parent-hub', 'lazy/parent-hub');
    const withSync = await git(dir, 'rev-parse', 'HEAD');

    // The parent is squash-accepted onto a base that does NOT contain its
    // commits, and the accept is tagged the way `lazy accept` tags it.
    await git(dir, 'checkout', '-q', '-b', 'accepted-base', base);
    await git(dir, 'merge', '-q', '--squash', 'lazy/parent-hub');
    const acceptSha = await commit(dir, 'Accept task parent-hub: the parent hub');
    await git(dir, 'tag', '-a', 'lazy-accept-PARENT-TASK-ID', '-m', 'accept', acceptSha);
    await git(dir, 'checkout', '-q', 'main');

    const enrichment = stubEnrichment({
      'parent-hub': { taskId: 'PARENT-TASK-ID', status: 'complete', goal: 'The parent hub' },
    });
    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: 'accepted-base', headRef: withSync, enrichment,
    });
    expect(cover.regions.flatMap((r) => r.files)).not.toContain('src/parent-work.ts');
    expect(cover.notes.join(' ')).toContain('sync merge');

    // Without the store the same merge is carved, and the cover SAYS it could
    // not tell rather than quietly guessing either way.
    const gitOnly = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: 'accepted-base', headRef: withSync, enrichment: null,
    });
    expect(gitOnly.notes.join(' ')).toContain('without the task store there is no way to tell');
  });

  test('a store that throws costs enrichment, never the regions', async () => {
    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD',
      enrichment: {
        async lookupTask() {
          throw new Error('store is unreachable');
        },
      },
    });
    // INVARIANT: enrichment is never a prerequisite. A store that cannot
    // answer costs a goal and a model name, not the region — but the failure
    // is stated rather than swallowed.
    expect(cover.regions.length).toBeGreaterThan(0);
    expect(cover.notes.join(' ')).toContain('store is unreachable');
  });
});
