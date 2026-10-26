/**
 * Fetch, verify and install the pinned smolvm release for solo lazy — what
 * `lazy system smolvm-install` runs, so an installed lazy (no source checkout,
 * no Lazy Teams' `bin/vendor-smolvm`) can get the smolvm its runner accepts.
 *
 * It installs exactly the shape {@link verifySmolvmBinary} checks, and by the
 * same pin (smolvm-docker-machine.json `release`): the whole distribution
 * unpacked as tar produces it, with the vendoring manifest beside the launcher.
 * The rules it shares with `bin/vendor-smolvm`:
 *
 *   - The digest is the PINNED one, never a checksum file fetched alongside
 *     the archive. A mismatch is refused and the download deleted; nothing is
 *     unpacked.
 *   - Never upstream's install.sh, never a `smolvm` from PATH.
 *   - Unpacked into staging beside the destination and moved into place with
 *     one rename, so no half-installed tree is ever where lazy looks.
 *   - The installed tree is re-verified by the very check every launch runs.
 *
 * Network failures are retried (withRemoteRetry) and then fail loudly.
 * Re-running is idempotent: a tree that already verifies is left alone.
 */
import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, writeFile } from 'fs/promises';
import { dirname, join, relative } from 'path';
import { SMOLVM_RELEASE } from './smolvm-docker-machine';
import { SmolvmPinError, smolvmArchiveName, verifySmolvmBinary, type SmolvmPin } from './smolvm-release';
import { withRemoteRetry } from '../utils/retry';
import { spawn } from '../utils/spawn';

/** Where an install lands: one directory per version and platform, under `~/.lazy/smolvm/`. */
export function smolvmInstallDir(home: string, platformTriple: string, pin: SmolvmPin = SMOLVM_RELEASE): string {
  return join(home, '.lazy', 'smolvm', pin.version, platformTriple);
}

export function smolvmArchiveUrl(platformTriple: string, releaseBase: string = SMOLVM_RELEASE.releaseBase, pin: SmolvmPin = SMOLVM_RELEASE): string {
  return `${releaseBase.replace(/\/+$/, '')}/v${pin.version}/${smolvmArchiveName(platformTriple, pin)}`;
}

export interface SmolvmInstallOptions {
  home: string;
  platformTriple: string;
  /** Where releases are downloaded from — GitHub unless a mirror is named. The digest is checked either way. */
  releaseBase?: string;
  say: (line: string) => void;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  backoffMs?: number[];
  pin?: SmolvmPin;
}

export interface SmolvmInstallResult {
  launcher: string;
  outcome: 'installed' | 'already-installed' | 'replaced';
}

const PROGRESS_STEP_BYTES = 8 * 1024 * 1024;

function mib(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Stream `url` into `dest`, hashing as it goes and reporting progress. Returns the sha256. */
async function download(url: string, dest: string, doFetch: typeof fetch, say: (line: string) => void): Promise<string> {
  const response = await doFetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} returned ${response.status} ${response.statusText}`);
  }
  const total = Number(response.headers.get('content-length') ?? 0);
  const hash = createHash('sha256');
  const out = createWriteStream(dest);
  const closed = new Promise<void>((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
  let received = 0;
  let nextReport = PROGRESS_STEP_BYTES;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.byteLength;
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve));
      if (received >= nextReport) {
        say(total > 0 ? `  downloaded ${mib(received)} of ${mib(total)} (${Math.floor((received / total) * 100)}%)` : `  downloaded ${mib(received)}`);
        nextReport += PROGRESS_STEP_BYTES;
      }
    }
  } finally {
    out.end();
    await closed;
  }
  if (total > 0 && received !== total) {
    throw new Error(`GET ${url} ended after ${received} of ${total} bytes`);
  }
  say(`  downloaded ${mib(received)}`);
  return hash.digest('hex');
}

/** The vendoring manifest's lines for `tree` — the format verifySmolvmBinary and Teams' SmolvmRelease read. */
async function manifestBody(tree: string, archiveName: string, archiveSha256: string, except: string): Promise<string> {
  const entries: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (abs === except) continue;
      const st = await lstat(abs);
      if (st.isDirectory()) { await visit(abs); continue; }
      const rel = relative(tree, abs);
      if (/\s/.test(rel)) throw new SmolvmPinError(`the smolvm archive contains a path with whitespace (${JSON.stringify(rel)}), which no smolvm release ships; do not run it`);
      if (st.isSymbolicLink()) entries.push(`symlink ${rel} ${await readlink(abs)}`);
      else if (st.isFile()) entries.push(`file ${await sha256Of(abs)} ${rel}`);
      else throw new SmolvmPinError(`the smolvm archive contains ${rel}, which is not a file; do not run it`);
    }
  };
  await visit(tree);
  entries.sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
  return [`archive ${archiveName} ${archiveSha256}`, ...entries].join('\n') + '\n';
}

function pathOf(line: string): string {
  const parts = line.split(' ');
  return parts[0] === 'file' ? parts[2]! : parts[1]!;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return hash.digest('hex');
}

async function findLaunchers(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.name === 'smolvm' && entry.isFile()) found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function installSmolvm(opts: SmolvmInstallOptions): Promise<SmolvmInstallResult> {
  const pin = opts.pin ?? SMOLVM_RELEASE;
  const { platformTriple, say } = opts;
  // Before a byte is fetched: an unconfirmed pin has nothing trustworthy to verify
  // against (Teams' bin/vendor-smolvm refuses the same way).
  if (pin.pinConfirmed === false) {
    throw new SmolvmPinError(`the smolvm ${pin.version} pin has not been confirmed out of band yet, so lazy will not download it; use a lazy release whose pin is confirmed`);
  }
  const expected = pin.archiveSha256[platformTriple];
  if (!expected) {
    throw new SmolvmPinError(`smolvm ${pin.version} has no pinned build for ${platformTriple}; builds are pinned for ${Object.keys(pin.archiveSha256).join(', ')}`);
  }
  const target = smolvmInstallDir(opts.home, platformTriple, pin);
  const launcher = join(target, 'smolvm');

  let replacing = false;
  if (await exists(target)) {
    try {
      await verifySmolvmBinary(launcher, platformTriple, pin);
      say(`smolvm ${pin.version} (${platformTriple}) is already installed and verified at ${target}`);
      return { launcher, outcome: 'already-installed' };
    } catch (err) {
      say(`the smolvm at ${target} does not verify (${err instanceof Error ? err.message : String(err)}); replacing it`);
      replacing = true;
    }
  }

  const archiveName = smolvmArchiveName(platformTriple, pin);
  const url = smolvmArchiveUrl(platformTriple, opts.releaseBase, pin);
  say(`smolvm ${pin.version} (${platformTriple})`);
  say(`  fetching ${url}`);

  await mkdir(dirname(target), { recursive: true });
  // Staged BESIDE the destination: the final step is a rename, which only
  // works within one filesystem.
  const staging = await mkdtemp(join(dirname(target), '.smolvm-installing-'));
  try {
    const archive = join(staging, archiveName);
    const doFetch = opts.fetch ?? fetch;
    let actual: string;
    try {
      actual = await withRemoteRetry(
        () => download(url, archive, doFetch, say),
        `download ${url}`,
        { backoffMs: opts.backoffMs },
      );
    } catch (err) {
      const last = err instanceof Error ? err.message.replace(/^.*Last error: /s, '').replace(/\. Check your network.*$/s, '') : String(err);
      throw new Error(`could not download ${url} after 3 attempts: ${last}. Check your network connection and run this again, or pass --release-base <mirror>.`);
    }
    if (actual !== expected) {
      await rm(archive, { force: true });
      throw new SmolvmPinError(
        `the downloaded ${archiveName} does not match the pinned digest.\n` +
        `  expected ${expected}\n  actual   ${actual}\n` +
        'The download was deleted and nothing was unpacked. Either the transfer was corrupted — run this again — ' +
        'or the release served is not the release lazy pins, which is exactly what the pin exists to catch.',
      );
    }
    say(`  sha256 ${actual} matches the pin`);

    // `-p` keeps modes (and on macOS the code signature's xattrs): a
    // re-signed binary loses the Hypervisor entitlement and no VM starts.
    const unpacked = join(staging, 'unpacked');
    await mkdir(unpacked);
    const tar = spawn(['tar', '-xzpf', archive, '-C', unpacked], { stdout: 'pipe', stderr: 'pipe', timeout: 300_000 });
    const [code, tarErr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
    if (code !== 0) throw new Error(`could not unpack ${archiveName} (tar exited ${code}): ${tarErr.trim()}`);
    await rm(archive, { force: true });

    const launchers = await findLaunchers(unpacked);
    if (launchers.length !== 1) {
      throw new SmolvmPinError(`expected exactly one file named smolvm in ${archiveName}, found ${launchers.length}; the archive layout changed, so lazy will not guess which tree to install`);
    }
    const tree = dirname(launchers[0]!);
    const manifest = `${join(tree, 'smolvm')}.sha256`;
    await writeFile(manifest, await manifestBody(tree, archiveName, actual, manifest));

    // A tree already there is moved aside, then deleted once the new one is in place.
    const previous = `${target}.previous-${Date.now()}`;
    if (replacing) await rename(target, previous);
    await rename(tree, target);
    if (replacing) await rm(previous, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  await verifySmolvmBinary(launcher, platformTriple, pin);
  say(`  installed ${target}`);
  return { launcher, outcome: replacing ? 'replaced' : 'installed' };
}
