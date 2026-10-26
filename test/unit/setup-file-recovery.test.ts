import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, open, readFile, writeFile, lstat, rm, symlink, readlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { restoreSetupFile } from '../../src/git/setup-file-recovery';

for (const race of ['edit', 'symlink', 'replacement', 'index', 'head', 'open-writer']) {
  test(`setup restoration preserves a concurrent ${race}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-file-race-'));
    const file = join(root, '.gitignore');
    const gitDir = join(root, '.git');
    let writer;
    try {
      await mkdir(gitDir);
      await writeFile(file, 'setup\n');
      const inspected = await lstat(file);
      const outside = join(root, 'outside');
      await writeFile(outside, 'precious\n');
      writer = await open(file, 'r+');
      let calls = 0;
      const recovered = await restoreSetupFile(file, 'original\n', Buffer.from('setup\n'), inspected, gitDir, async () => {
        calls++;
        if (calls === 1 && race === 'edit') await writeFile(file, 'human edit\n');
        if (calls === 1 && race === 'symlink') { await rm(file); await symlink(outside, file); }
        if (calls === 2 && race === 'replacement') await symlink(outside, file);
        return !(calls === 2 && ['index', 'head'].includes(race));
      });
      // INVARIANT: a setup repair never discards another writer's content or follows a substituted symlink.
      expect(await readFile(outside, 'utf8')).toBe('precious\n');
      if (race === 'open-writer') {
        await writer.write('late edit\n', 0, 'utf8');
        expect(recovered.restored).toBe(true);
        expect(await readFile(file, 'utf8')).toBe('original\n');
        expect(await readFile(recovered.backup!, 'utf8')).toBe('late edit\n');
      } else {
        expect(recovered.restored).toBe(false);
        if (['symlink', 'replacement'].includes(race)) expect(await readlink(file)).toBe(outside);
        else expect(await readFile(file, 'utf8')).toBe(race === 'edit' ? 'human edit\n' : 'setup\n');
        expect(recovered.backup).toBeDefined();
      }
    } finally { await writer?.close(); await rm(root, { recursive: true, force: true }); }
  });
}
