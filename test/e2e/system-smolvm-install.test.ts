/**
 * `lazy system smolvm-install` end to end, against a local stub release
 * server (`--release-base`): a download that is not the pinned release is
 * refused and deleted, a server that keeps failing is retried and then fails
 * loudly, and an install that already verifies is reused without a download
 * and written to lazy.toml only when asked.
 *
 * A download that MATCHES the pin cannot be served here (the pin is the real
 * release's digest); the unit suite (test/unit/smolvm-install.test.ts) covers
 * that path with a pin of its own.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { createHash } from 'crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectError, expectOutput } from '../helpers/assertions';
import { SMOLVM_RELEASE } from '../../src/vm/smolvm-docker-machine';
import { smolvmArchiveName, smolvmPlatform } from '../../src/vm/smolvm-release';

const triple = smolvmPlatform();

describe.skipIf(!triple)('lazy system smolvm-install', () => {
  let ctx: TestContext;
  let home: string;
  let server: ReturnType<typeof Bun.serve>;
  let hits: string[];
  let respond: () => Response;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    home = await realpath(await mkdtemp(join(tmpdir(), 'smolvm-install-home-')));
    hits = [];
    respond = () => new Response('not a smolvm release');
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => { hits.push(new URL(req.url).pathname); return respond(); } });
  });
  afterEach(async () => {
    server.stop(true);
    await ctx.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${server.port}/releases`;
  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    ctx.lazy(['system', 'smolvm-install', '--release-base', base(), ...args], { env: { HOME: home, ...env } });
  const installDir = () => join(home, '.lazy', 'smolvm', SMOLVM_RELEASE.version);

  // INVARIANT: a download that is not the pinned release is refused, deleted,
  // and never unpacked — the pin is the only thing vouching for what runs.
  test('a download that does not match the pinned digest is refused and nothing is installed', async () => {
    const result = await run();
    expect(result.exitCode).toBe(1);
    expectError(result, 'does not match the pinned digest');
    expectError(result, SMOLVM_RELEASE.archiveSha256[triple!]!);
    expect(hits).toEqual([`/releases/v${SMOLVM_RELEASE.version}/${smolvmArchiveName(triple!)}`]);
    expect(await readdir(installDir())).toEqual([]);
  });

  // INVARIANT: network failures retry and then fail loudly (AGENTS.md remote rules).
  test('a server that keeps failing is tried three times, then the command fails naming the error', async () => {
    respond = () => new Response('down', { status: 502, statusText: 'Bad Gateway' });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expectError(result, 'after 3 attempts');
    expectError(result, '--release-base');
    expectError(result, '502');
    expect(hits.length).toBe(3);
  }, 30_000);

  test('an install that already verifies is reused, and written to lazy.toml only when asked', async () => {
    const launcher = await fakeInstalledTree(join(installDir(), triple!));

    const noTty = await run();
    expect(noTty.exitCode).toBe(0);
    expectOutput(noTty, 'already installed and verified');
    expectOutput(noTty, `binary = "${launcher}"`);
    expectOutput(noTty, 're-run with --yes');
    expect(await readFile(join(ctx.root, 'lazy.toml'), 'utf8')).not.toContain(launcher);

    const yes = await run(['--yes']);
    expect(yes.exitCode).toBe(0);
    const toml = Bun.TOML.parse(await readFile(join(ctx.root, 'lazy.toml'), 'utf8')) as { smolvm?: { binary?: string } };
    expect(toml.smolvm?.binary).toBe(launcher);

    const again = await run();
    expectOutput(again, 'already points [smolvm] binary at it');
    expect(hits).toEqual([]);
  });

  test('at a terminal it asks before writing lazy.toml: declining leaves it, accepting writes it', async () => {
    const launcher = await fakeInstalledTree(join(installDir(), triple!));
    const declined = await run([], { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'decline' });
    expect(declined.exitCode).toBe(0);
    expectOutput(declined, 'Set [smolvm] binary in');
    expect(await readFile(join(ctx.root, 'lazy.toml'), 'utf8')).not.toContain(launcher);

    const accepted = await run([], { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'accept' });
    expect(accepted.exitCode).toBe(0);
    const toml = Bun.TOML.parse(await readFile(join(ctx.root, 'lazy.toml'), 'utf8')) as { smolvm?: { binary?: string } };
    expect(toml.smolvm?.binary).toBe(launcher);
    expect(hits).toEqual([]);
  });
});

/**
 * A tree as the installer leaves it, recorded as unpacked from the pinned
 * archive. The launch check trusts the manifest's archive line (it was
 * checked at install time) and re-hashes every file.
 */
async function fakeInstalledTree(tree: string): Promise<string> {
  await mkdir(tree, { recursive: true });
  const files: Record<string, string> = { smolvm: '#!/bin/sh\necho smolvm\n', 'smolvm-bin': 'bin' };
  for (const [name, body] of Object.entries(files)) await writeFile(join(tree, name), body);
  await chmod(join(tree, 'smolvm'), 0o755);
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const lines = [`archive ${smolvmArchiveName(triple!)} ${SMOLVM_RELEASE.archiveSha256[triple!]}`,
    ...Object.keys(files).sort().map((p) => `file ${sha(files[p]!)} ${p}`)];
  await writeFile(join(tree, 'smolvm.sha256'), `${lines.join('\n')}\n`);
  return join(tree, 'smolvm');
}
