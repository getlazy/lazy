import { describe, test, expect } from 'bun:test';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { READ_ONLY_RPC_COMMANDS, STORE_WRITING_RPC_COMMANDS } from '../../src/daemon/rpc-command-kinds';

const SRC = join(import.meta.dir, '..', '..', 'src');

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('syncTaskFromRemote runs only in the daemon', () => {
  // INVARIANT: only daemon code calls syncTaskFromRemote directly; every other
  // process reaches it through the `syncTaskFromRemote` RPC. A merged PR runs
  // the accept transition under tryWithTaskLifecycleLock, an in-process map, so
  // a CLI process calling it directly excluded nothing and could overwrite the
  // daemon's accept follow-through record mid-accept.
  test('no module outside src/daemon/ (and its own) imports it', async () => {
    const offenders: string[] = [];
    for (const file of await walk(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (rel.startsWith('daemon/') || rel === 'task/sync-remote.ts') continue;
      const text = await readFile(file, 'utf8');
      if (/\bsyncTaskFromRemote\b/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('the RPC is classified as a store write, not a read', () => {
    expect(STORE_WRITING_RPC_COMMANDS.has('syncTaskFromRemote')).toBe(true);
    expect(READ_ONLY_RPC_COMMANDS.has('syncTaskFromRemote')).toBe(false);
  });
});
