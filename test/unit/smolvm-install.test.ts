/**
 * `lazy system smolvm-install`'s core (src/vm/smolvm-install.ts) against a stub
 * download: it installs only an archive whose digest is the pinned one, in the
 * shape the launch-time pin check accepts.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { installSmolvm, smolvmArchiveUrl, smolvmInstallDir } from '../../src/vm/smolvm-install';
import { SmolvmPinError, forgetVerifiedSmolvmForTests, verifySmolvmBinary } from '../../src/vm/smolvm-release';
import { SMOLVM_RELEASE } from '../../src/vm/smolvm-docker-machine';

const PLATFORM = 'linux-arm64';
let work: string;
let home: string;
let archive: Uint8Array<ArrayBuffer>;
let pin: { version: string; archiveSha256: Record<string, string> };

/** A release archive shaped like smolvm's: one top directory with the launcher, its binary, a library and a symlink. */
async function buildArchive(): Promise<Uint8Array<ArrayBuffer>> {
  const src = join(work, 'src', `smolvm-1.29.0-${PLATFORM}`);
  await mkdir(join(src, 'lib'), { recursive: true });
  await writeFile(join(src, 'smolvm'), '#!/bin/sh\nexec "$(dirname "$0")/smolvm-bin" "$@"\n');
  await chmod(join(src, 'smolvm'), 0o755);
  await writeFile(join(src, 'smolvm-bin'), 'bin');
  await writeFile(join(src, 'lib', 'libkrun.so.1.0'), 'lib');
  await symlink('libkrun.so.1.0', join(src, 'lib', 'libkrun.so'));
  const out = join(work, 'archive.tar.gz');
  const tar = Bun.spawn(['tar', '-czf', out, '-C', join(work, 'src'), `smolvm-1.29.0-${PLATFORM}`]);
  expect(await tar.exited).toBe(0);
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function stubFetch(responses: Array<() => Response>): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const f = (async (url: string) => {
    urls.push(String(url));
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  }) as unknown as typeof fetch;
  return { fetch: f, urls };
}

const ok = () => new Response(archive, { headers: { 'content-length': String(archive.byteLength) } });
const lines: string[] = [];
const say = (l: string) => lines.push(l);

beforeEach(async () => {
  forgetVerifiedSmolvmForTests();
  lines.length = 0;
  work = await realpath(await mkdtemp(join(tmpdir(), 'smolvm-install-')));
  home = join(work, 'home');
  archive = await buildArchive();
  pin = { version: '1.29.0', archiveSha256: { [PLATFORM]: sha(archive) } };
});
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

describe('installSmolvm', () => {
  test('a download matching the pin is installed under ~/.lazy/smolvm/<version>/<platform> and passes the launch check', async () => {
    const { fetch, urls } = stubFetch([ok]);
    const result = await installSmolvm({ home, platformTriple: PLATFORM, say, fetch, pin, backoffMs: [1, 1] });
    expect(result.outcome).toBe('installed');
    expect(result.launcher).toBe(join(home, '.lazy', 'smolvm', '1.29.0', PLATFORM, 'smolvm'));
    expect(urls).toEqual([smolvmArchiveUrl(PLATFORM, SMOLVM_RELEASE.releaseBase, pin)]);
    expect(await verifySmolvmBinary(result.launcher, PLATFORM, pin)).toBe(result.launcher);
    const manifest = await readFile(`${result.launcher}.sha256`, 'utf8');
    expect(manifest.split('\n')[0]).toBe(`archive smolvm-1.29.0-${PLATFORM}.tar.gz ${sha(archive)}`);
    expect(manifest).toContain('symlink lib/libkrun.so libkrun.so.1.0');
    expect(lines.some((l) => l.includes('matches the pin'))).toBe(true);
    // Nothing left beside the install: staging is gone.
    expect(await readdir(join(home, '.lazy', 'smolvm', '1.29.0'))).toEqual([PLATFORM]);
  });

  // INVARIANT: a download whose digest is not the pinned one is never unpacked
  // and never kept. The pin is the whole supply-chain defence; an install that
  // continued past a mismatch would run whatever the server sent.
  test('a digest mismatch is refused, the download deleted and nothing installed', async () => {
    const { fetch } = stubFetch([() => new Response(new TextEncoder().encode('not smolvm'))]);
    const err = await installSmolvm({ home, platformTriple: PLATFORM, say, fetch, pin, backoffMs: [1, 1] }).catch((e) => e);
    expect(err).toBeInstanceOf(SmolvmPinError);
    expect(err.message).toContain('does not match the pinned digest');
    expect(err.message).toContain(pin.archiveSha256[PLATFORM]);
    expect(await readdir(join(home, '.lazy', 'smolvm', '1.29.0'))).toEqual([]);
  });

  // INVARIANT: network failures retry, then fail loudly (AGENTS.md remote rules).
  test('a failed download is retried and then succeeds', async () => {
    const { fetch, urls } = stubFetch([
      () => new Response('busy', { status: 503, statusText: 'Service Unavailable' }),
      () => { throw new TypeError('connection reset'); },
      ok,
    ]);
    const result = await installSmolvm({ home, platformTriple: PLATFORM, say, fetch, pin, backoffMs: [1, 1] });
    expect(result.outcome).toBe('installed');
    expect(urls.length).toBe(3);
  });

  test('a download that keeps failing fails loudly after three attempts and installs nothing', async () => {
    const { fetch, urls } = stubFetch([() => new Response('gone', { status: 500, statusText: 'Internal Server Error' })]);
    const err = await installSmolvm({ home, platformTriple: PLATFORM, say, fetch, pin, backoffMs: [1, 1] }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('after 3 attempts');
    expect(err.message).not.toContain('--offline-override');
    expect(err.message).toContain('500');
    expect(urls.length).toBe(3);
    expect(await readdir(join(home, '.lazy', 'smolvm', '1.29.0'))).toEqual([]);
  });

  test('re-running is idempotent: a verified install is left alone and nothing is fetched', async () => {
    await installSmolvm({ home, platformTriple: PLATFORM, say, fetch: stubFetch([ok]).fetch, pin });
    const again = stubFetch([ok]);
    const result = await installSmolvm({ home, platformTriple: PLATFORM, say, fetch: again.fetch, pin });
    expect(result.outcome).toBe('already-installed');
    expect(again.urls).toEqual([]);
  });

  test('a damaged install is replaced', async () => {
    const first = await installSmolvm({ home, platformTriple: PLATFORM, say, fetch: stubFetch([ok]).fetch, pin });
    await writeFile(join(smolvmInstallDir(home, PLATFORM, pin), 'smolvm-bin'), 'tampered');
    forgetVerifiedSmolvmForTests();
    const result = await installSmolvm({ home, platformTriple: PLATFORM, say, fetch: stubFetch([ok]).fetch, pin });
    expect(result.outcome).toBe('replaced');
    expect(await verifySmolvmBinary(first.launcher, PLATFORM, pin)).toBe(first.launcher);
    expect(await readdir(join(home, '.lazy', 'smolvm', '1.29.0'))).toEqual([PLATFORM]);
  });

  // INVARIANT: an unconfirmed pin is refused before anything is fetched — the
  // same gate Teams' bin/vendor-smolvm enforces, so a version bump cannot
  // install digests nobody confirmed out of band.
  test('an unconfirmed pin is refused before anything is fetched', async () => {
    const { fetch, urls } = stubFetch([ok]);
    const err = await installSmolvm({ home, platformTriple: PLATFORM, say, fetch, pin: { ...pin, pinConfirmed: false } }).catch((e) => e);
    expect(err).toBeInstanceOf(SmolvmPinError);
    expect(err.message).toContain('not been confirmed');
    expect(urls).toEqual([]);
  });

  test('a platform with no pin is refused before anything is fetched', async () => {
    const { fetch, urls } = stubFetch([ok]);
    const err = await installSmolvm({ home, platformTriple: 'darwin-x86_64', say, fetch, pin }).catch((e) => e);
    expect(err).toBeInstanceOf(SmolvmPinError);
    expect(urls).toEqual([]);
  });

  test('the real pin is the shared facts file\'s, downloaded from GitHub releases', () => {
    expect(smolvmArchiveUrl('darwin-arm64')).toBe(
      `https://github.com/smol-machines/smolvm/releases/download/v${SMOLVM_RELEASE.version}/smolvm-${SMOLVM_RELEASE.version}-darwin-arm64.tar.gz`,
    );
  });
});
