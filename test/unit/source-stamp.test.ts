/**
 * The source stamp: git identity carried into an image checkout with no `.git`.
 *
 * INVARIANT: when the source identity is SUPPLIED (build args → source-stamp.json)
 * and git is unavailable, every version display names the commit — the version
 * reads `<major>.<minor>.<count>` rather than package.json's bare `0.90.0`, and
 * the provenance suffix is never dropped. The engineer's report that started
 * this: "lazy-agent --version just shows 'lazy-agent ok 0.90.0' which is
 * meaningless" — a daemon image had no .git and the suffix silently vanished.
 *
 * INVARIANT: a build with NEITHER git nor a stamp says 'unknown' out loud. An
 * absent suffix reads as "nothing to report", the wrong answer to "which build".
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { formatSourceStampFile, readSourceStamp, sourceStampFromEnv } from '../../src/utils/source-stamp';
import {
  captureBuildProvenance,
  formatBuildIdentity,
  formatEmbeddedBuildProvenance,
  restingBuildInfoContent,
  UNKNOWN_SOURCE_SUFFIX,
} from '../../src/utils/build-provenance';
import { computeVersion } from '../../scripts/version-string';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

describe('source stamp', () => {
  let dir: string;
  let savedRefName: string | undefined;

  beforeEach(() => {
    // A temp dir outside any git repository: exactly an image checkout.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'lazy-source-stamp-')));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.90.0' }));
    // CI's branch override would otherwise leak into the git-less branch logic.
    savedRefName = process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_REF_NAME;
  });

  afterEach(() => {
    if (savedRefName !== undefined) process.env.GITHUB_REF_NAME = savedRefName;
    rmSync(dir, { recursive: true, force: true });
  });

  const stamp = (env: Record<string, string>) => {
    const parsed = sourceStampFromEnv(env);
    if (!parsed) throw new Error('expected a stamp');
    writeFileSync(join(dir, 'source-stamp.json'), formatSourceStampFile(parsed));
  };

  test('build args without git give the full version and a provenance suffix', () => {
    stamp({ LAZY_BUILD_SHA: 'abc1234', LAZY_BUILD_BRANCH: 'main', LAZY_BUILD_DIRTY: 'false', LAZY_BUILD_COMMIT_COUNT: '4100' });

    expect(computeVersion(dir)).toBe('0.90.4100');
    const provenance = captureBuildProvenance(dir);
    expect(formatEmbeddedBuildProvenance(provenance)).toBe(` (main@abc1234, clean, ${provenance.buildSourcePath})`);
    expect(formatBuildIdentity(provenance)).toBe('main@abc1234, clean');
  });

  test('a non-main branch is alpha and a dirty tree says dirty, as with git', () => {
    stamp({ LAZY_BUILD_SHA: 'abc1234', LAZY_BUILD_BRANCH: 'lazy/x', LAZY_BUILD_DIRTY: 'true', LAZY_BUILD_COMMIT_COUNT: '12' });

    expect(computeVersion(dir)).toBe('0.90.12-alpha');
    expect(formatBuildIdentity(captureBuildProvenance(dir))).toBe('lazy/x@abc1234, dirty');
  });

  test('the resting build-info of a stamped checkout carries the stamp, not dev defaults', () => {
    stamp({ LAZY_BUILD_SHA: 'abc1234', LAZY_BUILD_BRANCH: 'main' });

    const content = restingBuildInfoContent(dir);
    expect(content).toContain("export const BUILD_SHA = 'abc1234'");
    expect(content).toContain("export const BUILD_BRANCH = 'main'");
  });

  test('neither git nor a stamp: version falls back and the suffix says unknown', () => {
    expect(readSourceStamp(dir)).toBeNull();
    expect(computeVersion(dir)).toBe('0.90.0');
    const provenance = captureBuildProvenance(dir);
    expect(provenance.buildSha).toBe('unknown');
    expect(formatEmbeddedBuildProvenance(provenance)).toBe(UNKNOWN_SOURCE_SUFFIX);
    expect(formatBuildIdentity(provenance)).toBe('source unknown');
    expect(restingBuildInfoContent(dir)).toContain("export const BUILD_SHA = 'dev'");
  });

  test('no LAZY_BUILD_SHA means no stamp; malformed values are refused loudly', () => {
    expect(sourceStampFromEnv({})).toBeNull();
    expect(() => sourceStampFromEnv({ LAZY_BUILD_SHA: 'not a sha' })).toThrow(/LAZY_BUILD_SHA/);
    expect(() => sourceStampFromEnv({ LAZY_BUILD_SHA: 'abc1234', LAZY_BUILD_DIRTY: 'maybe' })).toThrow(/LAZY_BUILD_DIRTY/);
    expect(() => sourceStampFromEnv({ LAZY_BUILD_SHA: 'abc1234', LAZY_BUILD_COMMIT_COUNT: 'x' })).toThrow(/LAZY_BUILD_COMMIT_COUNT/);
  });

  test('a stamp file that exists but is broken is an error, not "no stamp"', () => {
    writeFileSync(join(dir, 'source-stamp.json'), '{not json');
    expect(() => readSourceStamp(dir)).toThrow(/not valid JSON/);
  });

  // INVARIANT: git wins whenever it can answer — a stale stamp left in a real
  // checkout must never outrank the repository it sits in.
  test('in a git checkout the stamp is ignored', () => {
    const git = (...args: string[]) => {
      const res = spawnSyncUnsupervised(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      if (res.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr.toString()}`);
      return res.stdout.toString().trim();
    };
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'one');
    stamp({ LAZY_BUILD_SHA: 'deadbee', LAZY_BUILD_BRANCH: 'lazy/stale', LAZY_BUILD_COMMIT_COUNT: '999' });
    const head = git('rev-parse', '--short', 'HEAD');

    expect(computeVersion(dir)).toBe('0.90.1');
    const provenance = captureBuildProvenance(dir);
    expect(provenance.buildSha).toBe(head);
    expect(provenance.buildBranch).toBe('main');
    // In a git checkout build-info rests on the dev defaults; git is asked live.
    expect(restingBuildInfoContent(dir)).toContain("export const BUILD_SHA = 'dev'");
  });

  // INVARIANT: the resting build-info of a stamped checkout is the SAME bytes on
  // every call. The agent-binary source hash and the baked source fingerprint
  // both read it; a wall-clock time there rebuilt lazy-agent on every task
  // launch in an image, and gave each build of one commit a different id.
  test('the resting build-info of a stamped checkout is deterministic', async () => {
    stamp({ LAZY_BUILD_SHA: 'abc1234', LAZY_BUILD_BRANCH: 'main', LAZY_BUILD_TIME: '2026-09-27T00:00:00Z' });
    const first = restingBuildInfoContent(dir);
    await Bun.sleep(5);
    expect(restingBuildInfoContent(dir)).toBe(first);
    expect(first).toContain("export const BUILD_TIME = '2026-09-27T00:00:00Z'");
  });
});
