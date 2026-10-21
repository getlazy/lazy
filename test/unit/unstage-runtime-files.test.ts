import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGit } from '../../src/utils/git';
import { unstageLazyRuntimeFiles } from '../../src/mcp/tools';

async function repo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'unstage-')));
  for (const a of [['init', '-q'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 'n']]) await runGit(a, { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'a');
  await runGit(['add', '-A'], { cwd: dir });
  await runGit(['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

// INVARIANT: only lazy's own excluded runtime paths staged as new are unstaged; user files are never touched. Data integrity: git rm --cached only.
test('unstages staged runtime files, keeps them on disk, leaves user files', async () => {
  const dir = await repo();
  await mkdir(join(dir, '.lazy-task-sandbox'));
  await mkdir(join(dir, '.lazy', 'plugins'), { recursive: true });
  await writeFile(join(dir, '.lazy-task-sandbox', 'x'), 'x');
  await writeFile(join(dir, '.lazy', 'state'), 's');
  await writeFile(join(dir, '.lazy', 'plugins', 'p.ts'), 'p');
  await writeFile(join(dir, 'user.txt'), 'u');
  await runGit(['add', '-A', '-f'], { cwd: dir });
  const removed = await unstageLazyRuntimeFiles(dir);
  expect(removed.sort()).toEqual(['.lazy-task-sandbox/x', '.lazy/state']);
  const staged = (await runGit(['diff', '--cached', '--name-only'], { cwd: dir })).stdout.split('\n').sort();
  expect(staged).toEqual(['.lazy/plugins/p.ts', 'user.txt']);
  expect(await Bun.file(join(dir, '.lazy-task-sandbox', 'x')).text()).toBe('x');
});

// INVARIANT: a path HEAD already tracks is never unstaged, even if it matches lazy's patterns. History is never rewritten.
test('leaves a tracked runtime-pattern file and nested plugin paths alone', async () => {
  const dir = await repo();
  await mkdir(join(dir, '.lazy', 'plugins', 'sub'), { recursive: true });
  await writeFile(join(dir, '.lazy', 'tracked'), '1');
  await runGit(['add', '-f', '.lazy/tracked'], { cwd: dir });
  await runGit(['commit', '-qm', 't'], { cwd: dir });
  await writeFile(join(dir, '.lazy', 'tracked'), '2');
  await writeFile(join(dir, '.lazy', 'plugins', 'sub', 'x'), 'x');
  await runGit(['add', '-A', '-f'], { cwd: dir });
  expect(await unstageLazyRuntimeFiles(dir)).toEqual([]);
  const staged = (await runGit(['diff', '--cached', '--name-only'], { cwd: dir })).stdout.split('\n').sort();
  expect(staged).toEqual(['.lazy/plugins/sub/x', '.lazy/tracked']);
});

// INVARIANT: during a merge nothing is unstaged. The other side's tracked files would vanish from the merge commit.
test('does nothing while a merge is in progress', async () => {
  const dir = await repo();
  const head = (await runGit(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  await mkdir(join(dir, '.lazy'));
  await writeFile(join(dir, '.lazy', 'up'), 'u');
  await runGit(['add', '-f', '.lazy/up'], { cwd: dir });
  await writeFile(join(dir, '.git', 'MERGE_HEAD'), head + '\n');
  expect(await unstageLazyRuntimeFiles(dir)).toEqual([]);
  expect((await runGit(['diff', '--cached', '--name-only'], { cwd: dir })).stdout.trim()).toBe('.lazy/up');
});
