/**
 * `listUncommittedPaths` — the names behind `hasUncommittedChanges`'s yes/no.
 *
 * Both answer the same question about the same worktree, from one shared
 * exclusion list, because the end-of-turn nudge asks the agent about the paths
 * and the accept gate refuses over the predicate. A worktree the gate calls
 * dirty and the list calls empty (or the reverse) is a task that cannot be
 * accepted and cannot be told why.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  listUncommittedPaths,
  hasUncommittedChanges,
  patchIsAlreadyApplied,
  applyPatch,
  snapshotFiles,
  patchPaths,
  getUncommittedDiff,
} from '../../src/git/operations';

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe('listUncommittedPaths', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'lazy-uncommitted-'));
    git(repo, 'init');
    git(repo, 'config', 'user.email', 't@t.com');
    git(repo, 'config', 'user.name', 'T');
    await writeFile(join(repo, 'README.md'), '# R\n', 'utf-8');
    await writeFile(join(repo, 'tracked.txt'), 'one\n', 'utf-8');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('a clean worktree lists nothing', async () => {
    expect(await listUncommittedPaths(repo)).toEqual([]);
    expect(await hasUncommittedChanges(repo)).toBe(false);
  });

  test('modified, staged and untracked paths all count', async () => {
    await writeFile(join(repo, 'tracked.txt'), 'two\n', 'utf-8');
    await writeFile(join(repo, 'staged.txt'), 'new\n', 'utf-8');
    git(repo, 'add', 'staged.txt');
    await writeFile(join(repo, 'untracked.md'), 'loose\n', 'utf-8');

    const paths = await listUncommittedPaths(repo);
    expect(paths?.sort()).toEqual(['staged.txt', 'tracked.txt', 'untracked.md']);
    expect(await hasUncommittedChanges(repo)).toBe(true);
  });

  // INVARIANT: the FIRST path is not mangled. `runGit` trims stdout and an
  // unstaged modification's porcelain status begins with a space (` M
  // README.md`), so a `slice(3)` parser over that output returns `EADME.md` —
  // and only for the first record, which is what makes such a parser look
  // right. This suite asserts the names, so the trap cannot come back quietly.
  test('an unstaged modification is reported whole, even as the first path', async () => {
    await writeFile(join(repo, 'README.md'), '# edited\n', 'utf-8');
    expect(await listUncommittedPaths(repo)).toEqual(['README.md']);
  });

  // A name the porcelain format would C-quote. The whole point of the record is
  // to tell a human which file to open, and a mangled name is worst exactly for
  // the files hardest to retype.
  test('a path with a space is reported verbatim, not quoted', async () => {
    await writeFile(join(repo, 'a note.md'), 'x\n', 'utf-8');
    expect(await listUncommittedPaths(repo)).toEqual(['a note.md']);
  });

  test('a staged rename reports the destination once', async () => {
    git(repo, 'mv', 'tracked.txt', 'renamed.txt');
    const paths = await listUncommittedPaths(repo);
    expect(paths).toEqual(['renamed.txt']);
  });

  // INVARIANT: an untracked DIRECTORY is reported as its files, not as itself.
  // `git status` collapses a wholly untracked one to `public-docs/`, and the
  // whole point of the record is to name the file a reviewer has to look at —
  // `public-docs/` sends them back to the `git status` this exists to save them.
  test('a wholly untracked directory lists its files, not the directory', async () => {
    await mkdir(join(repo, 'public-docs'), { recursive: true });
    await writeFile(join(repo, 'public-docs', 'troubleshooting.md'), 'page\n', 'utf-8');
    await writeFile(join(repo, 'public-docs', 'other.md'), 'page\n', 'utf-8');

    const paths = await listUncommittedPaths(repo);
    expect(paths?.sort()).toEqual(['public-docs/other.md', 'public-docs/troubleshooting.md']);
  });

  // INVARIANT: lazy's own runtime artifacts are not the agent's work. The
  // session lock especially — a crashed session leaves a stale one behind, and
  // counting it would nudge every recovered turn about a file it did not write.
  test("lazy's own artifacts are excluded, exactly as the accept gate excludes them", async () => {
    await mkdir(join(repo, '.lazy-task-sandbox'), { recursive: true });
    await writeFile(join(repo, '.lazy-task-sandbox', 'protocol.json'), '{}\n', 'utf-8');
    await writeFile(join(repo, '.lazy-lock'), 'pid\n', 'utf-8');

    expect(await listUncommittedPaths(repo)).toEqual([]);
    expect(await hasUncommittedChanges(repo)).toBe(false);
  });

  // INVARIANT: a failed scan answers null, NOT an empty array. The empty array
  // is a claim ("checked, nothing loose") that a turn record and a review both
  // act on; "I could not look" must never be recorded as that claim.
  test('a directory that is not a repository answers null, not empty', async () => {
    const notRepo = await mkdtemp(join(tmpdir(), 'lazy-not-a-repo-'));
    try {
      expect(await listUncommittedPaths(notRepo)).toBeNull();
    } finally {
      await rm(notRepo, { recursive: true, force: true });
    }
  });

  /**
   * The two helpers behind the unblock-time snapshot restore.
   *
   * A snapshot is written only when a turn ends dirty and nothing ever
   * supersedes it, so the FIRST unblock after the agent finally commits those
   * edits replays a patch already in HEAD. `git apply` refuses, and the restore
   * used to report that as "Could not restore uncommitted changes from backup"
   * — the echo of work being SAVED, reported as work being lost, on exactly the
   * turns adjacent to a real loss. It sent a whole investigation after the
   * wrong mechanism.
   */
  /**
   * INVARIANT: a captured worktree patch can be restored. The capture is taken
   * VERBATIM (`trim: false`), because a patch's whitespace is content: git
   * writes an empty context line as a single space, so a section ending on a
   * blank line ends `" \n"` and `runGit`'s default trim eats both characters,
   * leaving a hunk body one line shorter than its `@@` header promises. `git
   * apply` rejects the ENTIRE patch for that, so one blank line at the end of
   * one file's diff costs every other file's edits too.
   *
   * The apply-time repair in `patchBytes` STAYS, and is pinned separately
   * below: every snapshot already in the store was captured trimmed, and those
   * are exactly the ones somebody needs back.
   */
  describe('capture and restore round-trip', () => {
    test('a capture of staged AND unstaged work restores both', async () => {
      await writeFile(join(repo, 'tracked.txt'), 'staged edit\n', 'utf-8');
      git(repo, 'add', 'tracked.txt');
      await writeFile(join(repo, 'README.md'), '# unstaged edit\n', 'utf-8');

      // Exactly what the reconciler stores and the unblock path replays.
      const captured = await getUncommittedDiff(repo);
      expect(captured.endsWith('\n')).toBe(true); // captured verbatim, not trimmed
      const patch = captured
        .replace(/^--- STAGED CHANGES ---\n/gm, '')
        .replace(/^--- UNSTAGED CHANGES ---\n/gm, '');

      // The worktree goes back to HEAD, as a recreated one would be.
      git(repo, 'reset', '--hard', 'HEAD');
      expect(await listUncommittedPaths(repo)).toEqual([]);

      expect(await applyPatch(patch, repo)).toBe(true);
      expect((await listUncommittedPaths(repo))?.sort()).toEqual(['README.md', 'tracked.txt']);
    });

    /**
     * INVARIANT: a blank line at the end of a hunk survives the capture.
     *
     * This is the trim's third and worst form. A file ending in a blank line,
     * edited near EOF, produces a hunk whose LAST line is an empty context line
     * — which git writes as a single space. Trimming takes the space and the
     * newline before it, so the hunk body is one line short of what its `@@`
     * header declares, and `git apply` answers `corrupt patch at line N` and
     * throws out THE WHOLE PATCH: the untracked sections, every other file's
     * edits, all of it. The unblock then lands straight back in "Could not
     * restore uncommitted changes from backup", which is the exact failure this
     * task exists to close.
     *
     * Not repairable at apply time, either. `patchBytes` can put back the
     * newline ending the whole patch, but when an unstaged or untracked section
     * FOLLOWS the staged one, the missing blank line is in the middle of the
     * patch where no end-of-string fixup can reach it — which is why the fix is
     * at capture.
     */
    test('a blank line ending a hunk survives, and the rest of the patch with it', async () => {
      // Ends with a blank line, and the edit lands within three lines of EOF,
      // so the hunk's trailing context IS that blank line.
      await writeFile(join(repo, 'doc.md'), 'alpha\nbeta\ngamma\n\n', 'utf-8');
      git(repo, 'add', 'doc.md');
      git(repo, 'commit', '-m', 'Seed a doc that ends in a blank line');

      await writeFile(join(repo, 'doc.md'), 'alpha\nbeta\nGAMMA\n\n', 'utf-8');
      // A second file, to pin the blast radius: one bad hunk used to cost this
      // file's edit too, since git apply rejects the patch as a whole.
      await writeFile(join(repo, 'README.md'), '# also edited\n', 'utf-8');

      const patch = (await getUncommittedDiff(repo))
        .replace(/^--- UNSTAGED CHANGES ---\n/gm, '');

      git(repo, 'reset', '--hard', 'HEAD');
      expect(await listUncommittedPaths(repo)).toEqual([]);

      expect(await applyPatch(patch, repo)).toBe(true);
      expect(await Bun.file(join(repo, 'doc.md')).text()).toBe('alpha\nbeta\nGAMMA\n\n');
      expect(await Bun.file(join(repo, 'README.md')).text()).toBe('# also edited\n');
    });

    /**
     * The same trap with a section AFTER it — the form no apply-time repair can
     * reach, because the lost blank line ends up mid-patch rather than at its
     * tail. Staged edit ending in a blank line, then an unstaged edit and an
     * untracked file following it in the capture.
     */
    test('a staged hunk ending blank survives when other sections follow it', async () => {
      await writeFile(join(repo, 'doc.md'), 'one\ntwo\nthree\n\n', 'utf-8');
      git(repo, 'add', 'doc.md');
      git(repo, 'commit', '-m', 'Seed');

      await writeFile(join(repo, 'doc.md'), 'one\ntwo\nTHREE\n\n', 'utf-8');
      git(repo, 'add', 'doc.md');                                    // staged
      await writeFile(join(repo, 'README.md'), '# unstaged\n', 'utf-8'); // unstaged
      await writeFile(join(repo, 'fresh.md'), '# untracked\n', 'utf-8'); // untracked

      const patch = (await getUncommittedDiff(repo))
        .replace(/^--- STAGED CHANGES ---\n/gm, '')
        .replace(/^--- UNSTAGED CHANGES ---\n/gm, '')
        .replace(/^--- UNTRACKED FILES ---\n/gm, '');

      git(repo, 'reset', '--hard', 'HEAD');
      await rm(join(repo, 'fresh.md'), { force: true });
      expect(await listUncommittedPaths(repo)).toEqual([]);

      expect(await applyPatch(patch, repo)).toBe(true);
      expect(await Bun.file(join(repo, 'doc.md')).text()).toBe('one\ntwo\nTHREE\n\n');
      expect(await Bun.file(join(repo, 'README.md')).text()).toBe('# unstaged\n');
      expect(await Bun.file(join(repo, 'fresh.md')).text()).toBe('# untracked\n');
    });

    /**
     * INVARIANT: the apply-time tail repair STAYS. Every snapshot written
     * before the capture was fixed is trimmed, and those are the ones somebody
     * needs back — so `applyPatch` must still accept a patch that ends
     * mid-line. This feeds it one, trimmed exactly as `runGit` used to.
     */
    test('a patch trimmed the old way still applies', async () => {
      await writeFile(join(repo, 'README.md'), '# edited\n', 'utf-8');
      const asOldSnapshotsWereStored = (await getUncommittedDiff(repo))
        .replace(/^--- UNSTAGED CHANGES ---\n/gm, '')
        .trim();
      expect(asOldSnapshotsWereStored.endsWith('\n')).toBe(false);

      git(repo, 'reset', '--hard', 'HEAD');
      expect(await applyPatch(asOldSnapshotsWereStored, repo)).toBe(true);
      expect(await Bun.file(join(repo, 'README.md')).text()).toBe('# edited\n');
    });

    /**
     * INVARIANT: an UNTRACKED file's CONTENT is in the snapshot, not just its
     * name. `git diff` describes only what the index already knows, so for its
     * whole existence this capture stored nothing at all for a new file — while
     * the accompanying `git status` named it, so the restore could report
     * success having put back zero bytes, and a failure could tell a human
     * their file was "still in the snapshot" when the snapshot never held it.
     *
     * A NEW FILE IS THE SHAPE OF THE LOSS THIS MECHANISM EXISTS FOR: the
     * reported case was a new `public-docs/troubleshooting.md` written by an
     * end-of-turn check.
     */
    test('an untracked new file round-trips, content and all', async () => {
      await mkdir(join(repo, 'public-docs'), { recursive: true });
      await writeFile(join(repo, 'public-docs/troubleshooting.md'), '# why it failed\n', 'utf-8');
      await writeFile(join(repo, 'README.md'), '# edited too\n', 'utf-8');

      const patch = (await getUncommittedDiff(repo))
        .replace(/^--- UNSTAGED CHANGES ---\n/gm, '')
        .replace(/^--- UNTRACKED FILES ---\n/gm, '');

      git(repo, 'reset', '--hard', 'HEAD');
      await rm(join(repo, 'public-docs'), { recursive: true, force: true });
      expect(await listUncommittedPaths(repo)).toEqual([]);

      expect(await applyPatch(patch, repo)).toBe(true);
      expect((await listUncommittedPaths(repo))?.sort()).toEqual([
        'README.md',
        'public-docs/troubleshooting.md',
      ]);
      expect(await Bun.file(join(repo, 'public-docs/troubleshooting.md')).text()).toBe('# why it failed\n');
    });

    /**
     * INVARIANT: a binary untracked file is NAMED but not captured, and its
     * presence does not cost the rest of the patch. `git diff` renders binary
     * content as "Binary files … differ", a line `git apply` rejects — one of
     * them in the patch would fail the whole apply and take the recoverable
     * text edits down with it.
     */
    test('a binary untracked file does not break the rest of the patch', async () => {
      await writeFile(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3, 255]));
      await writeFile(join(repo, 'README.md'), '# still recoverable\n', 'utf-8');

      const patch = (await getUncommittedDiff(repo))
        .replace(/^--- UNSTAGED CHANGES ---\n/gm, '')
        .replace(/^--- UNTRACKED FILES ---\n/gm, '');
      expect(patchPaths(patch)).not.toContain('blob.bin');

      git(repo, 'reset', '--hard', 'HEAD');
      await rm(join(repo, 'blob.bin'), { force: true });

      expect(await applyPatch(patch, repo)).toBe(true);
      expect(await Bun.file(join(repo, 'README.md')).text()).toBe('# still recoverable\n');
    });

    /**
     * INVARIANT: a modified TRACKED binary does not poison the snapshot.
     *
     * The two tracked captures used to run without `--binary`, so an edited
     * PNG/ico/fixture emitted `Binary files … differ` into the same patch and
     * `git apply` refused the WHOLE thing (`cannot apply binary patch …
     * without full index line`) — every text edit and every untracked new file
     * captured alongside it lost with it, and the unblock landed straight back
     * in "Could not restore uncommitted changes from backup". The untracked
     * pass guarded against exactly this and the tracked one did not.
     */
    test('a modified tracked binary does not break the rest of the patch', async () => {
      await writeFile(join(repo, 'icon.bin'), Buffer.from([0, 1, 2, 0, 3, 255]));
      git(repo, 'add', 'icon.bin');
      git(repo, 'commit', '-m', 'Seed a tracked binary');

      await writeFile(join(repo, 'icon.bin'), Buffer.from([9, 9, 0, 7, 255, 1, 0]));
      await writeFile(join(repo, 'README.md'), '# still recoverable\n', 'utf-8');
      await writeFile(join(repo, 'fresh.md'), '# untracked too\n', 'utf-8');

      const patch = (await getUncommittedDiff(repo))
        .replace(/^--- UNSTAGED CHANGES ---\n/gm, '')
        .replace(/^--- UNTRACKED FILES ---\n/gm, '');

      git(repo, 'reset', '--hard', 'HEAD');
      await rm(join(repo, 'fresh.md'), { force: true });

      expect(await applyPatch(patch, repo)).toBe(true);
      // The text edits — the point of the guard — are back...
      expect(await Bun.file(join(repo, 'README.md')).text()).toBe('# still recoverable\n');
      expect(await Bun.file(join(repo, 'fresh.md')).text()).toBe('# untracked too\n');
      // ...and the binary itself round-trips, since `--binary` captures it.
      expect([...new Uint8Array(await Bun.file(join(repo, 'icon.bin')).arrayBuffer())])
        .toEqual([9, 9, 0, 7, 255, 1, 0]);
      expect(patchPaths(patch)).toContain('icon.bin');
    });

    /**
     * INVARIANT: a tracked binary OVER the per-file ceiling is dropped as a
     * whole section, not truncated. Half a `GIT binary patch` payload is a
     * patch git rejects, which is the same total loss the guard above exists to
     * prevent. The file stays named in the snapshot's `git status`, so the
     * restore-failure message reports it as recorded by name only.
     */
    test('an oversized tracked binary is dropped, and the rest still applies', async () => {
      // RANDOM bytes: git deflates a binary payload before base85-encoding it,
      // so anything with a pattern in it compresses back under the ceiling and
      // the test would pass for the wrong reason.
      const big = new Uint8Array(3 * 1024 * 1024);
      // In 64 KiB chunks — that is the per-call limit Web Crypto specifies.
      for (let off = 0; off < big.length; off += 65536) {
        crypto.getRandomValues(big.subarray(off, Math.min(off + 65536, big.length)));
      }
      await writeFile(join(repo, 'huge.bin'), Buffer.from([1, 0, 2]));
      git(repo, 'add', 'huge.bin');
      git(repo, 'commit', '-m', 'Seed');

      await writeFile(join(repo, 'huge.bin'), Buffer.from(big));
      await writeFile(join(repo, 'README.md'), '# survives the drop\n', 'utf-8');

      const patch = (await getUncommittedDiff(repo)).replace(/^--- UNSTAGED CHANGES ---\n/gm, '');
      expect(patch.length).toBeLessThan(1024 * 1024);
      expect(patchPaths(patch)).not.toContain('huge.bin');

      git(repo, 'reset', '--hard', 'HEAD');
      expect(await applyPatch(patch, repo)).toBe(true);
      expect(await Bun.file(join(repo, 'README.md')).text()).toBe('# survives the drop\n');
    });

    /**
     * INVARIANT: a file the turn DELETED is reported as recoverable, because
     * the patch carries the deletion and can replay it. `patchPaths` read only
     * the `+++` side, where a deletion says `/dev/null`, so the file fell into
     * the "recorded by name only — its content was not captured (binary, or
     * over the capture ceiling)" bucket of the restore-failure warning: the
     * opposite of the truth, told to somebody already hunting for lost work.
     */
    test('a deleted file is reported as carried by the patch, not as name-only', async () => {
      await rm(join(repo, 'tracked.txt'));

      const patch = (await getUncommittedDiff(repo)).replace(/^--- UNSTAGED CHANGES ---\n/gm, '');
      expect(patchPaths(patch)).toEqual(['tracked.txt']);

      // And it really does replay: the restore is not merely claiming it.
      git(repo, 'checkout', '--', 'tracked.txt');
      expect(await applyPatch(patch, repo)).toBe(true);
      expect(await listUncommittedPaths(repo)).toEqual(['tracked.txt']);
    });

    /**
     * INVARIANT: a pure RENAME is reported as carried by the patch. An exact
     * `git mv` is `rename from`/`rename to` with no hunks and no `+++` line at
     * all, so reading targets alone dropped it into the same "content was not
     * captured (binary, or over the capture ceiling)" bucket as the deletion
     * above — wrong for the same reason, one case over. The patch replays it.
     */
    test('a staged rename is reported as carried by the patch', async () => {
      git(repo, 'mv', 'tracked.txt', 'renamed.txt');

      const patch = (await getUncommittedDiff(repo)).replace(/^--- STAGED CHANGES ---\n/gm, '');
      expect(patch).toContain('rename to renamed.txt');
      expect(patchPaths(patch)).toEqual(['renamed.txt']);

      git(repo, 'reset', '--hard', 'HEAD');
      expect(await applyPatch(patch, repo)).toBe(true);
      expect((await listUncommittedPaths(repo))?.sort()).toEqual(['renamed.txt', 'tracked.txt']);
    });

    /**
     * INVARIANT: the user's DIFF CONFIGURATION cannot reach this capture. A
     * textconv filter (`*.bin diff=exif`) is a one-way conversion enabled by
     * default for `git diff`, and it WINS over `--binary`: the capture comes
     * back as converted TEXT, `git apply` answers "patch does not apply", and
     * the whole snapshot — every text edit, every untracked new file — is lost
     * with it. That is this task's own failure mode, reachable through a
     * setting in the user's own repository, so the capture pins the flags.
     */
    test('a textconv filter cannot turn the capture into an unappliable patch', async () => {
      await writeFile(join(repo, 'f.bin'), Buffer.from([0, 1, 2, 0, 3, 255]));
      await writeFile(join(repo, '.gitattributes'), '*.bin diff=exif\n', 'utf-8');
      git(repo, 'config', 'diff.exif.textconv', 'echo CONVERTED-TEXT-FOR');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'Seed a binary behind a textconv filter');

      await writeFile(join(repo, 'f.bin'), Buffer.from([9, 9, 0, 7, 255, 1, 0]));
      await writeFile(join(repo, 'README.md'), '# survives textconv\n', 'utf-8');

      const patch = (await getUncommittedDiff(repo)).replace(/^--- UNSTAGED CHANGES ---\n/gm, '');
      expect(patch).not.toContain('CONVERTED-TEXT-FOR');

      git(repo, 'reset', '--hard', 'HEAD');
      expect(await applyPatch(patch, repo)).toBe(true);
      expect(await Bun.file(join(repo, 'README.md')).text()).toBe('# survives textconv\n');
      expect([...new Uint8Array(await Bun.file(join(repo, 'f.bin')).arrayBuffer())])
        .toEqual([9, 9, 0, 7, 255, 1, 0]);
    });

    /**
     * INVARIANT: `diff.noprefix` cannot reach this capture either. It writes
     * `diff --git f.bin f.bin` and `--- f.bin`, and `git apply` strips a
     * leading path component by default — so every path in the patch is
     * mangled and nothing restores. The capture pins `--src-prefix`/
     * `--dst-prefix` so the stored patch has one shape whatever the repo says.
     */
    test('diff.noprefix cannot mangle the stored patch', async () => {
      git(repo, 'config', 'diff.noprefix', 'true');
      await writeFile(join(repo, 'README.md'), '# prefixed anyway\n', 'utf-8');

      const patch = (await getUncommittedDiff(repo)).replace(/^--- UNSTAGED CHANGES ---\n/gm, '');
      expect(patch).toContain('diff --git a/README.md b/README.md');

      git(repo, 'reset', '--hard', 'HEAD');
      expect(await applyPatch(patch, repo)).toBe(true);
      expect(await Bun.file(join(repo, 'README.md')).text()).toBe('# prefixed anyway\n');
    });

    /**
     * INVARIANT: the binary capture is bounded in AGGREGATE, not only per file.
     * A snapshot is written on every dirty turn and nothing ever consumes or
     * supersedes one, so an unbounded capture is how the store grows until
     * something else breaks — the reason the untracked pass has carried a total
     * ceiling from the start. The budget is shared across the staged and
     * unstaged captures.
     */
    test('the binary capture stops at the total ceiling, and text still restores', async () => {
      // Six ~900 KiB incompressible binaries: each is under the per-file
      // ceiling, together they are over the 4 MiB total.
      for (let i = 0; i < 6; i++) {
        const bytes = new Uint8Array(900 * 1024);
        for (let off = 0; off < bytes.length; off += 65536) {
          crypto.getRandomValues(bytes.subarray(off, Math.min(off + 65536, bytes.length)));
        }
        await writeFile(join(repo, `b${i}.bin`), Buffer.from(bytes));
      }
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'Seed six binaries');
      for (let i = 0; i < 6; i++) {
        const bytes = new Uint8Array(900 * 1024);
        for (let off = 0; off < bytes.length; off += 65536) {
          crypto.getRandomValues(bytes.subarray(off, Math.min(off + 65536, bytes.length)));
        }
        await writeFile(join(repo, `b${i}.bin`), Buffer.from(bytes));
      }
      await writeFile(join(repo, 'README.md'), '# still here\n', 'utf-8');

      const patch = (await getUncommittedDiff(repo)).replace(/^--- UNSTAGED CHANGES ---\n/gm, '');
      expect(patch.length).toBeLessThan(6 * 1024 * 1024);
      // Some binaries made it in, some were left out — and the text edit is
      // never the thing that gets dropped.
      const carried = patchPaths(patch);
      expect(carried).toContain('README.md');
      expect(carried.filter(p => p.endsWith('.bin')).length).toBeLessThan(6);

      git(repo, 'reset', '--hard', 'HEAD');
      expect(await applyPatch(patch, repo)).toBe(true);
      expect(await Bun.file(join(repo, 'README.md')).text()).toBe('# still here\n');
    });
  });

  /**
   * INVARIANT: the restore only claims what the snapshot can give back. The
   * file NAMES come from the status capture and the CONTENT from the patch, and
   * they do not always agree — so a message is built from the intersection, not
   * from the names alone. Sending somebody who is already hunting for lost work
   * to a store that cannot return it is the worst available answer.
   */
  describe('patchPaths separates what is stored from what is merely named', () => {
    test('reads the target paths, ignoring /dev/null sources', () => {
      const patch = [
        'diff --git a/README.md b/README.md',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/new.txt b/new.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1 @@',
        '+hello',
      ].join('\n');
      expect(patchPaths(patch)).toEqual(['README.md', 'new.txt']);
    });

    test('a name the patch never carries is not reported as recoverable', () => {
      const named = snapshotFiles('?? blob.bin\n M README.md\n');
      const stored = new Set(patchPaths('--- a/README.md\n+++ b/README.md\n'));
      expect(named.filter(f => stored.has(f))).toEqual(['README.md']);
      expect(named.filter(f => !stored.has(f))).toEqual(['blob.bin']);
    });
  });

  describe('the snapshot restore tells a redundant backup from a failed one', () => {
    test('a patch whose content is already committed reads as already applied', async () => {
      await writeFile(join(repo, 'tracked.txt'), 'edited\n', 'utf-8');
      const patch = (await getUncommittedDiff(repo)).replace(/^--- UNSTAGED CHANGES ---\n/gm, '');

      // The agent commits exactly those edits, as it does when sent back.
      git(repo, 'commit', '-am', 'commit the edits the snapshot holds');

      expect(await patchIsAlreadyApplied(patch, repo)).toBe(true);
    });

    test('a patch that does not belong to this branch is neither appliable nor applied', async () => {
      const foreign = [
        'diff --git a/nowhere.txt b/nowhere.txt',
        'index 1111111..2222222 100644',
        '--- a/nowhere.txt',
        '+++ b/nowhere.txt',
        '@@ -1 +1 @@',
        '-was',
        '+is',
        '',
      ].join('\n');
      expect(await patchIsAlreadyApplied(foreign, repo)).toBe(false);
    });

    test('the stored git status names the files for the failure message', () => {
      expect(snapshotFiles(' M docs/note.md\n?? scratch.txt\n')).toEqual(['docs/note.md', 'scratch.txt']);
      expect(snapshotFiles('')).toEqual([]);
    });

    /**
     * INVARIANT: the FIRST file in a stored status is not mangled. The status
     * was captured through `runGit`, which trims stdout, so an unstaged
     * modification's leading space (` M README.md`) is already gone by the time
     * it reaches the store — and slicing three fixed columns off that yields
     * `EADME.md`. Only the first record is affected, which is exactly why the
     * same mistake reads as correct in almost every test written for it; it is
     * the same trim that made the patch itself unrestorable.
     */
    test('a status the trim reached still names its first file correctly', () => {
      expect(snapshotFiles('M README.md\n M docs/note.md\n')).toEqual(['README.md', 'docs/note.md']);
      expect(snapshotFiles('?? public-docs/troubleshooting.md')).toEqual(['public-docs/troubleshooting.md']);
    });

    test('a rename names the file that exists now', () => {
      expect(snapshotFiles('R  old/name.ts -> new/name.ts\n')).toEqual(['new/name.ts']);
    });
  });
});
