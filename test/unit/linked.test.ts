import { describe, test, expect } from 'bun:test';
import {
  isLinkedTask,
  linkedBranchOf,
  linkedSourceOf,
  formatLinkedMarker,
  applyLinkIdentity,
  IMPORT_SOURCE_URL_KEY,
  IMPORT_SOURCE_BRANCH_KEY,
} from '../../src/task/linked';
import type { Task } from '../../src/types';

function task(metadata: Record<string, string> | null): Task {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    code: 'demo',
    goal: 'g',
    prompt: 'p',
    type: 'task',
    status: 'blocked',
    priority: 'normal',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata,
  } as unknown as Task;
}

describe('linked-task helpers', () => {
  test('isLinkedTask is true when either identity key is set', () => {
    expect(isLinkedTask(task(null))).toBe(false);
    expect(isLinkedTask(task({}))).toBe(false);
    expect(isLinkedTask(task({ [IMPORT_SOURCE_URL_KEY]: 'feature/x' }))).toBe(true);
    expect(isLinkedTask(task({ [IMPORT_SOURCE_BRANCH_KEY]: 'feature/x' }))).toBe(true);
  });

  test('applyLinkIdentity writes the canonical keys without dropping others', () => {
    const next = applyLinkIdentity(
      { github_remote_ref_url: 'https://github.com/acme/repo/pull/1' },
      'https://github.com/acme/repo/pull/1',
      'feature/x',
    );
    expect(next[IMPORT_SOURCE_URL_KEY]).toBe('https://github.com/acme/repo/pull/1');
    expect(next[IMPORT_SOURCE_BRANCH_KEY]).toBe('feature/x');
    expect(next.github_remote_ref_url).toBe('https://github.com/acme/repo/pull/1');
  });

  test('formatLinkedMarker prefers forge + branch when both exist', () => {
    const t = task({
      [IMPORT_SOURCE_URL_KEY]: 'https://github.com/acme/repo/pull/12',
      [IMPORT_SOURCE_BRANCH_KEY]: 'feature/x',
      github_remote_ref_url: 'https://github.com/acme/repo/pull/12',
      github_remote_ref_id: '12',
    });
    expect(linkedBranchOf(t)).toBe('feature/x');
    expect(linkedSourceOf(t)).toBe('https://github.com/acme/repo/pull/12');
    expect(formatLinkedMarker(t)).toBe('linked feature/x · PR #12');
  });

  test('formatLinkedMarker falls back to the branch alone', () => {
    expect(formatLinkedMarker(task({ [IMPORT_SOURCE_BRANCH_KEY]: 'feature/x' })))
      .toBe('linked feature/x');
  });
});
