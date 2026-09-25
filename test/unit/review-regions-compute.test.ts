/**
 * Review-region carving, against real git fixture repositories built here.
 *
 * These repos have NO `.lazy` directory, no store, no network and — in the
 * squash fixture — no surviving branches. That is the point: regions are
 * specified git-first, and a project where none of the work went through lazy
 * is the common case, not the degraded one.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { realpathSync } from 'fs';
import { runGit } from '../../src/utils/git';
import { computeRegionCover } from '../../src/regions/compute';
import { unitFromSubject, parseWalk, isAutomatedIdentity } from '../../src/regions/git';
import { partitionOwnership } from '../../src/regions/compute';
import { areaOf, computeAreas } from '../../src/regions/areas';
import { sortRegionsByImpact, applyRegionOverlays, findRegion } from '../../src/regions/view';
import type { RegionCover, ReviewRegion } from '../../src/regions/types';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, { cwd });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

async function write(dir: string, path: string, content: string): Promise<void> {
  const full = join(dir, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

async function commit(dir: string, message: string, author?: string): Promise<string> {
  await git(dir, 'add', '-A');
  const args = ['commit', '-q', '-m', message, '--no-verify'];
  if (author) args.push('--author', `${author} <${author.replace(/\s+/g, '.')}@test>`);
  await git(dir, ...args);
  return git(dir, 'rev-parse', 'HEAD');
}

async function newRepo(): Promise<string> {
  // realpath first: macOS tmpdir() is /var → /private/var, and git prints the
  // resolved spelling. Comparing an unresolved path against git's output is a
  // failure that looks like the code under test.
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'lazy-regions-')));
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@lazy.test');
  await git(dir, 'config', 'user.name', 'Lazy Test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

describe('review regions — subject conventions', () => {
  test('recognises lazy accepts, PR merges and GitHub squashes', () => {
    expect(unitFromSubject('Accept task fix-thing: Make it work')).toEqual({
      kind: 'lazy-task', code: 'fix-thing', title: 'Make it work',
    });
    expect(unitFromSubject('Merge pull request #412 from acme/feature-x')).toMatchObject({
      kind: 'pr-merge', pr: '412', branch: 'feature-x',
    });
    expect(unitFromSubject('Fix the parser (#88)')).toMatchObject({
      kind: 'pr-squash', pr: '88', title: 'Fix the parser',
    });
    expect(unitFromSubject('just an ordinary commit')).toBeNull();
  });

  test('parses a walk record with trailers and NUL-separated paths', () => {
    const record =
      '\x01abc123\x02par1 par2\x02Ada <ada@example.com>\x02Subject here\x02Grace Hopper <g@h>\x03\0\n' +
      'src/a.ts\0src/b.ts\0';
    const [commit] = parseWalk(record);
    expect(commit!.sha).toBe('abc123');
    expect(commit!.parents).toEqual(['par1', 'par2']);
    expect(commit!.identities.map((i) => i.name)).toEqual(['Ada', 'Grace Hopper']);
    expect(commit!.paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('a machine co-author is not a person, a GitHub privacy address is', () => {
    // INVARIANT: expansion trigger 2 asks whether more than one PERSON wrote
    // the unit. Lazy stamps the agent as a `Co-authored-by:` trailer on every
    // commit it makes, so counting raw trailers fires the trigger on every
    // task branch and shatters each into its commits — 471 `Lazy <noreply@…>`
    // trailers on this repo's own v0.22 release.
    expect(isAutomatedIdentity('Lazy', 'noreply@getlazy.dev')).toBe(true);
    expect(isAutomatedIdentity('Claude Opus 4.8', 'noreply@anthropic.com')).toBe(true);
    expect(isAutomatedIdentity('dependabot[bot]', 'support@github.com')).toBe(true);
    expect(isAutomatedIdentity('Lazy Builder', 'builder@lazy.dev')).toBe(false);
    // A GitHub privacy address belongs to a real person and must stay one —
    // treating it as a machine erases human co-authors on exactly the repos
    // most likely to have them.
    expect(isAutomatedIdentity('Ada', '1234+ada@users.noreply.github.com')).toBe(false);
  });
});

describe('review regions — partition semantics', () => {
  const mk = (id: string, files: string[]): ReviewRegion => ({
    id, unit: 'commit', parent_id: null, depth: 0, title: id,
    from: 'a', to: id.slice(-1), provenance: 'commit', files,
    shared_files: [], commit_count: 1,
    authors: [], expansion_reasons: [],
  });

  test('a file several siblings touched goes to exactly one, naming the rest', () => {
    // INVARIANT: regions are a PARTITION, not a cover. A file belongs to
    // exactly one region and the other units that touched it are ATTRIBUTION,
    // never membership. Slice 0 made it a cover; on a release hub, where late
    // fixes rewrite what features introduced, that made region sizes sum to
    // several times the review and made a sign-off on one region say nothing
    // about the file's other claimants. Reversed on the engineer's call,
    // 2026-09-13.
    const a = mk('commit:a', ['shared.md', 'only-a.ts']);
    const b = mk('commit:b', ['shared.md', 'only-b.ts']);
    const c = mk('commit:c', ['shared.md']);
    // No blame data: ownership falls back to the newest claimant, which is
    // first in walk order.
    partitionOwnership({
      siblings: [a, b, c],
      shaToRegion: new Map(),
      attribution: null,
      scopePaths: null,
    });

    expect(a.files).toEqual(['only-a.ts', 'shared.md']);
    expect(a.shared_files.map((f) => f.path)).toEqual(['shared.md']);
    expect(a.shared_files[0]!.also).toEqual(['commit:b', 'commit:c']);
    expect(b.files).toEqual(['only-b.ts']);
    expect(c.files).toEqual([]);
    // The headline property: every file, exactly once.
    expect([...a.files, ...b.files, ...c.files].sort())
      .toEqual(['only-a.ts', 'only-b.ts', 'shared.md']);
  });

  test('the unit with the most surviving lines wins, not the newest', () => {
    // INVARIANT: ownership is BLAME-WEIGHTED. "Whose work is this file" on a
    // release branch means whose lines the reviewer will actually read, which
    // is not the same as who touched it last.
    const a = mk('commit:a', ['shared.md']);
    const b = mk('commit:b', ['shared.md']);
    partitionOwnership({
      siblings: [a, b],
      shaToRegion: new Map([['sha-a', 'commit:a'], ['sha-b', 'commit:b']]),
      attribution: {
        paths: ['shared.md'],
        deleted: new Set(),
        byPath: new Map([
          ['shared.md', { lines: new Map([['sha-a', 2], ['sha-b', 40]]), total: 42 }],
        ]),
      },
      scopePaths: null,
    });
    expect(a.files).toEqual([]);
    expect(b.files).toEqual(['shared.md']);
    expect(b.shared_files[0]).toMatchObject({ lines: 40, total_lines: 42, also: ['commit:a'] });
  });

  test('a path outside the review is dropped; one nobody claimed is adopted', () => {
    const a = mk('commit:a', ['reverted.ts']);
    const b = mk('commit:b', ['kept.ts']);
    partitionOwnership({
      siblings: [a, b],
      shaToRegion: new Map([['sha-b', 'commit:b']]),
      attribution: {
        paths: ['kept.ts', 'stray.ts'],
        deleted: new Set(),
        byPath: new Map([
          ['kept.ts', { lines: new Map([['sha-b', 3]]), total: 3 }],
          ['stray.ts', { lines: new Map([['sha-b', 9]]), total: 9 }],
        ]),
      },
      // The review's own file list: `reverted.ts` is not in it.
      scopePaths: new Set(['kept.ts', 'stray.ts']),
    });
    expect(a.files).toEqual([]);
    expect(b.files).toEqual(['kept.ts', 'stray.ts']);
  });

  test('a file nothing can be attributed to is reported, not silently dropped', () => {
    const a = mk('commit:a', []);
    const { unattributed } = partitionOwnership({
      siblings: [a],
      shaToRegion: new Map(),
      attribution: { paths: ['orphan.ts'], deleted: new Set(), byPath: new Map() },
      scopePaths: new Set(['orphan.ts']),
    });
    expect(unattributed).toEqual(['orphan.ts']);
  });
});

describe('review regions — a repo that MERGES, with no lazy history', () => {
  let dir: string;
  let base: string;

  beforeEach(async () => {
    dir = await newRepo();
    await write(dir, 'README.md', 'seed\n');
    // A long CHANGELOG so both branches can edit it in different places: the
    // point of the fixture is a SHARED file, not a merge conflict.
    await write(dir, 'CHANGELOG.md', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n');
    base = await commit(dir, 'seed');

    // Two feature branches, each merged back with a real merge commit. Every
    // branch is then DELETED — a merge needs no branch recovery at all,
    // because the second parent IS the branch tip.
    const changelog = (marker: string, at: number) =>
      Array.from({ length: 40 }, (_, i) => (i === at ? `line ${i} — ${marker}` : `line ${i}`)).join('\n') + '\n';
    let slot = 0;
    for (const [branch, file, author] of [
      ['feat-a', 'src/a.ts', 'Ada Lovelace'],
      ['feat-b', 'src/b.ts', 'Grace Hopper'],
    ] as const) {
      await git(dir, 'checkout', '-q', '-b', branch, base);
      // The first commit's lines must SURVIVE the second, or the first unit
      // owns nothing and collapses as superseded — which is correct behaviour
      // and a different test (below).
      await write(dir, file, 'one\ntwo\nthree\n');
      await commit(dir, `${branch}: first`, author);
      await write(dir, file, 'one\ntwo\nthree\nfour\n');
      await write(dir, 'CHANGELOG.md', changelog(branch, slot));
      slot += 20;
      // feat-b's second commit has a DIFFERENT author, which is expansion
      // trigger 2. feat-a is one person's clean work and trips no trigger at
      // all — it stays a single region, which is the design, not a gap.
      await commit(dir, `${branch}: second`, branch === 'feat-b' ? 'Alan Turing' : author);
      await git(dir, 'checkout', '-q', 'main');
      await git(dir, 'merge', '-q', '--no-ff', '-m', `Merge pull request #1 from acme/${branch}`, branch);
      await git(dir, 'branch', '-q', '-D', branch);
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('merge commits expand via the second parent, and only when a trigger fires', async () => {
    const cover = await computeRegionCover({ cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD' });

    const top = cover.regions.filter((r) => r.depth === 0);
    expect(top).toHaveLength(2);
    // Both merges were recognised as PR merges and named by their branch.
    expect(top.map((r) => r.id).sort()).toEqual(['branch:feat-a', 'branch:feat-b']);

    // INVARIANT: expansion is earned, not automatic (spec §1.5.3). feat-a is
    // one person's clean work with nothing nested inside it, so the walk stops
    // there — expanding every merge would turn a release into a commit log,
    // which is the list the reviewer already had.
    const a = top.find((r) => r.id === 'branch:feat-a')!;
    expect(a.expansion_reasons).toEqual([]);
    expect(cover.regions.filter((r) => r.parent_id === a.id)).toHaveLength(0);

    // feat-b's two commits have different authors — trigger 2 — so it expands
    // through its SECOND PARENT with no branch recovery at all (both branches
    // were deleted).
    const b = top.find((r) => r.id === 'branch:feat-b')!;
    expect(b.provenance).toBe('merge-parent');
    expect(b.expansion_reasons.join(' ')).toContain('2 people wrote it');
    const kids = cover.regions.filter((r) => r.parent_id === b.id);
    expect(kids).toHaveLength(2);
    expect(kids.every((k) => k.unit === 'commit')).toBe(true);
  });

  test('CHANGELOG.md goes to ONE region, with the other named on it', async () => {
    const cover = await computeRegionCover({ cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD' });
    const top = cover.regions.filter((r) => r.depth === 0);
    const owners = top.filter((r) => r.files.includes('CHANGELOG.md'));
    expect(owners).toHaveLength(1);
    const shared = owners[0]!.shared_files.find((f) => f.path === 'CHANGELOG.md');
    expect(shared).toBeDefined();
    expect(shared!.also).toHaveLength(1);
    expect(cover.regions.find((r) => r.id === 'branch:feat-a')!.files).toContain('src/a.ts');
  });

  test('git authorship reaches the region without any store', async () => {
    const cover = await computeRegionCover({ cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD' });
    const kids = cover.regions.filter((r) => r.depth === 1);
    expect(kids.length).toBeGreaterThan(0);
    expect(kids.flatMap((k) => k.authors).sort()).toEqual(['Alan Turing', 'Grace Hopper']);
    // And the absence of the store is SAID, not silently implied.
    expect(cover.notes.some((n) => n.includes('No store enrichment'))).toBe(true);
  });
});

describe('review regions — a repo that SQUASHES with branches deleted', () => {
  let dir: string;
  let base: string;

  beforeEach(async () => {
    dir = await newRepo();
    await write(dir, 'README.md', 'seed\n');
    base = await commit(dir, 'seed');

    // Three squashed PRs, GitHub-style, with no branches left behind at all.
    for (const [n, file] of [[11, 'src/one.ts'], [12, 'src/two.ts'], [13, 'src/three.ts']] as const) {
      await write(dir, file, 'content\n');
      await write(dir, 'CHANGELOG.md', `entry ${n}\n`);
      await commit(dir, `Add ${file} (#${n})`);
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('degrades to commit-level regions and still carves', async () => {
    const cover = await computeRegionCover({ cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD' });

    // INVARIANT: the floor is never empty. With no merge to walk and no branch
    // to recover, the commit itself IS the region — which is what lets regions
    // work on a clone with no history but the squashes (spec §1.5.2a).
    expect(cover.regions).toHaveLength(3);
    expect(cover.regions.every((r) => r.depth === 0)).toBe(true);
    // Nothing was recoverable, so nothing expanded — the assertion that used
    // to sit here (`.every(r => r.expansion_reasons).toString()`) was true for
    // any input and could never have failed.
    expect(cover.regions.every((r) => r.expansion_reasons.length === 0)).toBe(true);
    expect(cover.regions.map((r) => r.id).sort()).toEqual(['pr:11', 'pr:12', 'pr:13']);
    // Titles come off the subject with the convention stripped.
    expect(cover.regions.find((r) => r.id === 'pr:11')!.title).toBe('Add src/one.ts');
  });

  test('CHANGELOG.md goes to the unit whose line survives; the rest keep their own', async () => {
    const cover = await computeRegionCover({ cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD' });
    // Each squash overwrote the single CHANGELOG line, so only the last one's
    // survives — and blame-weighted ownership hands the file to that unit
    // rather than to all three.
    const owner = cover.regions.find((r) => r.files.includes('CHANGELOG.md'))!;
    expect(owner.id).toBe('pr:13');
    expect(owner.shared_files[0]!.also.sort()).toEqual(['pr:11', 'pr:12']);
    expect(cover.regions.find((r) => r.id === 'pr:11')!.files).toEqual(['src/one.ts']);
    expect(cover.regions.find((r) => r.id === 'pr:12')!.files).toEqual(['src/two.ts']);

    // INVARIANT: the partition property. Region file counts sum to the number
    // of files in the review's own diff — that is what makes "this region is
    // signed off" a statement about a known share of the change.
    const total = cover.regions
      .filter((r) => r.depth === 0)
      .reduce((n, r) => n + r.files.length, 0);
    expect(total).toBe(4);
    const everyFile = cover.regions.filter((r) => r.depth === 0).flatMap((r) => r.files);
    expect(new Set(everyFile).size).toBe(everyFile.length);
  });
});

describe('review regions — superseded units collapse', () => {
  let dir: string;
  let base: string;

  beforeEach(async () => {
    dir = await newRepo();
    await write(dir, 'README.md', 'seed\n');
    base = await commit(dir, 'seed');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a unit whose every line was rewritten is recorded, not listed', async () => {
    // INVARIANT: a unit that owns no file after partitioning is NOT a region.
    // It contributed to the branch and nothing of it is left to read, so
    // listing it is the atomization the partition exists to undo — but
    // dropping it silently loses provenance, so the cover keeps it in
    // `superseded` with the count of files it touched.
    await write(dir, 'src/thing.ts', 'first\nsecond\nthird\n');
    await commit(dir, 'Accept task early-feature: Add the thing');
    await write(dir, 'src/thing.ts', 'REWRITTEN\nCOMPLETELY\nAGAIN\n');
    await commit(dir, 'Accept task late-fix: Rewrite the thing');

    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD',
    });

    expect(cover.regions.map((r) => r.id)).toEqual(['task:late-fix']);
    expect(cover.superseded).toEqual([
      { id: 'task:early-feature', title: 'Add the thing', task_code: 'early-feature', touched: 1 },
    ]);
    expect(cover.notes.join(' ')).toContain('contributed no surviving lines');

    // INVARIANT: a collapsed unit is still NAMED on the file it lost, and that
    // name RESOLVES. The attribution is the point of the partition — it is
    // what a reviewer follows to find who else has fingerprints on a file —
    // and dropping the id would lose the information while leaving it
    // unresolvable turned every such line into "no region by that name", which
    // reads as a bug in the carve. On a release-sized review most attribution
    // lines name a collapsed unit.
    const winner = cover.regions[0]!;
    expect(winner.shared_files.map((f) => f.path)).toEqual(['src/thing.ts']);
    expect(winner.shared_files[0]!.also).toEqual(['task:early-feature']);

    const followed = findRegion(cover, 'task:early-feature');
    expect(followed).toEqual({ superseded: cover.superseded![0]! });
    // The shorthand a reviewer actually types resolves too.
    expect(findRegion(cover, 'early-feature')).toEqual({ superseded: cover.superseded![0]! });
    // And a live region still wins a name it could share with a dead one.
    expect(findRegion(cover, 'task:late-fix')).toEqual({ region: winner });
  });

  test('a file the review DELETES goes to the unit that deleted it', async () => {
    // `doomed.ts` must predate the review: a file ADDED and then removed
    // inside the range is not in the review's diff at all, so it is not part
    // of the partition — which is the same rule, seen from the other side.
    await write(dir, 'doomed.ts', 'x\n');
    base = await commit(dir, 'seed the doomed file');
    await write(dir, 'kept.ts', 'y\n');
    await commit(dir, 'Accept task adder: Add the kept one');
    await rm(join(dir, 'doomed.ts'));
    await commit(dir, 'Accept task remover: Remove the doomed one');

    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD',
    });
    // Blame cannot speak for a file that is gone, so the last unit to touch it
    // in the range owns it — here, the one that deleted it.
    expect(cover.regions.find((r) => r.id === 'task:remover')!.files).toEqual(['doomed.ts']);
    expect(cover.regions.find((r) => r.id === 'task:adder')!.files).toEqual(['kept.ts']);
  });
});

describe('review regions — a file nothing can place is said out loud', () => {
  let dir: string;
  let base: string;

  beforeEach(async () => {
    dir = await newRepo();
    await write(dir, 'README.md', 'seed\n');
    base = await commit(dir, 'seed');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a merge resolution\'s own lines are reported at the DEPTH they went missing', async () => {
    // INVARIANT: "the partition is a promise about counts, so a file it could
    // not place has to be said out loud" applies at every level, not only the
    // top. It used to be gated on depth 0, so a reviewer who opened a region
    // found its children summing to fewer files than the region with nothing
    // accounting for the difference.
    //
    // The natural case is exactly this: content introduced by the merge
    // RESOLUTION blames to the merge commit, which is in no child's range, so
    // no child can claim it.
    await git(dir, 'checkout', '-q', '-b', 'side', base);
    await write(dir, 'src/side.ts', 'one\ntwo\nthree\n');
    await commit(dir, 'side: first', 'Ada Lovelace');
    await write(dir, 'src/side.ts', 'one\ntwo\nthree\nfour\n');
    await commit(dir, 'side: second', 'Grace Hopper');
    await git(dir, 'checkout', '-q', 'main');

    // A merge that carries work of its OWN — the resolution edits a file
    // neither side of the merge wrote.
    await git(dir, 'merge', '-q', '--no-ff', '--no-commit', 'side');
    await write(dir, 'src/resolution.ts', 'written by the merge itself\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'Merge pull request #3 from acme/side', '--no-verify');
    await git(dir, 'branch', '-q', '-D', 'side');

    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD',
    });

    const merge = cover.regions.find((r) => r.id === 'branch:side')!;
    expect(merge.files).toContain('src/resolution.ts');
    const children = cover.regions.filter((r) => r.parent_id === merge.id);
    expect(children.length).toBeGreaterThan(0);
    // No child can own it, and the cover says so — naming the region it
    // happened inside, so the shortfall is traceable to a row on the page.
    expect(children.every((c) => !c.files.includes('src/resolution.ts'))).toBe(true);
    const note = cover.notes.find((n) => n.includes('src/resolution.ts'));
    expect(note).toBeDefined();
    expect(note).toContain('branch:side');
  });
});

describe('review regions — the area axis', () => {
  test('the area is the first path segment, or two under a source root', () => {
    expect(areaOf('src/regions/compute.ts')).toBe('src/regions');
    expect(areaOf('test/unit/a.test.ts')).toBe('test/unit');
    expect(areaOf('docs/design/x.md')).toBe('docs');
    expect(areaOf('src/index.ts')).toBe('src');
    expect(areaOf('CHANGELOG.md')).toBe('(root)');
  });

  test('areas group a partitioned cover by path, largest first', () => {
    const mk = (id: string, files: string[]): ReviewRegion => ({
      id, unit: 'task', parent_id: null, depth: 0, title: id,
      from: 'a', to: 'b', provenance: 'commit', files,
      shared_files: [], commit_count: 1, authors: [], expansion_reasons: [],
    });
    const areas = computeAreas([
      mk('task:one', ['src/regions/a.ts', 'src/regions/b.ts', 'CHANGELOG.md']),
      mk('task:two', ['src/regions/c.ts', 'test/unit/x.test.ts']),
    ]);
    expect(areas.map((a) => a.id)).toEqual(['area:src/regions', 'area:(root)', 'area:test/unit']);
    const first = areas[0]!;
    expect(first.files).toEqual(['src/regions/a.ts', 'src/regions/b.ts', 'src/regions/c.ts']);
    // Units inside an area, most files first — where to start reading it.
    expect(first.region_ids).toEqual(['task:one', 'task:two']);

    // INVARIANT: areas partition the same files on their own axis, so their
    // counts sum to the review's just as the regions' do. A grouping that did
    // not would let a reviewer who works area by area miss files entirely.
    expect(areas.reduce((n, a) => n + a.files.length, 0)).toBe(5);
  });
});

describe('review regions — expansion is bounded', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('an expansion never reaches outside the reviewed range', async () => {
    dir = await newRepo();
    await write(dir, 'README.md', 'seed\n');
    const root = await commit(dir, 'seed');

    // Commits that predate the review base. A merge whose second parent is an
    // older line must NOT drag them in: the review was explicitly based after
    // them, and attributing them to this range is the 90k-file class of bug.
    await write(dir, 'old.ts', 'old\n');
    await commit(dir, 'old work nobody is reviewing');
    const base = await git(dir, 'rev-parse', 'HEAD');

    await git(dir, 'checkout', '-q', '-b', 'side', root);
    await write(dir, 'side.ts', 'side\n');
    await commit(dir, 'side work');
    await git(dir, 'checkout', '-q', 'main');
    await git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #5 from acme/side', 'side');

    const cover = await computeRegionCover({ cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD' });
    const paths = cover.regions.flatMap((r) => r.files);
    expect(paths).toContain('side.ts');
    expect(paths).not.toContain('old.ts');
  });

  test('a non-ASCII path survives the round trip into a region', async () => {
    dir = await newRepo();
    await write(dir, 'README.md', 'seed\n');
    const base = await commit(dir, 'seed');

    // INVARIANT: region file lists are read NUL-separated and handed straight
    // back to git as a pathspec. Git's default output QUOTES such a path —
    // `"src/caf\303\251.ts"` — and does NOT unquote it on input, so a region
    // recorded from the default output scoped its own diff to nothing and came
    // back short with no error at all. Silence was the bug: a short diff reads
    // as "that region really is small".
    await write(dir, 'src/café.ts', 'accents\n');
    await write(dir, 'src/re"quote".ts', 'quote\n');
    await commit(dir, 'add awkward filenames');

    const cover = await computeRegionCover({ cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD' });
    const region = cover.regions[0]!;
    expect(region.files).toContain('src/café.ts');
    expect(region.files).toContain('src/re"quote".ts');
    expect(region.files.some((f) => f.includes('\\303'))).toBe(false);

    // And the path git prints for that file is the same string, so scoping a
    // diff to this region actually matches it.
    const listed = await git(dir, 'diff', '-z', '--name-only', `${base}..HEAD`);
    expect(listed.split('\0')).toContain('src/café.ts');
  });

  test('a stacked hub does not carve the hub it was cut from', async () => {
    // The shape that makes the walk bound necessary, and the one lazy's own
    // releases have. Hub A is squash-accepted onto main; hub B was cut from
    // A's BRANCH before that happened. A's original commits are therefore not
    // reachable from main — the squash replaced them — so a plain `main..B`
    // walk carves every one of them into a region, even though their content
    // is already on main and contributes nothing to the three-dot diff the
    // review renders. 145 of the 438 first-parent commits of
    // `main..lazy/release-v022` were exactly this.
    dir = await newRepo();
    await write(dir, 'README.md', 'seed\n');
    const root = await commit(dir, 'seed');

    // Hub A: two pieces of work on its own branch.
    await git(dir, 'checkout', '-q', '-b', 'lazy/hub-a', root);
    await write(dir, 'src/a-one.ts', 'one\n');
    await commit(dir, 'Accept task a-one: first thing in hub A');
    await write(dir, 'src/a-two.ts', 'two\n');
    await commit(dir, 'Accept task a-two: second thing in hub A');
    const hubATip = await git(dir, 'rev-parse', 'HEAD');

    // Hub B is cut from hub A's branch WHILE A is still open.
    await git(dir, 'checkout', '-q', '-b', 'lazy/hub-b', hubATip);
    await write(dir, 'src/b-one.ts', 'one\n');
    await commit(dir, 'Accept task b-one: first thing in hub B');

    // Only now is hub A squash-accepted onto main.
    await git(dir, 'checkout', '-q', 'main');
    await git(dir, 'merge', '-q', '--squash', 'lazy/hub-a');
    await commit(dir, 'Accept task hub-a: all of hub A');

    // Unbounded, hub A's own commits are carved into hub B's review.
    const unbounded = await computeRegionCover({
      cwd: dir, taskId: 'b', baseRef: 'main', headRef: 'lazy/hub-b',
    });
    expect(unbounded.regions.map((r) => r.id)).toContain('task:a-one');
    expect(unbounded.regions.map((r) => r.id)).toContain('task:a-two');

    // INVARIANT: bounded at hub B's own cut point, hub A's commits are NOT
    // regions of hub B — they are not hub B's work, and their content reached
    // main by hub A's accept. Reachability from the base is not the same
    // question as what the review contains, and on a stacked release the two
    // answers differ by hundreds of commits.
    const bounded = await computeRegionCover({
      cwd: dir, taskId: 'b', baseRef: 'main', headRef: 'lazy/hub-b',
      branchStartSha: hubATip,
    });
    expect(bounded.regions.map((r) => r.id)).toContain('task:b-one');
    expect(bounded.regions.map((r) => r.id)).not.toContain('task:a-one');
    expect(bounded.regions.map((r) => r.id)).not.toContain('task:a-two');
    expect(bounded.notes.join(' ')).toContain('inherited from the');
  });

  test('a branch start that is not on this history is ignored, never obeyed', async () => {
    // A wrong or stale start must degrade to the WIDER old behaviour, never
    // drop regions: losing work silently is the one failure mode worse than
    // carrying a few phantom ones.
    dir = await newRepo();
    await write(dir, 'README.md', 'seed\n');
    const base = await commit(dir, 'seed');
    await git(dir, 'checkout', '-q', '-b', 'sidelined', base);
    await write(dir, 'unrelated.ts', 'x\n');
    const offBranch = await commit(dir, 'a commit on another branch entirely');
    await git(dir, 'checkout', '-q', 'main');
    await write(dir, 'src/real.ts', 'real\n');
    await commit(dir, 'real work');

    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD', branchStartSha: offBranch,
    });
    expect(cover.regions.flatMap((r) => r.files)).toContain('src/real.ts');
    expect(cover.notes.join(' ')).toContain('not an ancestor of this branch');
  });

  test('an upstream sync merge is not a region', async () => {
    dir = await newRepo();
    await write(dir, 'README.md', 'seed\n');
    const base = await commit(dir, 'seed');

    // Upstream moves on, and the task branch merges it in to stay current.
    await git(dir, 'checkout', '-q', '-b', 'upstream', base);
    await write(dir, 'upstream-only.ts', 'theirs\n');
    await commit(dir, 'work that belongs to upstream');
    const upstreamTip = await git(dir, 'rev-parse', 'HEAD');

    await git(dir, 'checkout', '-q', '-b', 'task', base);
    await write(dir, 'src/mine.ts', 'mine\n');
    await commit(dir, 'my own work');
    await git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge upstream', 'upstream');

    // INVARIANT: a first-parent merge whose second parent the BASE already
    // contains is a sync, not a unit of work. Its first-parent diff is
    // everything upstream brought in — on this repo's own release branch the
    // largest such region was 233 files of somebody else's work — so carving
    // it puts a huge meaningless entry at the top of the review.
    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: upstreamTip, headRef: 'task',
    });
    expect(cover.regions.flatMap((r) => r.files)).toContain('src/mine.ts');
    expect(cover.regions.flatMap((r) => r.files)).not.toContain('upstream-only.ts');
    expect(cover.notes.join(' ')).toContain('sync merge');
  });

  test('an empty range yields no regions and says why', async () => {
    dir = await newRepo();
    await write(dir, 'README.md', 'seed\n');
    const base = await commit(dir, 'seed');
    const cover = await computeRegionCover({ cwd: dir, taskId: 't', baseRef: base, headRef: 'HEAD' });
    expect(cover.regions).toHaveLength(0);
    expect(cover.base_sha).toBe(base);
  });

  test('an unresolvable base is a note, never a throw', async () => {
    dir = await newRepo();
    await write(dir, 'README.md', 'seed\n');
    await commit(dir, 'seed');
    const cover = await computeRegionCover({
      cwd: dir, taskId: 't', baseRef: 'refs/heads/nope', headRef: 'HEAD',
    });
    expect(cover.regions).toHaveLength(0);
    expect(cover.notes.join(' ')).toContain('Could not resolve the review range');
  });
});

describe('review regions — ordering by impact', () => {
  const mk = (id: string, files: number, parent: string | null = null, depth = 0): ReviewRegion => ({
    id, unit: 'task', parent_id: parent, depth, title: id,
    from: 'a', to: 'b', provenance: 'commit',
    files: Array.from({ length: files }, (_, i) => `${id}-${i}.ts`),
    shared_files: [], commit_count: 1,
    authors: [], expansion_reasons: [],
  });

  test('siblings are ordered biggest first', () => {
    const sorted = sortRegionsByImpact([mk('small', 2), mk('big', 90), mk('mid', 20)]);
    expect(sorted.map((r) => r.id)).toEqual(['big', 'mid', 'small']);
  });

  test('the hierarchy survives the sort — a parent still precedes its own children', () => {
    // INVARIANT: impact ordering is applied WITHIN each sibling group and
    // re-emitted depth-first. A flat sort over the whole cover would put a
    // big child above its own parent and scatter every family, which is the
    // opposite failure from the one the first strip had.
    const sorted = sortRegionsByImpact([
      mk('small-hub', 5),
      mk('small-hub-child', 4, 'small-hub', 1),
      mk('big-hub', 100),
      mk('big-hub-child', 99, 'big-hub', 1),
    ]);
    expect(sorted.map((r) => r.id)).toEqual([
      'big-hub', 'big-hub-child', 'small-hub', 'small-hub-child',
    ]);
  });

  test('ties break on id, so the order is stable across recarves', () => {
    // A reviewer's place in the list must not move because two regions happen
    // to touch the same number of files.
    const once = sortRegionsByImpact([mk('zebra', 4), mk('alpha', 4), mk('mango', 4)]);
    const again = sortRegionsByImpact([mk('mango', 4), mk('zebra', 4), mk('alpha', 4)]);
    expect(once.map((r) => r.id)).toEqual(['alpha', 'mango', 'zebra']);
    expect(again.map((r) => r.id)).toEqual(once.map((r) => r.id));
  });

  test('a region whose parent is missing is still emitted', () => {
    // A partial or corrupted stored cover must not lose regions silently —
    // an odd order is recoverable, a vanished region is not.
    const sorted = sortRegionsByImpact([mk('orphan', 3, 'gone', 1), mk('root', 10)]);
    expect(sorted.map((r) => r.id).sort()).toEqual(['orphan', 'root']);
  });

  test('a cycle in a corrupted cover terminates and emits each region once', () => {
    const a = mk('a', 5, 'b', 1);
    const b = mk('b', 5, 'a', 1);
    const sorted = sortRegionsByImpact([a, b]);
    expect(sorted).toHaveLength(2);
    expect(new Set(sorted.map((r) => r.id)).size).toBe(2);
  });
});
