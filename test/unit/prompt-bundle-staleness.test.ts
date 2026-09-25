import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, utimes, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { isPromptBundleStale } from '../../scripts/generate-prompt-bundle';

const repoRoot = join(import.meta.dir, '..', '..');

function bundleListing(files: string[]): string {
  return files.map((f, i) => `import p${i} from './prompts/${f}' with { type: 'text' };`).join('\n') + '\n';
}

describe('isPromptBundleStale', () => {
  let dir: string;
  let prompts: string;
  let bundle: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bundle-stale-'));
    prompts = join(dir, 'prompts');
    bundle = join(dir, 'prompts-bundle.ts');
    await mkdir(prompts);
    await writeFile(join(prompts, 'a.md'), 'a');
    await writeFile(join(prompts, 'b.md'), 'b');
    const old = new Date(Date.now() - 60_000);
    await utimes(join(prompts, 'a.md'), old, old);
    await utimes(join(prompts, 'b.md'), old, old);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('missing bundle is stale', () => {
    expect(isPromptBundleStale(prompts, bundle)).toBe(true);
  });

  test('bundle listing exactly the prompts, newer than them, is fresh', async () => {
    await writeFile(bundle, bundleListing(['a.md', 'b.md']));
    expect(isPromptBundleStale(prompts, bundle)).toBe(false);
  });

  // INVARIANT: a bundle that lists a prompt this checkout does not have is
  // stale even though nothing on disk is newer than it. That is the branch-switch
  // case that broke every from-source `lazy` run with "Cannot find module".
  test('bundle listing a deleted prompt is stale despite being newest', async () => {
    await writeFile(bundle, bundleListing(['a.md', 'b.md', 'pre-accept.md']));
    expect(isPromptBundleStale(prompts, bundle)).toBe(true);
  });

  test('bundle missing a prompt is stale', async () => {
    await writeFile(bundle, bundleListing(['a.md']));
    expect(isPromptBundleStale(prompts, bundle)).toBe(true);
  });

  test('prompt edited after the bundle is stale', async () => {
    await writeFile(bundle, bundleListing(['a.md', 'b.md']));
    const past = new Date(Date.now() - 30_000);
    await utimes(bundle, past, past);
    await writeFile(join(prompts, 'a.md'), 'edited');
    expect(isPromptBundleStale(prompts, bundle)).toBe(true);
  });
});

// INVARIANT: nothing in src/ imports the generated bundle statically. A static
// import makes a stale bundle a link-time failure of every from-source run.
test('src/ never imports prompts-bundle statically', async () => {
  const glob = new Bun.Glob('src/**/*.ts');
  for await (const f of glob.scan(repoRoot)) {
    if (f === 'src/prompts-bundle.ts') continue;
    const src = await readFile(join(repoRoot, f), 'utf-8');
    expect(src).not.toMatch(/^\s*import[^(]*from\s+['"][./]*prompts-bundle['"]/m);
  }
});
