/**
 * The `reviewPresentations` RPC: what the review page PRESENTS rather than
 * lists — markdown files rendered as documents, mermaid fences as diagrams —
 * handed to a client that renders the diff itself (Lazy Teams).
 *
 * INVARIANT: the answer is computed by the same functions the daemon's own page
 * renders with, so a client never re-derives folds, anchors or fence rules. A
 * file that cannot be rendered is ABSENT, never an error: the client keeps its
 * line diff.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDaemonStorage, closeAllStorage, handleRpc } from '../../src/daemon/rpc-handlers';
import { reviewPresentations } from '../../src/daemon/rpc-review';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';

enableInProcessTestMode();

const DIFF = [
  'diff --git a/docs/a.md b/docs/a.md', 'new file mode 100644', '--- /dev/null', '+++ b/docs/a.md', '@@ -0,0 +1,5 @@',
  '+# A', '+', '+```mermaid', '+graph TD; X-->Y', '+```',
  'diff --git a/docs/huge.md b/docs/huge.md', 'new file mode 100644', '--- /dev/null', '+++ b/docs/huge.md', '@@ -0,0 +1,1 @@', '+big',
  'diff --git a/docs/gone.md b/docs/gone.md', 'new file mode 100644', '--- /dev/null', '+++ b/docs/gone.md', '@@ -0,0 +1,1 @@', '+x',
  'diff --git a/src/x.ts b/src/x.ts', '--- a/src/x.ts', '+++ b/src/x.ts', '@@ -1,1 +1,2 @@', ' a', '+b',
  '',
].join('\n');

const A_TEXT = ['# A', '', '```mermaid', 'graph TD; X-->Y', '```'];

function fakeActions(seen: { region?: string }) {
  return {
    async getDiff(_taskId: string, opts?: { region?: string }) {
      seen.region = opts?.region;
      return DIFF;
    },
    async getFileLines(_taskId: string, q: { path: string; start: number; end: number }) {
      if (q.path === 'docs/a.md') return { lines: A_TEXT.slice(q.start - 1, q.end), atEof: true } as any;
      if (q.path === 'docs/huge.md') {
        // Never reaches EOF: longer than the renderer will inline.
        return { lines: new Array(q.end - q.start + 1).fill('line'), atEof: false } as any;
      }
      throw new Error(`refused: ${q.path}`);
    },
  };
}

describe('reviewPresentations', () => {
  test('renders readable markdown, leaves out what it cannot, and finds the diagrams', async () => {
    const seen: { region?: string } = {};
    const result = await reviewPresentations(fakeActions(seen) as any, 't1', 'unit-a');

    expect(seen.region).toBe('unit-a');
    expect(result.documents.map((d) => d.path)).toEqual(['docs/a.md']);
    const [doc] = result.documents;
    expect(doc.kind).toBe('added');
    expect(doc.anchor).toEqual({ side: 'new', line: 1 });
    expect(doc.bodyHtml).toContain('data-lz-mermaid=');
    expect(doc.noteHtml).toBe('');
    // No file-lines read ever happens for a non-markdown file, and it has no diagram.
    expect(result.diagrams.map((d) => d.path)).toEqual(['docs/a.md']);
    const [block] = result.diagrams[0].blocks;
    expect(block.source).toBe('graph TD; X-->Y');
    expect(block.anchor).toEqual({ file: 'docs/a.md', side: 'new', line: 3 });
    expect(block.after).toEqual({ file: 'docs/a.md', side: 'new', line: 5 });
  });
});

describe('reviewPresentations over the RPC dispatcher', () => {
  let root: string;
  let unpin: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-rpc-presentations-'));
    await writeFile(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`);
    unpin = pinConfig(root);
    initDaemonStorage(root);
  });

  afterEach(async () => {
    await closeAllStorage();
    unpin();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: the command is reachable by name — a handler with no dispatch
  // arm is a 404 to every client — and it confirms its inputs at the boundary.
  test('the dispatch arm exists and refuses a call with no task', async () => {
    await expect(handleRpc('reviewPresentations', root, {} as any)).rejects.toThrow(/taskId/);
  });
});
