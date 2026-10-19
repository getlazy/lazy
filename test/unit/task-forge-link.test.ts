import { describe, test, expect } from 'bun:test';
import {
  resolveTaskForgeLink,
  formatTaskForgeLink,
  formatTaskForgeShowLine,
} from '../../src/task-forge-link';
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

describe('resolveTaskForgeLink', () => {
  test('reads the GitHub keys the driver writes, with no network', () => {
    const link = resolveTaskForgeLink(
      task({
        github_remote_ref_url: 'https://github.com/acme/repo/pull/412',
        github_remote_ref_id: '412',
      }),
    );
    expect(link).toEqual({
      url: 'https://github.com/acme/repo/pull/412',
      kind: 'pr',
      forge: 'github',
      id: '412',
    });
    expect(formatTaskForgeLink(link!)).toBe('PR #412');
    expect(formatTaskForgeShowLine(link!)).toBe('PR: https://github.com/acme/repo/pull/412');
  });

  test('falls back through the older GitHub spellings', () => {
    const link = resolveTaskForgeLink(
      task({
        remote_ref_url: 'https://github.com/acme/repo/pull/7',
        github_pr_number: '7',
      }),
    );
    expect(link?.forge).toBe('github');
    expect(link?.id).toBe('7');
  });

  test('reads GitLab MR metadata as kind mr', () => {
    const link = resolveTaskForgeLink(
      task({
        gitlab_remote_ref_url: 'https://gitlab.com/acme/repo/-/merge_requests/9',
        gitlab_remote_ref_id: '9',
      }),
    );
    expect(link).toEqual({
      url: 'https://gitlab.com/acme/repo/-/merge_requests/9',
      kind: 'mr',
      forge: 'gitlab',
      id: '9',
    });
    expect(formatTaskForgeLink(link!)).toBe('MR #9');
  });

  test('returns null when the task has no stored forge link', () => {
    expect(resolveTaskForgeLink(task(null))).toBeNull();
    expect(resolveTaskForgeLink(task({}))).toBeNull();
  });
});

describe('forge link schemes', () => {
  // INVARIANT: only an http(s) URL in task metadata becomes a forge link. The
  // link renders as an href on the dashboard origin; a javascript: value there
  // is script with the session's authority, whoever wrote the metadata.
  test('a non-http(s) URL is no link at all', () => {
    expect(resolveTaskForgeLink(task({ github_pr_url: 'javascript:alert(1)//pull/1' }))).toBeNull();
    expect(resolveTaskForgeLink(task({ gitlab_remote_ref_url: 'data:text/html,x' }))).toBeNull();
    expect(resolveTaskForgeLink(task({ remote_ref_url: 'not a url' }))).toBeNull();
    expect(resolveTaskForgeLink(task({ github_pr_url: 'https://github.com/o/r/pull/7' }))?.url)
      .toBe('https://github.com/o/r/pull/7');
  });
});
