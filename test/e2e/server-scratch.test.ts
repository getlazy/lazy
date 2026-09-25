/**
 * E2E for the dashboard's builder scratch surface: the listing grouped by
 * builder session, a file rendered and raw, files recorded by name only, search
 * within scratch, and a system message linking the scratch path it mentions.
 *
 * Files are captured the way a builder's are — written into the live scratch
 * dir, then `lazy scratch sync` — so every page is reading the STORE, which is
 * the only thing the web layer may read.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { writeSystemMessagesFile } from '../helpers/storage';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';
import { builderScratchDir } from '../../src/builder/scratch';

function scratchDirFor(ctx: TestContext): string {
  const previous = process.env.LAZY_SCRATCH_BASE_DIR;
  process.env.LAZY_SCRATCH_BASE_DIR = ctx.scratchBaseDir;
  try {
    return builderScratchDir(ctx.root);
  } finally {
    if (previous === undefined) delete process.env.LAZY_SCRATCH_BASE_DIR;
    else process.env.LAZY_SCRATCH_BASE_DIR = previous;
  }
}

describe('dashboard builder scratch', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;
  let scratchDir: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    ({ base, fetch } = await signInToDashboard(ctx));
    scratchDir = scratchDirFor(ctx);
    await mkdir(join(scratchDir, 'review'), { recursive: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function capture(): Promise<void> {
    expectSuccess(await ctx.lazy(['scratch', 'sync']));
  }

  test('an empty store says so', async () => {
    const res = await fetch(`${base}/scratch`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('No captured builder scratch files yet');
  });

  test('lists captured files with capture time and renders one as markdown and raw', async () => {
    await writeFile(join(scratchDir, 'review', 'accept-foo.md'), '# Verdict\n\nThe **merge** looks right.\n');
    await capture();

    const index = await (await fetch(`${base}/scratch`)).text();
    expect(index).toContain('review/accept-foo.md');
    expect(index).toContain('Captured');
    expect(index).toContain('/scratch/file?path=review%2Faccept-foo.md');

    const rendered = await (await fetch(`${base}/scratch/file?path=review%2Faccept-foo.md`)).text();
    expect(rendered).toContain('id="scratch-rendered"');
    expect(rendered).toContain('<strong>merge</strong>');

    const raw = await (await fetch(`${base}/scratch/file?path=review%2Faccept-foo.md&raw=1`)).text();
    expect(raw).toContain('id="scratch-raw"');
    expect(raw).toContain('The **merge** looks right.');

    await writeFile(join(scratchDir, 'notes.txt'), 'plain *text*\n');
    await capture();
    const plain = await (await fetch(`${base}/scratch/file?path=notes.txt`)).text();
    expect(plain).toContain('id="scratch-raw"');
    expect(plain).not.toContain('id="scratch-raw-link"');

    const api = await (await fetch(`${base}/api/scratch`)).json() as { groups: Array<{ files: Array<{ path: string }> }> };
    expect(api.groups.flatMap((g) => g.files.map((f) => f.path)).sort()).toEqual(['notes.txt', 'review/accept-foo.md']);
  });

  // INVARIANT: a file recorded by name only is shown AS such, with the reason —
  // never as an empty document. Its body is not in the store, and an empty page
  // would read as "the builder wrote nothing".
  test('a binary file is shown as recorded by name only, with the reason', async () => {
    await writeFile(join(scratchDir, 'dump.bin'), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
    await capture();

    const index = await (await fetch(`${base}/scratch`)).text();
    expect(index).toContain('dump.bin');
    expect(index).toContain('name only');
    expect(index).toContain('Binary');

    const page = await (await fetch(`${base}/scratch/file?path=dump.bin`)).text();
    expect(page).toContain('id="scratch-name-only"');
    expect(page).toContain('Recorded by name only.');
    expect(page).not.toContain('id="scratch-raw"');
  });

  test('search within scratch finds content and links the file', async () => {
    await writeFile(join(scratchDir, 'handoff.md'), 'Hand-off: the flaky widget test needs a retry.\n');
    await writeFile(join(scratchDir, 'other.md'), 'Nothing relevant.\n');
    await capture();

    const hit = await (await fetch(`${base}/scratch?q=${encodeURIComponent('flaky widget')}`)).text();
    expect(hit).toContain('/scratch/file?path=handoff.md');
    expect(hit).not.toContain('/scratch/file?path=other.md');

    const miss = await (await fetch(`${base}/scratch?q=zebracorn`)).text();
    expect(miss).toContain('No scratch file mentions');
  });

  test('a missing file is a 404, and the surface is read-only', async () => {
    expect((await fetch(`${base}/scratch/file?path=nope.md`)).status).toBe(404);
    expect((await fetch(`${base}/scratch`, { method: 'POST' })).status).toBe(405);
  });

  test('a system message that names a scratch path links to the file', async () => {
    await writeFile(join(scratchDir, 'review', 'accept-foo.md'), '# Verdict\n');
    await writeFile(join(scratchDir, 'a.md'), 'short\n');
    await capture();

    const id = randomUUID();
    writeSystemMessagesFile(ctx.root, [{
      id,
      created_at: Date.now(),
      source: 'builder',
      title: 'Accept draft ready',
      body: 'The draft is at `$LAZY_SCRATCH_DIR/review/accept-foo.md` (see also data.md).',
      kind: 'report',
    }]);

    const page = await (await fetch(`${base}/messages/${id}`)).text();
    expect(page).toContain('id="message-scratch-links"');
    expect(page).toContain('/scratch/file?path=review%2Faccept-foo.md');
    // `a.md` appears only inside `data.md` — not a mention.
    expect(page).not.toContain('/scratch/file?path=a.md');
  });
});
