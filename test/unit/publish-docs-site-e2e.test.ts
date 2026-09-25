/**
 * scripts/publish-docs-site.sh run for real against a local publish repo.
 *
 * INVARIANT: publishing a version OLDER than the newest one on the branch leaves
 * the root copy alone but still rewrites the root page's version index, and a
 * dry run exits 0 and keeps the staged tree. The index is the only way to find
 * older versions, and a dry run that crashed at its last line (SIGPIPE under
 * pipefail) hid every earlier result.
 *
 * INVARIANT: a source checkout without public-docs/ is refused. Its generator
 * would render the internal docs/ tree onto the public site.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { DOCS_VERSION_SEGMENT } from '../../src/docs/links';

const REPO = join(import.meta.dir, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'publish-docs-site.sh');

function run(cmd: string[], cwd: string) {
  const result = spawnSyncUnsupervised(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
}

describe('publish-docs-site.sh end to end', () => {
  let dir: string;
  let bare: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pds-e2e-'));
    bare = join(dir, 'pages.git');
    const seed = join(dir, 'seed');
    await mkdir(join(seed, 'v99.0'), { recursive: true });
    await writeFile(join(seed, 'v99.0', 'index.html'), '<main></main>');
    await writeFile(join(seed, 'index.html'), '<html><body><main class="wrap">\n<h1>v99 root</h1>\n</main></body></html>\n');
    for (const cmd of [
      ['git', 'init', '-q', '-b', 'gh-pages'],
      ['git', 'add', '-A'],
      ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed'],
      ['git', 'clone', '-q', '--bare', seed, bare],
    ]) {
      expect(run(cmd, seed).code).toBe(0);
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('older version: root untouched, index rewritten, dry run keeps the tree', async () => {
    expect(DOCS_VERSION_SEGMENT).toBeTruthy();
    const keep = join(dir, 'kept');
    const { code, out } = run(
      ['bash', SCRIPT, '--version', DOCS_VERSION_SEGMENT!, '--repo', bare, '--dry-run', '--keep', keep],
      REPO,
    );
    expect(out).toContain('Not refreshing the root copy');
    expect(code).toBe(0);

    const entries = await readdir(keep);
    expect(entries).toContain(DOCS_VERSION_SEGMENT!);
    const root = await readFile(join(keep, 'index.html'), 'utf-8');
    expect(root).toContain('<h1>v99 root</h1>');
    expect(root.indexOf('./v99.0/')).toBeGreaterThan(-1);
    expect(root.indexOf('./v99.0/')).toBeLessThan(root.indexOf(`./${DOCS_VERSION_SEGMENT}/`));
  }, 180_000);

  test('refuses a source checkout without public-docs/', async () => {
    const src = join(dir, 'old-tag');
    await mkdir(join(src, 'scripts'), { recursive: true });
    await writeFile(join(src, 'scripts', 'build-docs-site.ts'), '');
    const { code, out } = run(['bash', SCRIPT, '--source', src, '--version', 'v0.1', '--dry-run'], REPO);
    expect(code).not.toBe(0);
    expect(out).toContain('no public-docs/');
  });
});
