import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findFullTaskId } from '../helpers/storage';
import { taskDir } from '../helpers/agent-seam';

const UUID = 'edc8ba7a-483f-4024-afe1-4f43be25db6a';

describe('test storage helpers resolve a task dir by id prefix', () => {
  let root: string;
  let tasks: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lazy-helpers-')));
    tasks = join(root, 'store', 'tasks');
    mkdirSync(tasks, { recursive: true });
    writeFileSync(join(root, 'lazy.toml'), `[storage]\nexternal_path = "${join(root, 'store')}"\n`);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // INVARIANT: FileStorage's staging (`<id>.tmp.<ms>`) and backup dirs never
  // match a task id prefix. A daemon writing the task has one beside the real
  // dir; resolving to it read a file that vanished mid-test (ENOENT flake).
  test('never resolves to a staging or backup dir', async () => {
    mkdirSync(join(tasks, `${UUID}.tmp.1791849331189`));
    mkdirSync(join(tasks, `${UUID}.backup`));
    expect(() => findFullTaskId(root, UUID.slice(0, 8))).toThrow('Task directory not found');
    await expect(taskDir(root, UUID.slice(0, 8))).rejects.toThrow('No task directory');

    mkdirSync(join(tasks, UUID));
    expect(findFullTaskId(root, UUID.slice(0, 8))).toBe(UUID);
    expect(await taskDir(root, UUID.slice(0, 8))).toBe(join(tasks, UUID));
  });
});
