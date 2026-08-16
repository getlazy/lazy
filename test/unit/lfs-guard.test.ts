/**
 * Unit tests for git LFS detection, the raw-blob scan (src/git/lfs.ts) and the
 * accept-time guard (src/protection/lfs-guard.ts).
 *
 * These build REAL git repositories rather than mocking git. The defect is a
 * claim about git's own filter semantics — that with `filter.lfs.required =
 * false` a broken clean filter produces a silent raw-blob commit — and a mocked
 * `git` would only ever confirm the author's model of it. The fixture in
 * `brokenLfsRepo()` reproduces the reported incident exactly, and
 * `test('the incident reproduces')` asserts the silent corruption really
 * happens before any test asserts that we catch it.
 *
 * NOTE: nothing here requires the `git-lfs` binary. Detection and the pointer
 * scan read git data only, and there is an explicit test proving they still work
 * with git-lfs absent from PATH.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  repoUsesLfs,
  lfsAttributeFilesAtRef,
  lfsTrackedPaths,
  findNonPointerLfsBlobs,
  inspectLfsEnvironment,
  LFS_POINTER_PREFIX,
} from '../../src/git/lfs';
import { enforceLfsGuard, LfsPointerRefusedError } from '../../src/protection/lfs-guard';
import { runGit } from '../../src/utils/git';
import { spawn } from '../../src/utils/spawn';

let repo: string;

async function git(...args: string[]): Promise<string> {
  const r = await runGit(args, { cwd: repo });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

async function write(path: string, content: string): Promise<void> {
  const full = join(repo, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

async function commit(message: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await write(path, content);
    await git('add', path);
  }
  await git('commit', '-q', '-m', message);
}

/** A syntactically valid LFS pointer for `content` — no git-lfs binary needed. */
function pointerFor(sizeBytes: number, oidHexSeed: string): string {
  const oid = oidHexSeed.repeat(64).slice(0, 64);
  return `${LFS_POINTER_PREFIX}\noid sha256:${oid}\nsize ${sizeBytes}\n`;
}

/**
 * The incident's environment, exactly: LFS-tracked path, `filter.lfs.process`
 * SET BUT EMPTY, and `required = false`.
 */
async function breakLfsFilter(): Promise<void> {
  await git('config', 'filter.lfs.process', '');
  await git('config', 'filter.lfs.clean', '');
  await git('config', 'filter.lfs.smudge', '');
  await git('config', 'filter.lfs.required', 'false');
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'lazy-lfs-'));
  await git('init', '-q', '-b', 'main', '.');
  await git('config', 'user.email', 'test@lazy.local');
  await git('config', 'user.name', 'Lazy Test');
  await commit('root', { 'README.md': 'root\n' });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('LFS detection', () => {
  test('a repo with no .gitattributes does not use LFS', async () => {
    expect(await repoUsesLfs(repo)).toBe(false);
  });

  test('a .gitattributes without filter=lfs does not count', async () => {
    await commit('attrs', { '.gitattributes': '*.md text\n' });
    expect(await repoUsesLfs(repo)).toBe(false);
  });

  test('finds filter=lfs in a nested .gitattributes', async () => {
    await commit('attrs', { 'datasets/.gitattributes': '*.bin filter=lfs -text\n' });
    expect(await repoUsesLfs(repo)).toBe(true);
    expect(await lfsAttributeFilesAtRef(repo, 'HEAD')).toEqual(['datasets/.gitattributes']);
  });

  // A brand-new repo with no commits is a normal thing to run `lazy start` on;
  // it must answer "no LFS", not throw.
  test('an empty repository answers false rather than throwing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'lazy-lfs-empty-'));
    try {
      await runGit(['init', '-q', '-b', 'main', '.'], { cwd: empty });
      expect(await repoUsesLfs(empty)).toBe(false);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('a bad ref is an error, never a quiet "no LFS"', async () => {
    await expect(lfsAttributeFilesAtRef(repo, 'no-such-ref')).rejects.toThrow();
  });

  test('resolves the filter attribute at a ref, from a different checkout', async () => {
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    await commit('files', { 'datasets/a.bin': 'x', 'src/b.ts': 'y' });
    const tracked = await lfsTrackedPaths(repo, 'HEAD', ['datasets/a.bin', 'src/b.ts']);
    expect(tracked).toEqual(['datasets/a.bin']);
  });
});

describe('the incident', () => {
  // INVARIANT: this is the defect itself, not our handling of it. With
  // filter.lfs.required = false git SKIPS a broken clean filter and commits the
  // raw file with exit 0 and no output. If this test ever fails because git
  // started erroring, the guard is less necessary — but we must find out from a
  // failing test, not from a 335 MB blob on someone's branch.
  test('a broken filter with required=false commits raw content, silently', async () => {
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    await breakLfsFilter();

    const big = 'A'.repeat(200_000);
    await write('datasets/big.bin', big);
    const add = await runGit(['add', 'datasets/big.bin'], { cwd: repo });
    expect(add.exitCode).toBe(0);
    expect(add.stderr.trim()).toBe('');
    await git('commit', '-q', '-m', 'add dataset');

    const size = (await git('cat-file', '-s', 'HEAD:datasets/big.bin')).trim();
    expect(Number(size)).toBe(200_000);
  });

  // The mirror image: required=true is what makes the failure loud. This is why
  // `required` is treated as a problem by inspectLfsEnvironment rather than a
  // stylistic preference.
  test('the same commit FAILS when filter.lfs.required is true', async () => {
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    await breakLfsFilter();
    await git('config', 'filter.lfs.required', 'true');

    await write('datasets/big.bin', 'A'.repeat(1000));
    const add = await runGit(['add', 'datasets/big.bin'], { cwd: repo });
    expect(add.exitCode).not.toBe(0);
    expect(add.stderr).toContain('clean filter');
  });
});

describe('findNonPointerLfsBlobs', () => {
  async function branchWith(files: Record<string, string>): Promise<string> {
    const base = (await git('rev-parse', 'HEAD')).trim();
    await git('checkout', '-q', '-b', 'feature');
    await commit('feature work', files);
    return base;
  }

  test('flags a raw blob on an LFS-tracked path', async () => {
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    await breakLfsFilter();
    const base = await branchWith({ 'datasets/big.bin': 'A'.repeat(50_000) });

    const scan = await findNonPointerLfsBlobs({ cwd: repo, ref: 'feature', baseRef: base });
    expect(scan.violations.map((v) => v.path)).toEqual(['datasets/big.bin']);
    expect(scan.violations[0]!.sizeBytes).toBe(50_000);
    expect(scan.violations[0]!.commit?.subject).toBe('feature work');
    expect(scan.pathsCapped).toBe(false);
  });

  test('a proper pointer on the same path passes', async () => {
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    await breakLfsFilter();
    const base = await branchWith({ 'datasets/big.bin': pointerFor(50_000, 'a') });

    const scan = await findNonPointerLfsBlobs({ cwd: repo, ref: 'feature', baseRef: base });
    expect(scan.violations).toEqual([]);
    expect(scan.trackedPathsChecked).toBe(1);
  });

  test('untracked paths are ignored however large', async () => {
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    const base = await branchWith({ 'src/generated.ts': 'A'.repeat(50_000) });

    const scan = await findNonPointerLfsBlobs({ cwd: repo, ref: 'feature', baseRef: base });
    expect(scan.violations).toEqual([]);
    expect(scan.trackedPathsChecked).toBe(0);
  });

  test('a small raw file on a tracked path is still a violation', async () => {
    // Size is not the signal — being non-pointer content is. A 12-byte raw file
    // pushes fine but breaks every checkout that expects LFS to hydrate it.
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    await breakLfsFilter();
    const base = await branchWith({ 'datasets/small.bin': 'hello world\n' });

    const scan = await findNonPointerLfsBlobs({ cwd: repo, ref: 'feature', baseRef: base });
    expect(scan.violations.map((v) => v.path)).toEqual(['datasets/small.bin']);
  });

  // Pre-existing damage on the target branch is somebody else's problem; this
  // accept must not be blocked by it.
  test('blobs outside merge-base..head are not scanned', async () => {
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    await breakLfsFilter();
    await commit('pre-existing raw blob', { 'datasets/old.bin': 'A'.repeat(50_000) });
    const base = await branchWith({ 'src/ok.ts': 'export {}\n' });

    const scan = await findNonPointerLfsBlobs({ cwd: repo, ref: 'feature', baseRef: base });
    expect(scan.violations).toEqual([]);
  });

  test('a non-LFS repo short-circuits clean', async () => {
    const base = await branchWith({ 'big.bin': 'A'.repeat(50_000) });
    const scan = await findNonPointerLfsBlobs({ cwd: repo, ref: 'feature', baseRef: base });
    expect(scan.violations).toEqual([]);
  });
});

// INVARIANT: detection and the accept-time scan must work with NO git-lfs
// installed. They read git objects, attributes and config only — the binary is
// consulted for exactly one question (is it installed), and a machine without it
// must still be fully diagnosable. This runs the whole path with PATH emptied so
// no `git-lfs` can possibly be found.
describe('without the git-lfs binary on PATH', () => {
  // Run the production code in a CHILD process whose PATH holds `git` and
  // nothing else. It has to be a child: Bun.spawn passes the environment the
  // process started with, so mutating `process.env.PATH` in this process would
  // not reach git at all — the test would pass while git-lfs was still on the
  // child's PATH, proving nothing.
  test('detection and the raw-blob scan still work', async () => {
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    await breakLfsFilter();
    const base = (await git('rev-parse', 'HEAD')).trim();
    await git('checkout', '-q', '-b', 'feature');
    await commit('raw blob', { 'datasets/big.bin': 'A'.repeat(50_000) });

    const binDir = await mkdtemp(join(tmpdir(), 'lazy-lfs-nobin-'));
    try {
      const gitPath = Bun.which('git');
      if (!gitPath) throw new Error('git is not on PATH — cannot run this test');
      await symlink(gitPath, join(binDir, 'git'));

      const src = join(process.cwd(), 'src', 'git', 'lfs.ts');
      const script = join(binDir, 'probe.ts');
      await writeFile(script, [
        `import { repoUsesLfs, findNonPointerLfsBlobs, inspectLfsEnvironment } from ${JSON.stringify(src)};`,
        `import { runGit } from ${JSON.stringify(join(process.cwd(), 'src', 'utils', 'git.ts'))};`,
        `const repo = ${JSON.stringify(repo)};`,
        `const lfs = await runGit(['lfs', 'version'], { cwd: repo });`,
        `const scan = await findNonPointerLfsBlobs({ cwd: repo, ref: 'feature', baseRef: ${JSON.stringify(base)} });`,
        `const report = await inspectLfsEnvironment(repo);`,
        `console.log(JSON.stringify({`,
        `  gitLfsExit: lfs.exitCode,`,
        `  usesLfs: await repoUsesLfs(repo),`,
        `  violations: scan.violations.map((v) => v.path),`,
        `  binaryPresent: report.binaryPresent,`,
        `  problems: report.problems.map((p) => p.code),`,
        `}));`,
      ].join('\n'));

      const proc = spawn([process.execPath, 'run', script], {
        cwd: process.cwd(),
        env: { ...process.env, PATH: binDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const out = JSON.parse(stdout.trim());

      expect(out.gitLfsExit).not.toBe(0); // precondition: git-lfs really is gone
      expect(out.usesLfs).toBe(true);
      expect(out.violations).toEqual(['datasets/big.bin']);
      expect(out.binaryPresent).toBe(false);
      expect(out.problems).toContain('binary-missing');
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  });
});

describe('inspectLfsEnvironment', () => {
  test('a non-LFS repo reports no problems', async () => {
    const report = await inspectLfsEnvironment(repo);
    expect(report.usesLfs).toBe(false);
    expect(report.problems).toEqual([]);
  });

  test('the incident configuration is reported as broken', async () => {
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    await breakLfsFilter();

    const report = await inspectLfsEnvironment(repo);
    expect(report.usesLfs).toBe(true);
    expect(report.required).toBe(false);
    expect(report.problems.map((p) => p.code)).toEqual(
      expect.arrayContaining(['filter-unset', 'not-required']),
    );
    // Every problem must carry an actionable remedy — doctor prints these and
    // nothing else does.
    for (const p of report.problems) expect(p.remedy.length).toBeGreaterThan(0);
  });

  test('a sane configuration reports no problems', async () => {
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    await git('config', 'filter.lfs.process', 'git-lfs filter-process');
    await git('config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    await git('config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
    await git('config', 'filter.lfs.required', 'true');

    const report = await inspectLfsEnvironment(repo);
    // The binary may or may not be installed in this environment; judge only
    // the config-derived problems so the test is not environment-dependent.
    expect(report.problems.filter((p) => p.code !== 'binary-missing')).toEqual([]);
  });
});

describe('enforceLfsGuard', () => {
  async function brokenFeature(): Promise<string> {
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    await breakLfsFilter();
    const base = (await git('rev-parse', 'HEAD')).trim();
    await git('checkout', '-q', '-b', 'feature');
    await commit('add dataset', { 'datasets/big.bin': 'A'.repeat(50_000) });
    await git('checkout', '-q', 'main');
    return base;
  }

  test('refuses and names the file, its size and its commit', async () => {
    const mergeBase = await brokenFeature();
    const call = enforceLfsGuard({
      projectRoot: repo, sourceBranch: 'feature', targetBranch: 'main', mergeBase, displayId: 't1',
    });
    await expect(call).rejects.toThrow(LfsPointerRefusedError);

    const err = (await call.catch((e) => e)) as LfsPointerRefusedError;
    expect(err.violations.map((v) => v.path)).toEqual(['datasets/big.bin']);
    expect(err.message).toContain('datasets/big.bin');
    expect(err.message).toContain('49 KB');
    expect(err.message).toContain('add dataset');
    // Actionable per CLAUDE.md: the mechanism, the fix, and the escape hatch.
    expect(err.message).toContain('filter.lfs.required');
    expect(err.message).toContain('git lfs install --local');
    expect(err.message).toContain('--approve-file datasets/big.bin');
  });

  test('an explicit approval lets it through, with a warning for the audit trail', async () => {
    const mergeBase = await brokenFeature();
    const result = await enforceLfsGuard({
      projectRoot: repo, sourceBranch: 'feature', targetBranch: 'main', mergeBase, displayId: 't1',
      approvedFiles: ['datasets/big.bin'],
    });
    expect(result.approved.map((v) => v.path)).toEqual(['datasets/big.bin']);
    expect(result.warnings.join('\n')).toContain('datasets/big.bin');
  });

  test('approving an unrelated path does not unblock the real violation', async () => {
    const mergeBase = await brokenFeature();
    await expect(enforceLfsGuard({
      projectRoot: repo, sourceBranch: 'feature', targetBranch: 'main', mergeBase, displayId: 't1',
      approvedFiles: ['some/other/file'],
    })).rejects.toThrow(LfsPointerRefusedError);
  });

  test('a clean branch passes with no warnings', async () => {
    await commit('attrs', { '.gitattributes': 'datasets/** filter=lfs -text\n' });
    await breakLfsFilter();
    const mergeBase = (await git('rev-parse', 'HEAD')).trim();
    await git('checkout', '-q', '-b', 'feature');
    await commit('add pointer', { 'datasets/big.bin': pointerFor(50_000, 'b') });
    await git('checkout', '-q', 'main');

    const result = await enforceLfsGuard({
      projectRoot: repo, sourceBranch: 'feature', targetBranch: 'main', mergeBase, displayId: 't1',
    });
    expect(result.approved).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
