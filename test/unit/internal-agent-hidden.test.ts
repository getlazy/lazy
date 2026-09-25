/**
 * Internal agents stay out of everything a user reads.
 *
 * INVARIANT: `qa-agent` is lazy's own scriptable QA agent. It must remain fully
 * REGISTERED — `listAgents()` returns it, so a lazy.toml or `--agent qa-agent`
 * naming it still validates and launches — while never appearing in a listing,
 * hint, completion, published doc, or config example a human reads. The split
 * is `listAgents()` (validation) vs `listSelectableAgents()` (display).
 */

import { describe, test, expect } from 'bun:test';
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import {
  availableAgentsHint,
  isInternalAgent,
  listAgents,
  listSelectableAgents,
} from '../../src/agent/registry';

const REPO_ROOT = join(import.meta.dir, '../..');
const INTERNAL_ID = 'qa-agent';

async function filesUnder(dir: string, exts: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(d);
    } catch {
      return; // directory absent in this checkout — nothing to scan
    }
    for (const entry of entries) {
      const p = join(d, entry);
      const s = await stat(p);
      if (s.isDirectory()) await walk(p);
      else if (exts.some((e) => entry.endsWith(e))) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

describe('internal agents are hidden from users', () => {
  test('qa-agent is registered but never selectable', () => {
    expect(listAgents()).toContain(INTERNAL_ID);
    expect(isInternalAgent(INTERNAL_ID)).toBe(true);
    expect(listSelectableAgents()).not.toContain(INTERNAL_ID);
    expect(availableAgentsHint()).not.toContain(INTERNAL_ID);
  });

  // A project that deliberately pinned an internal agent still sees it in its
  // own picker — hiding it there would silently switch the task's agent on save.
  test('a pinned agent is passed through even when internal', () => {
    expect(listSelectableAgents(INTERNAL_ID)).toContain(INTERNAL_ID);
    expect(listSelectableAgents('claude-code')).not.toContain(INTERNAL_ID);
  });

  test('qa-agent appears in no published doc', async () => {
    const docs = await filesUnder(join(REPO_ROOT, 'public-docs'), ['.md']);
    expect(docs.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of docs) {
      if ((await readFile(file, 'utf-8')).includes(INTERNAL_ID)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test('qa-agent appears in no user-facing CLI text or config example', async () => {
    const files = [
      join(REPO_ROOT, 'lazy.toml.example'),
      ...(await filesUnder(join(REPO_ROOT, 'src/cli'), ['.ts'])),
      ...(await filesUnder(join(REPO_ROOT, 'src/prompts'), ['.md'])),
      ...(await filesUnder(join(REPO_ROOT, 'src/completion'), ['.ts', '.sh', '.bash', '.zsh'])),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      try {
        if ((await readFile(file, 'utf-8')).includes(INTERNAL_ID)) offenders.push(file);
      } catch {
        // Optional path (src/completion may not exist) — nothing to scan.
      }
    }
    expect(offenders).toEqual([]);
  });
});
