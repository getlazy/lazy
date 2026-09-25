/**
 * The `reviewProseAnchors` RPC: the latest report's prose blocks with the
 * anchors the daemon's dashboard gives them, for a client that renders the
 * report itself (Lazy Teams).
 *
 * INVARIANT: every anchor in the answer is `proseAnchorLine(kind, text)` over
 * the same leaf-block text the review island hashes, so a client matching its
 * own blocks to these by text never needs — and never keeps — a copy of the
 * hash. A copy drifts, and a drifted copy strands every existing conversation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, closeAllStorage, handleRpc, getOrCreateStorage } from '../../src/daemon/rpc-handlers';
import { proseLeafTexts } from '../../src/review/prose-blocks';
import { proseAnchorLine } from '../../src/review/prose-anchor';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

describe('proseLeafTexts', () => {
  test('leaf blocks only, entities decoded, a nested list does not swallow its items', () => {
    expect(proseLeafTexts('<p>A &amp; B</p><ul><li>one<ul><li>two</li></ul></li></ul><pre><code>x &lt; y</code></pre>'))
      .toEqual(['A & B', 'two', 'x < y']);
  });
  test('a container with no block is one block itself', () => {
    expect(proseLeafTexts('just <em>text</em>')).toEqual(['just text']);
  });
});

describe('reviewProseAnchors over the RPC dispatcher', () => {
  let root: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-prose-anchors-'));
    await writeFile(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`);
    unpin = pinConfig(root);
    initDaemonStorage(root);
  });

  afterEach(async () => {
    await closeAllStorage();
    unpin();
    await rm(root, { recursive: true, force: true });
  });

  test('the dispatch arm exists and refuses a call with no task', async () => {
    await expect(handleRpc('reviewProseAnchors', root, {} as any)).rejects.toThrow(/taskId/);
  });

  test('a task with no report has no blocks', async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('No report yet');
    expect(await handleRpc('reviewProseAnchors', root, { taskId: task.id } as any)).toEqual({ blocks: [] });
  });

  test("serves the latest report's sections, captions and walkthrough prose with the daemon's anchors", async () => {
    const storage = await getOrCreateStorage();
    const task = await storage.createTask('Prose anchors');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/prose', 'abc123');
    await storage.upsertTurnReport(task.id, {
      session_id: session.id,
      sections: [{ kind: 'what_was_done', body: 'Shipped **review**  parity.\n\n- one\n- two' }],
      presentation: {
        screenshots: [{ artifact: 'a.png', caption: 'The list' }],
        groups: [{ id: 'g', title: 'G', tier: 'core', summary: 'Retries back off.', items: [{ kind: 'prose', body: 'Why.' }] }],
      },
    } as any);

    const { blocks } = await handleRpc('reviewProseAnchors', root, { taskId: task.id } as any) as any;
    expect(blocks.map((b: any) => [b.kind, b.text])).toEqual([
      ['what_was_done', 'Shipped review parity.'],
      ['what_was_done', 'one'],
      ['what_was_done', 'two'],
      ['screenshots', 'The list a.png'],
      ['', 'Retries back off.'],
      ['', 'Why.'],
    ]);
    for (const b of blocks) {
      expect(b.file).toBe('(report)');
      expect(b.side).toBe('new');
      expect(b.line).toBe(proseAnchorLine(b.kind, b.text));
    }
  });
});
