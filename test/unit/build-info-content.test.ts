import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import {
  DEV_BUILD_INFO,
  DEV_BUILD_INFO_VALUES,
  captureGitBuildMetadata,
  captureBuildProvenance,
  formatBuildInfoContent,
} from '../../scripts/build-info-content';
import {
  formatDaemonBuiltLine,
  formatDisplayPath,
  formatEmbeddedBuildProvenance,
  formatSourceProvenanceLine,
  formatAgentBinaryRebuildSuccessLine,
} from '../../src/utils/build-provenance';

// Under the running user's real $HOME: the display shortens a path to `~` only
// when it lies under $HOME, so a hardcoded /home/user passed only for a user
// whose home happens to be exactly that (a task container's), never on a Mac.
const SOURCE_UNDER_HOME = join(process.env.HOME || '/home/user', 'prg', 'lazy-dev');

const projectRoot = join(import.meta.dir, '..', '..');

describe('build-info-content', () => {
  test('dev template exports all compile-time metadata fields', () => {
    expect(DEV_BUILD_INFO).toContain("export const BUILD_TIME = 'dev'");
    expect(DEV_BUILD_INFO).toContain("export const BUILD_SHA = 'dev'");
    expect(DEV_BUILD_INFO).toContain('export const BUILD_DIRTY = false');
    expect(DEV_BUILD_INFO).toContain("export const BUILD_BRANCH = 'dev'");
    expect(DEV_BUILD_INFO).toContain("export const BUILD_SOURCE_PATH = 'dev'");
    expect(formatBuildInfoContent(DEV_BUILD_INFO_VALUES)).toBe(DEV_BUILD_INFO);
  });

  test('formatBuildInfoContent stamps dirty flag as a boolean literal', () => {
    const content = formatBuildInfoContent({
      buildTime: '2026-08-24T12:00:00.000Z',
      buildSha: 'abc1234',
      buildDirty: true,
      buildBranch: 'lazy/release-v021',
      buildSourcePath: SOURCE_UNDER_HOME,
    });
    expect(content).toContain("export const BUILD_SHA = 'abc1234'");
    expect(content).toContain('export const BUILD_DIRTY = true');
    expect(content).toContain("export const BUILD_BRANCH = 'lazy/release-v021'");
  });

  test('captureGitBuildMetadata returns a short SHA in this repo', () => {
    const { buildSha, buildDirty } = captureGitBuildMetadata(projectRoot);
    expect(buildSha).toMatch(/^[0-9a-f]+$/);
    expect(typeof buildDirty).toBe('boolean');
  });

  test('formatDisplayPath shortens paths under $HOME', () => {
    const home = process.env.HOME || '';
    expect(formatDisplayPath(join(home, 'prg', 'lazy-dev'))).toBe('~/prg/lazy-dev');
  });

  test('formatSourceProvenanceLine matches the upgrade output shape', () => {
    expect(
      formatSourceProvenanceLine({
        buildSourcePath: SOURCE_UNDER_HOME,
        buildBranch: 'lazy/release-v021',
        buildSha: '6a69c82',
        buildDirty: false,
      }),
    ).toBe('built from ~/prg/lazy-dev @ lazy/release-v021 (6a69c82, clean)');
  });

  test('formatEmbeddedBuildProvenance is empty for dev defaults', () => {
    expect(
      formatEmbeddedBuildProvenance({
        buildSha: 'dev',
        buildBranch: 'dev',
        buildDirty: false,
        buildSourcePath: 'dev',
      }),
    ).toBe('');
  });

  test('formatEmbeddedBuildProvenance names branch, sha, dirty state, and path', () => {
    expect(
      formatEmbeddedBuildProvenance({
        buildSha: '6a69c82',
        buildBranch: 'lazy/release-v021',
        buildDirty: false,
        buildSourcePath: SOURCE_UNDER_HOME,
      }),
    ).toBe(' (lazy/release-v021@6a69c82, clean, ~/prg/lazy-dev)');
  });

  // INVARIANT: upgrade's agent-binary rebuild names the source checkout it built
  // from — branch, commit, and dirty state — so a wrong-branch rebuild is visible
  // instead of silent.
  test('captureBuildProvenance and upgrade line include branch and path', () => {
    const provenance = captureBuildProvenance(projectRoot);
    expect(provenance.buildSourcePath).toBe(projectRoot);
    expect(provenance.buildBranch.length).toBeGreaterThan(0);

    const line = formatAgentBinaryRebuildSuccessLine(provenance);
    expect(line).toBe(
      `rebuilt agent binary (verified) — ${formatSourceProvenanceLine(provenance)}`,
    );
    expect(line).toContain('built from');
    expect(line).toMatch(/\([0-9a-f]+, (clean|dirty)\)/);
  });

  test('formatAgentBinaryRebuildSuccessLine omits provenance when absent', () => {
    expect(formatAgentBinaryRebuildSuccessLine(null)).toBe('rebuilt agent binary (verified)');
  });
});

describe('formatDaemonBuiltLine', () => {
  test('dev source runs show only dev', () => {
    expect(formatDaemonBuiltLine({
      buildTime: 'dev',
      buildSha: 'dev',
      buildDirty: false,
      buildBranch: 'dev',
      buildSourcePath: 'dev',
    })).toBe('dev');
  });

  test('compiled binary shows timestamp, SHA, dirty suffix, branch, and path', () => {
    expect(
      formatDaemonBuiltLine({
        buildTime: '2026-08-24T12:00:00.000Z',
        buildSha: 'abc1234',
        buildDirty: true,
        buildBranch: 'lazy/release-v021',
        buildSourcePath: SOURCE_UNDER_HOME,
      }),
    ).toBe('2026-08-24T12:00:00.000Z (UTC) at abc1234 (dirty tree) — branch lazy/release-v021, from ~/prg/lazy-dev');
  });

  test('clean compiled build omits dirty suffix', () => {
    expect(
      formatDaemonBuiltLine({
        buildTime: '2026-08-24T12:00:00.000Z',
        buildSha: 'abc1234',
        buildDirty: false,
        buildBranch: 'main',
        buildSourcePath: SOURCE_UNDER_HOME,
      }),
    ).toBe('2026-08-24T12:00:00.000Z (UTC) at abc1234 — branch main, from ~/prg/lazy-dev');
  });
});
