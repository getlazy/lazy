/**
 * Branch-vs-root `[serve]` advice.
 *
 * INVARIANT: a worktree lazy.toml is untrusted data. Missing or unparseable
 * files return no advice (never throw). Hostile values (non-integer ports,
 * out of range, bad names) are dropped at this boundary, not rendered into
 * a command.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  branchServeAdviceFor,
  diffBranchServe,
  extractServePorts,
  parseWorktreeServe,
} from '../../src/serve/branch-advice';

describe('extractServePorts / parseWorktreeServe', () => {
  test('reads named services and bare ports', () => {
    const parsed = parseWorktreeServe(`
[serve]
ports = [4000]
[serve.services]
web = 3000
`);
    expect(parsed).toEqual([
      { name: 'web', port: 3000 },
      { name: '4000', port: 4000 },
    ]);
  });

  test('unparseable TOML is empty, not a throw', () => {
    expect(parseWorktreeServe('this is not = [ toml')).toEqual([]);
  });

  test('a hostile non-integer port is dropped', () => {
    expect(extractServePorts({
      serve: { ports: ['3000', 3000.5, 0, 70000, 8080] },
    })).toEqual([{ name: '8080', port: 8080 }]);
  });

  test('a bad service name is dropped', () => {
    expect(extractServePorts({
      serve: { services: { 'not a name': 3000, web: 3000 } },
    })).toEqual([{ name: 'web', port: 3000 }]);
  });
});

describe('diffBranchServe', () => {
  test('advises a port the root lacks, compared by port not name', () => {
    const advice = diffBranchServe(
      [
        { name: 'api', port: 4000 },
        { name: 'web', port: 3000 },
      ],
      [{ name: 'web', port: 3000 }],
      'my-task',
    );
    expect(advice).toEqual([
      { name: 'api', port: 4000, command: 'lazy forward my-task 4000' },
    ]);
  });

  test('a renamed service on an already-published port is not advice', () => {
    expect(diffBranchServe(
      [{ name: 'api', port: 3000 }],
      [{ name: 'web', port: 3000 }],
      't',
    )).toEqual([]);
  });
});

describe('branchServeAdviceFor', () => {
  test('a missing worktree file is no advice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-advice-'));
    expect(await branchServeAdviceFor(dir, [], 't')).toEqual([]);
  });

  test('reads the worktree file and diffs against the root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-advice-'));
    await writeFile(join(dir, 'lazy.toml'), '[serve]\nports = [39991]\n');
    const advice = await branchServeAdviceFor(dir, [{ name: 'web', port: 3000 }], 'demo');
    expect(advice).toEqual([
      { name: '39991', port: 39991, command: 'lazy forward demo 39991' },
    ]);
  });

  test('a directory that is not a worktree is no advice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lazy-advice-'));
    await mkdir(join(dir, 'nested'));
    expect(await branchServeAdviceFor(join(dir, 'nested'), [], 't')).toEqual([]);
  });
});
