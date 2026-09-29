import { describe, expect, test } from 'bun:test';
import { formatLfsEnvironmentCheck } from '../../src/doctor/sweep';
import type { LfsEnvironmentReport } from '../../src/git/lfs';

const report: LfsEnvironmentReport = {
  usesLfs: true,
  binaryPresent: false,
  filters: { process: '', clean: '', smudge: '' },
  required: false,
  problems: [
    { code: 'binary-missing', message: 'git-lfs is missing', remedy: 'Install git-lfs' },
    { code: 'filter-unset', message: 'filter unset', remedy: 'Run git lfs install --local' },
    { code: 'not-required', message: 'filter not required', remedy: 'Run git config filter.lfs.required true' },
  ],
};

describe('LFS doctor remedies', () => {
  test('managed projects name the operator action and project restart, not member shell commands', () => {
    const result = formatLfsEnvironmentCheck(report, null, true);
    expect(result.detail).toContain('operator must rebuild and roll');
    expect(result.detail).toContain('retry after restarting the project');
    expect(result.detail).not.toContain('Run git lfs install');
    expect(result.remedy).toContain('Restart the project');
  });

  test('solo repositories retain their owner-operated remedies', () => {
    const result = formatLfsEnvironmentCheck(report, null, false);
    expect(result.detail).toContain('Run git lfs install --local');
    expect(result.remedy).toContain('Install git-lfs');
  });
});
