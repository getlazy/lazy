import { describe, test, expect } from 'bun:test';
import {
  submitConfirmMatches,
  submitTierFromPreflight,
  submitPlainConfirmText,
  submitStrongConfirmText,
  type SubmitPreflight,
} from '../../src/submit-confirmation';

function preflight(over: Partial<SubmitPreflight> = {}): SubmitPreflight {
  return {
    canSubmit: true,
    targetBranch: 'main',
    taskCode: 'fix-auth',
    targetIsProtected: true,
    confirmationTier: 'plain',
    forgeName: 'GitHub',
    ...over,
  };
}

describe('submit confirmation tiers', () => {
  test('protected target without an existing PR is plain', () => {
    expect(submitTierFromPreflight({
      canSubmit: true,
      targetIsProtected: true,
    })).toBe('plain');
  });

  test('unprotected or unknown is strong — fail toward the stronger prompt', () => {
    expect(submitTierFromPreflight({
      canSubmit: true,
      targetIsProtected: false,
    })).toBe('strong');
    expect(submitTierFromPreflight({
      canSubmit: true,
      targetIsProtected: 'unknown',
    })).toBe('strong');
  });

  test('an existing PR stays plain even on an unprotected target', () => {
    expect(submitTierFromPreflight({
      canSubmit: true,
      targetIsProtected: false,
      existingPrUrl: 'https://github.com/acme/repo/pull/1',
    })).toBe('plain');
  });

  test('typed confirmation matches the branch or the task code', () => {
    const p = preflight();
    expect(submitConfirmMatches('main', p, 'fix-auth')).toBe(true);
    expect(submitConfirmMatches('  fix-auth  ', p, 'fix-auth')).toBe(true);
    expect(submitConfirmMatches('other', p, 'fix-auth')).toBe(false);
    expect(submitConfirmMatches('', p, 'fix-auth')).toBe(false);
  });

  test('wording names the target and the forge', () => {
    expect(submitPlainConfirmText(preflight())).toContain('main');
    expect(submitPlainConfirmText(preflight())).toContain('GitHub');
    expect(submitStrongConfirmText(preflight({ targetIsProtected: false }))).toContain('not protected');
  });
});
