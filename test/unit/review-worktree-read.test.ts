import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readWorktreeFileNoFollow } from '../../src/review/worktree-read';

/**
 * The expand-context endpoint reads files out of an AGENT-WRITABLE worktree on
 * behalf of a browser. The diff's file list decides which PATH may be read; this
 * reader decides which BYTES that path is allowed to resolve to.
 */
describe('readWorktreeFileNoFollow', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    // realpath the temp root: on macOS tmpdir() is /var/... -> /private/var/...,
    // and comparing an unresolved root against resolved paths reports every read
    // as an escape (the same trap CLAUDE.md flags for git-printed paths).
    const base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-wtread-')));
    root = join(base, 'worktree');
    outside = join(base, 'outside');
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, 'docs', 'real.md'), 'one\ntwo\n');
    await writeFile(join(outside, 'secret.txt'), 'SUPER SECRET\n');
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  test('reads a regular file inside the worktree', async () => {
    const r = await readWorktreeFileNoFollow(root, 'docs/real.md');
    expect(r).toEqual({ kind: 'content', content: 'one\ntwo\n' });
  });

  // INVARIANT: never follow a symlink out of the worktree. A task branch is
  // agent-writable, so an agent can COMMIT docs/x.md as a symlink to /etc/passwd
  // — that path is genuinely in the diff and passes the file allow-list, so if
  // this followed the link the reviewer's browser would be handed the target's
  // content from the host.
  test('does not follow a symlink that points outside the worktree', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'docs', 'evil.md'));
    const r = await readWorktreeFileNoFollow(root, 'docs/evil.md');
    expect(r).toEqual({ kind: 'notRegular' });
  });

  // Not just the escaping ones: a symlink is rendered by git as its target
  // string, so following ANY of them would make expanded context disagree with
  // the hunks around it.
  test('does not follow a symlink that points inside the worktree either', async () => {
    await symlink(join(root, 'docs', 'real.md'), join(root, 'docs', 'alias.md'));
    expect(await readWorktreeFileNoFollow(root, 'docs/alias.md')).toEqual({ kind: 'notRegular' });
  });

  test('reports a directory as not a regular file', async () => {
    expect(await readWorktreeFileNoFollow(root, 'docs')).toEqual({ kind: 'notRegular' });
  });

  // INVARIANT: defence in depth for the parents this cannot lstat one by one —
  // a symlinked DIRECTORY would otherwise make the final component a perfectly
  // ordinary regular file that lives somewhere else entirely.
  test('refuses a path whose parent directory escapes the worktree', async () => {
    await symlink(outside, join(root, 'linkdir'));
    const r = await readWorktreeFileNoFollow(root, 'linkdir/secret.txt');
    expect(r.kind).toBe('outside');
    if (r.kind === 'outside') expect(r.resolved).toContain('secret.txt');
  });

  test('reports a missing file and a missing directory as missing', async () => {
    expect(await readWorktreeFileNoFollow(root, 'docs/nope.md')).toEqual({ kind: 'missing' });
    expect(await readWorktreeFileNoFollow(root, 'nodir/nope.md')).toEqual({ kind: 'missing' });
  });

  test('reports a missing worktree as missing rather than throwing', async () => {
    expect(await readWorktreeFileNoFollow(join(root, 'gone'), 'a.md')).toEqual({ kind: 'missing' });
  });
});
