/**
 * Forge comment identity, edit re-import, and the unseen-only edit rule —
 * against a real FileStorage.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage/file-storage';
import type { Storage } from '../../src/storage/interface';
import type { RemoteComment } from '../../src/remote/driver';
import { importForgeComments } from '../../src/remote/imported-comments';
import { hashCommentBody } from '../../src/remote/comment-identity';
import { editUnseenComment, CommentAlreadySeenError } from '../../src/task/comment-edit';

let root: string;
let base: string;
let storage: Storage;
let taskId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-fci-root-'));
  base = await mkdtemp(join(tmpdir(), 'lazy-fci-store-'));
  const s = new FileStorage(root, { basePath: base });
  await s.initialize();
  storage = s;
  taskId = (await storage.createTask('g', undefined, undefined, 'fci', undefined, 'claude-code')).id;
});

afterEach(async () => {
  await storage.close();
  await rm(root, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
});

const gh = (id: string, body: string, kind: RemoteComment['kind'] = 'issue_comment', extra: Partial<RemoteComment> = {}): RemoteComment =>
  ({ forge: 'github', kind, id, body, author: 'alice', createdAt: '2026-09-10T00:00:00Z', ...extra });
const format = (c: RemoteComment) => `[PR #42 @${c.author}] ${c.body}${c.path ? `\n(on file: ${c.path})` : ''}`;
const run = (remote: RemoteComment[]) => importForgeComments(storage, taskId, remote, format, 'system');

/** Mark everything created so far as delivered to the agent. */
async function deliverAll() {
  const session = await storage.createSession(taskId, 'claude-code', 'lazy/fci', 'deadbeef');
  const comments = await storage.getTaskComments(taskId);
  await storage.markNotesDelivered(session.id, Math.max(...comments.map(c => c.created_at)));
}

describe('structured forge identity', () => {
  // INVARIANT: dedup is by forge identity, never by text — two different forge
  // comments with the same words are two comments. Text matching once
  // swallowed a second "LGTM".
  test('a second identical "LGTM" with a new id is imported', async () => {
    await run([gh('1', 'LGTM')]);
    await run([gh('1', 'LGTM'), gh('2', 'LGTM')]);
    const comments = await storage.getTaskComments(taskId);
    expect(comments).toHaveLength(2);
    expect(comments.map(c => c.external?.id)).toEqual(['1', '2']);
    expect(comments[0].external).toEqual({ forge: 'github', kind: 'issue_comment', id: '1', body_hash: hashCommentBody('LGTM') });
    expect(comments[0].content).not.toContain('{remote:');
  });

  // INVARIANT: ids are unique only within a kind — an issue comment and a line
  // comment sharing a number are different items.
  test('same id, different kind: both imported', async () => {
    await run([gh('7', 'a'), gh('7', 'b', 'line_comment')]);
    expect(await storage.getTaskComments(taskId)).toHaveLength(2);
    await run([gh('7', 'a'), gh('7', 'b', 'line_comment')]);
    expect(await storage.getTaskComments(taskId)).toHaveLength(2);
  });
});

describe('legacy records', () => {
  // INVARIANT: pre-identity `{remote:<id>}` notes keep deduping, and get
  // stamped with identity so later passes can detect edits.
  test('marker notes are claimed by id and stamped, not duplicated', async () => {
    const legacy = await storage.createComment(taskId, '[PR #42 @alice] {remote:5} old text', 'system', 'remote');
    const reviewLegacy = await storage.createComment(taskId, '[PR #42 @bot] {remote:review_9} overview', 'system', 'remote');
    await run([gh('5', 'old text'), gh('9', 'overview', 'review_body')]);
    const comments = await storage.getTaskComments(taskId);
    expect(comments).toHaveLength(2);
    expect(comments.find(c => c.id === legacy.id)!.external?.id).toBe('5');
    expect(comments.find(c => c.id === reviewLegacy.id)!.external?.kind).toBe('review_body');
    expect(comments.find(c => c.id === legacy.id)!.content).toBe('[PR #42 @alice] {remote:5} old text');
  });

  test('a legacy marker shared by an issue and a line comment pairs by shape', async () => {
    await storage.createComment(taskId, '[PR #42 @alice] {remote:3} general', 'system', 'remote');
    await storage.createComment(taskId, '[PR #42 @alice] {remote:3} inline\n(on file: a.ts)', 'system', 'remote');
    await run([gh('3', 'inline', 'line_comment', { path: 'a.ts' }), gh('3', 'general')]);
    const comments = await storage.getTaskComments(taskId);
    expect(comments).toHaveLength(2);
    expect(comments.find(c => c.content.includes('inline'))!.external?.kind).toBe('line_comment');
    expect(comments.find(c => c.content.includes('general'))!.external?.kind).toBe('issue_comment');
  });

  test('GitLab {gl:<id>} marker notes are claimed too', async () => {
    const legacy = await storage.createComment(taskId, '[MR !7 @bob] {gl:9} fix it', 'system', 'remote');
    await importForgeComments(storage, taskId, [{ forge: 'gitlab', kind: 'mr_note', id: '9', body: 'fix it', author: 'bob', createdAt: '' }], format, 'system');
    const comments = await storage.getTaskComments(taskId);
    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe(legacy.id);
    expect(comments[0].external).toMatchObject({ forge: 'gitlab', kind: 'mr_note', id: '9' });
  });

  // INVARIANT: a marker only counts at the start of an imported note — a
  // human comment quoting one must not swallow that forge comment.
  test('a human comment quoting a marker does not absorb the forge comment', async () => {
    await storage.createComment(taskId, 'see {remote:5} on the PR', 'human');
    await run([gh('5', 'real comment')]);
    expect(await storage.getTaskComments(taskId)).toHaveLength(2);
  });

  // INVARIANT: unmarked link-imported notes are claimed ONE-TO-ONE by body, so
  // nothing is duplicated and a genuinely new repeat is still imported.
  test('unmarked link notes: one claim each, extra repeats imported', async () => {
    await storage.createComment(taskId, '[alice] LGTM', 'system', 'remote');
    await run([gh('1', 'LGTM'), gh('2', 'LGTM')]);
    const comments = await storage.getTaskComments(taskId);
    expect(comments).toHaveLength(2);
    expect(comments[0].content).toBe('[alice] LGTM');
    expect(comments[0].external?.id).toBe('1');
    expect(comments[1].external?.id).toBe('2');
    await run([gh('1', 'LGTM'), gh('2', 'LGTM')]);
    expect(await storage.getTaskComments(taskId)).toHaveLength(2);
  });
});

describe('edited forge comments', () => {
  // INVARIANT: an edit to a comment the agent has NOT seen replaces it in
  // place — the agent will only ever read the current version.
  test('unseen: updated in place, created_at kept', async () => {
    await run([gh('1', 'v1')]);
    const [before] = await storage.getTaskComments(taskId);
    const out = await run([gh('1', 'v2')]);
    expect(out.updatedInPlace).toHaveLength(1);
    const after = await storage.getTaskComments(taskId);
    expect(after).toHaveLength(1);
    expect(after[0].content).toBe('[PR #42 @alice] v2');
    expect(after[0].created_at).toBe(before.created_at);
    expect(after[0].edited_at).toBeDefined();
    expect(after[0].external?.body_hash).toBe(hashCommentBody('v2'));
  });

  // INVARIANT: an edit to a comment the agent HAS seen never rewrites it — it
  // arrives as a new comment naming the one it revises.
  test('seen: imported as a new revision referencing the original', async () => {
    await run([gh('1', 'v1')]);
    await deliverAll();
    await Bun.sleep(2); // delivery compares ms timestamps
    const out = await run([gh('1', 'v2')]);
    expect(out.revised).toHaveLength(1);
    const comments = await storage.getTaskComments(taskId);
    expect(comments).toHaveLength(2);
    expect(comments[0].content).toBe('[PR #42 @alice] v1');
    expect(comments[1].revises_comment_id).toBe(comments[0].id);
    expect(comments[1].content).toContain(comments[0].id.substring(0, 8));
    expect(comments[1].content).toContain('v2');
    // Stable afterwards, and a further edit revises the latest version.
    await run([gh('1', 'v2')]);
    expect(await storage.getTaskComments(taskId)).toHaveLength(2);
    await run([gh('1', 'v3')]);
    const latest = await storage.getTaskComments(taskId);
    expect(latest).toHaveLength(2);
    expect(latest[1].content).toContain('v3');
    // The still-unseen revision keeps naming the original it replaces.
    expect(latest[1].content).toContain(latest[0].id.substring(0, 8));
    expect(latest[1].revises_comment_id).toBe(latest[0].id);
  });
});

describe('editUnseenComment', () => {
  test('edits an unseen comment, refuses a seen one with the reason', async () => {
    const c = await storage.createComment(taskId, 'first', 'human');
    const edited = await editUnseenComment(storage, taskId, c.id.substring(0, 8), 'fixed');
    expect(edited.content).toBe('fixed');
    await deliverAll();
    await Bun.sleep(2); // delivery compares ms timestamps
    const err = await editUnseenComment(storage, taskId, c.id, 'again').catch(e => e);
    expect(err).toBeInstanceOf(CommentAlreadySeenError);
    expect(String(err.message)).toContain('already been delivered to the agent');
    expect((await storage.getTaskComments(taskId))[0].content).toBe('fixed');
  });
});
