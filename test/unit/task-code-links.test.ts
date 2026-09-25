/**
 * Autolink matching is deliberately narrower than `validateCode`. Short codes
 * like `ab` remain creatable; we just refuse to light them up in prose.
 */

import { describe, test, expect } from 'bun:test';
import {
  AUTOLINK_TASK_CODE_MIN_LENGTH,
  buildTaskCodeLinkify,
  isAutolinkableTaskCode,
} from '../../src/server/task-code-links';

describe('isAutolinkableTaskCode', () => {
  test('requires length ≥ 8 and a hyphen, underscore, or digit', () => {
    expect(AUTOLINK_TASK_CODE_MIN_LENGTH).toBe(8);
    expect(isAutolinkableTaskCode('ab')).toBe(false);
    expect(isAutolinkableTaskCode('services')).toBe(false); // 8 letters, no slug marker
    expect(isAutolinkableTaskCode('add-log')).toBe(false); // hyphen, but only 7
    expect(isAutolinkableTaskCode('fix-docs-release-wiring')).toBe(true);
    expect(isAutolinkableTaskCode('debug1234')).toBe(true);
  });
});

describe('buildTaskCodeLinkify', () => {
  test('omits duplicate codes rather than guessing', () => {
    const table = buildTaskCodeLinkify([
      { id: 'aaa', code: 'fix-docs-release-wiring' },
      { id: 'bbb', code: 'fix-docs-release-wiring' },
    ]);
    expect(table.lookup.size).toBe(0);
  });

  test('skips short codes and missing codes', () => {
    const table = buildTaskCodeLinkify([
      { id: 'aaa', code: 'ab' },
      { id: 'bbb', code: null },
      { id: 'ccc', code: 'raised-item-ux' },
    ]);
    expect([...table.lookup.keys()]).toEqual(['raised-item-ux']);
    // Prose link hrefs name the task the way the routes resolve it — by code.
    expect(table.lookup.get('raised-item-ux')).toBe('/tasks/raised-item-ux');
    expect(table.matchWords).toBe(true);
  });
});
