import { describe, test, expect } from 'bun:test';
import { searchResultHref } from '../../src/server/command-palette';

describe('searchResultHref for id-addressed entities', () => {
  const base = { task_id: 't-uuid', task_code: 'demo' };
  // INVARIANT: each id hit links to where that entity lives, not to the bare task page.
  test.each([
    ['comment', 'c1', '/tasks/demo/comments#comment-c1'],
    ['journal', 'j1', '/tasks/demo/journal#journal-j1'],
    ['commit', 'k1', '/tasks/demo/commits/k1'],
    ['artifact', 'a1', '/tasks/demo/artifacts'],
    ['review_comment', 'r1', '/tasks/demo/changes'],
    ['raised', 'q1', '/raised/q1'],
  ])('%s', (type, id, href) => {
    expect(searchResultHref({ ...base, entity_type: type, entity_id: id })).toBe(href);
  });
  test('message has no task and links to the message page', () => {
    expect(searchResultHref({ entity_type: 'message', entity_id: 'm1', task_id: '' })).toBe('/messages/m1');
  });
});
