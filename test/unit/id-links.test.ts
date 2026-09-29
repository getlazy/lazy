import { describe, expect, test } from 'bun:test';
import { buildIdLinkIndex, buildIdLinkIndexFrom } from '../../src/task/id-links';
import type { Storage } from '../../src/storage/interface';
import { idLinkHrefs } from '../../src/server/task-code-links';
import { renderMarkdown } from '../../src/server/markdown';
import { handleResolveIds } from '../../src/daemon/rpc-handlers';
import { READ_ONLY_RPC_COMMANDS } from '../../src/daemon/rpc-command-kinds';

const TASK = { id: 'a1b2c3d4-0000-4000-8000-000000000001', code: 'fix-login' };
const OTHER = { id: 'b0b0b0b0-0000-4000-8000-000000000002', code: null };
const RAISE = { id: '29044bce-1111-4111-8111-111111111111', task_id: TASK.id };
const COMMIT = { id: 'commit-rec-1', sha: '4f9e2c1aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5' };

function index(withContext = true) {
  return buildIdLinkIndexFrom({
    tasks: [TASK, OTHER],
    raised: [RAISE],
    contextTask: withContext ? TASK : null,
    commits: [COMMIT],
  });
}

function render(md: string, withContext = true): string {
  return renderMarkdown(md, { idLinks: idLinkHrefs(index(withContext)) });
}

describe('id links', () => {
  test('a short task id links to the task page', () => {
    expect(render('see a1b2c3d4 for context')).toContain('<a href="/tasks/fix-login" class="lz-task-link">a1b2c3d4</a>');
    expect(render('see b0b0b0b0')).toContain(`<a href="/tasks/${OTHER.id}" class="lz-task-link">b0b0b0b0</a>`);
  });

  test('a raised-item id links to its raise page', () => {
    expect(render('answered in 29044bce.')).toContain(`<a href="/raised/${RAISE.id}" class="lz-raised-link">29044bce</a>.`);
  });

  test('a 7+ char or full sha recorded on the task links to the commit page', () => {
    expect(render('landed in 4f9e2c1')).toContain('<a href="/tasks/fix-login/commits/commit-rec-1" class="lz-commit-link">4f9e2c1</a>');
    expect(render(`landed in ${COMMIT.sha}`)).toContain('/tasks/fix-login/commits/commit-rec-1');
  });

  test('a sha without a task context does not link', () => {
    expect(render('landed in 4f9e2c1', false)).not.toContain('<a');
  });

  // INVARIANT: an id nothing resolves is never a link. A guessed link sends
  // the reader to a 404 or, worse, to the wrong record.
  test('an unknown hex token is left alone', () => {
    expect(render('deadbeef and cafe1234 and 1234567')).not.toContain('<a');
  });

  // INVARIANT: code spans and fenced blocks are literal — an id in a command
  // or a log excerpt is not prose.
  test('never links inside code spans or fenced blocks', () => {
    expect(render('run `lazy show a1b2c3d4`')).not.toContain('<a');
    expect(render('```\na1b2c3d4 29044bce\n```')).not.toContain('<a');
  });

  // INVARIANT: an 8-hex string resolves task, then raise, then commit.
  test('ambiguous 8-hex resolves task before raise before commit', () => {
    const idx = buildIdLinkIndexFrom({
      tasks: [{ id: 'abcdef12-task', code: 'the-task' }],
      raised: [{ id: 'abcdef12-raise', task_id: 'x' }, { id: 'cdef1234-raise', task_id: 'x' }],
      contextTask: { id: 't', code: null },
      commits: [{ id: 'c1', sha: 'abcdef12aaaa' }, { id: 'c2', sha: 'cdef1234bbbb' }],
    });
    expect(idx.resolve('abcdef12')?.kind).toBe('task');
    expect(idx.resolve('cdef1234')?.kind).toBe('raised');
  });

  test('two tasks sharing a short id resolve to neither', () => {
    const idx = buildIdLinkIndexFrom({
      tasks: [{ id: 'abcdef12-1' }, { id: 'abcdef12-2' }],
      raised: [],
    });
    expect(idx.resolve('abcdef12')).toBeNull();
  });

  test('ids inside URLs and existing links are not re-linked', () => {
    expect(render('[the task](/tasks/a1b2c3d4)')).toBe('<p><a href="/tasks/a1b2c3d4">the task</a></p>');
    expect(render('path/a1b2c3d4')).not.toContain('lz-task-link');
  });

  test('resolveIds is a read-only RPC and refuses a non-array', async () => {
    expect(READ_ONLY_RPC_COMMANDS.has('resolveIds')).toBe(true);
    await expect(handleResolveIds({ tokens: 'abc' })).rejects.toThrow('tokens must be an array');
  });

  test('#id is linked too', () => {
    expect(render('answered in #29044bce')).toContain('>29044bce</a>');
  });

  test('a task code resolves (for remote renderers); a shared code does not', () => {
    expect(index().resolve('fix-login')).toMatchObject({ kind: 'task', taskId: TASK.id, taskCode: 'fix-login' });
    const idx = buildIdLinkIndexFrom({
      tasks: [{ id: 'aaaaaaaa-1', code: 'dup-code-1' }, { id: 'bbbbbbbb-2', code: 'dup-code-1' }],
      raised: [],
    });
    expect(idx.resolve('dup-code-1')).toBeNull();
    // A shared code never goes into a URL: the short-id target carries no code.
    expect(idx.resolve('aaaaaaaa')).toMatchObject({ kind: 'task', taskCode: null });
  });

  function fakeStorage(ended: boolean, calls: string[]): Storage {
    return {
      listTaskCodes: async () => { calls.push('codes'); return [TASK, OTHER]; },
      listRaisedItems: async () => { calls.push('raised'); return { items: [RAISE] }; },
      resolveTask: async () => ({ task: { id: TASK.id, code: TASK.code } }),
      getSessionByTaskId: async () => ({ id: 's1', ended_at: ended ? 1 : null, outcome: ended ? 'accepted' : null }),
      listSessions: async () => (ended ? [] : [{ id: 's1' }]),
      getSessionCommits: async () => { calls.push('commits'); return [COMMIT]; },
    } as unknown as Storage;
  }

  // INVARIANT: a finished task's commits still link — the commit page reads
  // the task's one session whether or not it has ended.
  test('commits link on a task whose session has ended', async () => {
    const idx = await buildIdLinkIndex(fakeStorage(true, []), { taskId: 'fix-login' });
    expect(idx.resolve('4f9e2c1')).toMatchObject({ kind: 'commit', commitId: 'commit-rec-1' });
  });

  test('with known tokens, the build skips reads no token needs', async () => {
    const calls: string[] = [];
    await buildIdLinkIndex(fakeStorage(false, calls), { taskId: 'fix-login', tokens: ['a1b2c3d4', 'fix-login'] });
    expect(calls).not.toContain('raised');
    const none: string[] = [];
    await buildIdLinkIndex(fakeStorage(false, none), { taskId: 'fix-login', tokens: ['fix-login'] });
    expect(none).toEqual(['codes']);
  });
});
