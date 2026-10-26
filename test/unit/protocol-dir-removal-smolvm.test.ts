/**
 * Removing a finished task's protocol directory when, on the smolvm runner,
 * `~/.lazy/protocol/<task>` is a symlink into `~/.lazy/protocol-smolvm/<machine>/`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile, lstat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeProtocolDir } from '../../src/protocol/io';
import { moveProtocolDirInto } from '../../src/runner/smolvm-runner';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'proto-rm-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const exists = (p: string) => lstat(p).then(() => true, () => false);

describe('removeProtocolDir on a smolvm task', () => {
  test('removes the linked directory and the link', async () => {
    // INVARIANT: a finished smolvm task leaves no protocol folder behind. rmdir
    // on the symlink failed silently, so every task leaked its real directory.
    const base = join(root, 'protocol');
    const projectDir = join(`${base}-smolvm`, 'machine');
    await mkdir(base, { recursive: true });
    const link = join(base, 'task-1');
    const real = await moveProtocolDirInto(link, projectDir);
    await writeFile(join(real, 'response.json'), '{}');

    removeProtocolDir(link);

    expect(await exists(link)).toBe(false);
    expect(await exists(real)).toBe(false);
    expect(await readdir(projectDir)).toEqual([]);
  });

  test('never follows a link that points outside the smolvm protocol tree', async () => {
    // INVARIANT: removal only ever deletes inside <protocol base>-smolvm/.
    const base = join(root, 'protocol');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(base, { recursive: true });
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'response.json'), '{}');
    const link = join(base, 'task-2');
    await symlink(elsewhere, link);

    removeProtocolDir(link);

    expect(await exists(link)).toBe(false);
    expect(await exists(join(elsewhere, 'response.json'))).toBe(true);
  });
});
