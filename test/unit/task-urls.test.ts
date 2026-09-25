/**
 * The one helper every `/tasks/<segment>` link in the web UI builds through.
 *
 * The rules it encodes are the ones `Storage.getTask` resolves against: a code
 * URL resolves to the same task the UUID does, a codeless task must never
 * produce an empty segment, and a code shared by two tasks must not be used as
 * a segment by either of them (the resolver would pick a winner the link did
 * not mean).
 */

import { describe, test, expect } from 'bun:test';
import {
  decodePathSegment,
  duplicateTaskCodes,
  taskCodeTables,
  taskPath,
  taskPathByTaskId,
  taskPathSegment,
  type TaskPathRef,
} from '../../src/server/task-urls';
import { RESERVED_TASK_PATH_SEGMENTS } from '../../src/task/identity';

describe('taskPathSegment', () => {
  test('prefers the code when the task has one', () => {
    expect(taskPathSegment({ id: '9c24b60c-0000', code: 'teams-cli-login' })).toBe('teams-cli-login');
    expect(taskPath({ id: '9c24b60c-0000', code: 'teams-cli-login' })).toBe('/tasks/teams-cli-login');
  });

  test('falls back to the id for a codeless task — never an empty segment', () => {
    // INVARIANT: a task with code: null still gets a working href; a broken
    // href is worse than an ugly one.
    expect(taskPathSegment({ id: '9c24b60c-0000', code: null })).toBe('9c24b60c-0000');
    expect(taskPathSegment({ id: '9c24b60c-0000' })).toBe('9c24b60c-0000');
  });

  test('falls back to the id when the caller says the code is duplicated', () => {
    // INVARIANT: a duplicated code URL resolves to ONE winner by the
    // disambiguation `lazy <task>` uses, which may not be the task the link
    // meant — so a duplicated code must not be used as a segment at all.
    const dups = new Set(['shared-code']);
    expect(taskPathSegment({ id: 'id-a', code: 'shared-code' }, dups)).toBe('id-a');
    expect(taskPathSegment({ id: 'id-b', code: 'shared-code' }, dups)).toBe('id-b');
    // An unduplicated code in the same set is unaffected.
    expect(taskPathSegment({ id: 'id-c', code: 'unique-code' }, dups)).toBe('unique-code');
    // A ref with no id has nothing better to fall back to: the code survives.
    expect(taskPathSegment({ code: 'shared-code' }, dups)).toBe('shared-code');
  });

  test('URL-escapes the segment', () => {
    expect(taskPathSegment({ id: 'a b/c?d' })).toBe('a%20b%2Fc%3Fd');
  });

  test('throws when a ref has neither id nor code', () => {
    expect(() => taskPathSegment({ code: '' })).toThrow('neither id nor code');
  });
});

describe('duplicateTaskCodes', () => {
  test('collects codes carried by more than one task', () => {
    const dups = duplicateTaskCodes([
      { id: 'a', code: 'dup-code' },
      { id: 'b', code: 'dup-code' },
      { id: 'c', code: 'solo-code' },
      { id: 'd', code: null },
    ]);
    expect(dups.has('dup-code')).toBe(true);
    expect(dups.has('solo-code')).toBe(false);
  });
});

describe('taskCodeTables / taskPathByTaskId', () => {
  const tables = taskCodeTables([
    { id: 'id-a', code: 'alpha-code' },
    { id: 'id-b', code: 'shared-dup' },
    { id: 'id-c', code: 'shared-dup' },
    { id: 'id-d', code: null },
  ]);

  test('resolves a code by id, dup-aware', () => {
    expect(taskPathByTaskId(tables, 'id-a')).toBe('/tasks/alpha-code');
    expect(taskPathByTaskId(tables, 'id-b')).toBe('/tasks/id-b');
    expect(taskPathByTaskId(tables, 'id-c')).toBe('/tasks/id-c');
  });

  test('a codeless task links by id', () => {
    expect(taskPathByTaskId(tables, 'id-d')).toBe('/tasks/id-d');
  });

  test('an unknown id still links by id', () => {
    expect(taskPathByTaskId(tables, 'id-unknown')).toBe('/tasks/id-unknown');
  });

  test('appends the suffix', () => {
    expect(taskPathByTaskId(tables, 'id-a', '/changes')).toBe('/tasks/alpha-code/changes');
  });
});

describe('decodePathSegment', () => {
  // INVARIANT: escaping on generation and decoding on resolution are a PAIR.
  // `taskPathSegment` escapes every segment exactly once; if nothing undoes
  // that, a code carrying a URL-significant character is escaped into an
  // address that resolves to no task — unreachable by every spelling, which is
  // worse than never having linked it by code at all.
  test('round-trips whatever taskPathSegment escaped', () => {
    for (const code of ['my task', 'a/b', 'a?b', 'a#b', 'a%b', 'héllo', 'plain-code']) {
      expect(decodePathSegment(taskPathSegment({ id: 'i', code }))).toBe(code);
    }
  });

  test('is the identity on a DNS-label code — the ordinary case is untouched', () => {
    expect(decodePathSegment('teams-cli-login')).toBe('teams-cli-login');
  });

  test('leaves a UUID segment alone, so permalinks keep resolving', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(decodePathSegment(taskPathSegment({ id }))).toBe(id);
  });

  // INVARIANT: a malformed escape must not throw. Anyone can type `/tasks/%zz`
  // and `decodeURIComponent` raises URIError on it — thrown out of the router's
  // path split, that is a 500 on a URL a user typed. Falling back to the raw
  // text simply matches no task, which is the 404 the handler already renders.
  test('a malformed percent-escape falls back to the raw text instead of throwing', () => {
    expect(() => decodePathSegment('%zz')).not.toThrow();
    expect(decodePathSegment('%zz')).toBe('%zz');
    expect(decodePathSegment('100%')).toBe('100%');
  });
});

/**
 * A code the router reserves under `/tasks/` never becomes a link segment.
 *
 * INVARIANT: `/tasks/new` and `/tasks/link` are matched as the create and link
 * FORMS before anything tries to resolve a task, so a task coded `new` linked
 * by its code would open the create page instead of the task — a link that
 * silently goes somewhere else, which is worse than an ugly UUID.
 *
 * This is the SECOND half of the guard and it cannot be dropped in favour of
 * the first: `validateCode` refuses such a code, but it only ever ran on NEW
 * codes, so a store can already hold one. Generation must cope rather than
 * trust validation — the same reason the duplicate-code fallback exists.
 */
describe('a reserved router segment is never used as a code', () => {
  test('falls back to the id for every reserved segment', () => {
    for (const code of RESERVED_TASK_PATH_SEGMENTS) {
      const ref = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', code };
      expect(taskPathSegment(ref), code).toBe(ref.id);
      expect(taskPath(ref), code).toBe(`/tasks/${ref.id}`);
    }
  });

  test('a code merely containing a reserved word still links by code', () => {
    expect(taskPath({ id: 'i', code: 'new-parser' })).toBe('/tasks/new-parser');
    expect(taskPath({ id: 'i', code: 'link-checker' })).toBe('/tasks/link-checker');
  });

  // Symmetric with the codeless and duplicated cases: the fallback needs an id
  // to fall back TO. With none, the code is still the only thing that can be
  // linked, and an empty href would be strictly worse.
  test('with no id to fall back to, the code is still used', () => {
    expect(taskPathSegment({ code: 'new' })).toBe('new');
  });
});
