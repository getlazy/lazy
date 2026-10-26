/**
 * Is this smolvm the release lazy pins? — the TypeScript half of the supply-chain
 * policy Lazy Teams enforces in `lazy-teams/app/clients/smolvm_release.rb`
 * (`SmolvmRelease.verify_binary!`), for solo lazy's smolvm runner.
 *
 * The same rules, because it is the same bet (docs/spikes/smolvm.md §6):
 *
 *   - **An absolute path to a vendored tree**, never a `smolvm` found on PATH.
 *   - **The vendoring manifest** `lazy system smolvm-install` (or Teams' `bin/vendor-smolvm`) writes beside the
 *     launcher (`<launcher>.sha256`) must name THIS release's archive for this
 *     platform, with the digest pinned in the shared facts file
 *     (smolvm-docker-machine.json `release`, which a Rails test holds equal to
 *     `SmolvmRelease`). A tree vendored for another version is the wrong
 *     version, whatever its `--version` would say.
 *   - **Every file in the tree is as recorded**: each listed file re-hashed,
 *     each listed symlink's target compared, and anything present but unlisted
 *     refused — the thing that runs is the tree, not one file.
 *
 * Paid once per process per unchanged tree: a success is remembered under a
 * fingerprint of every entry's lstat, so a file swapped later is re-verified.
 *
 * Every failure says what to do. The point of occurrence adds the one generic
 * "run lazy doctor" pointer; it never falls back to another smolvm or to Docker.
 */
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { access, constants, lstat, readdir, readFile, readlink } from 'fs/promises';
import { dirname, isAbsolute, join, relative } from 'path';
import { SMOLVM_RELEASE } from './smolvm-docker-machine';

export class SmolvmPinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmolvmPinError';
  }
}

/** The platform triple smolvm names its release archives with, or null where it ships none. */
export function smolvmPlatform(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x86_64';
  return null;
}

/** The pin a smolvm is checked against: the shared facts file's, unless a test supplies its own. */
export interface SmolvmPin { version: string; archiveSha256: Readonly<Record<string, string>>; pinConfirmed?: boolean }

export function smolvmArchiveName(platformTriple: string, pin: SmolvmPin = SMOLVM_RELEASE): string {
  return `smolvm-${pin.version}-${platformTriple}.tar.gz`;
}

type ManifestEntry = { kind: 'file'; sha256: string; path: string } | { kind: 'symlink'; path: string; target: string };

function parseManifest(manifest: string, text: string): { archiveName: string; archiveSha256: string; entries: ManifestEntry[] } {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const head = /^archive (\S+) ([0-9a-f]{64})$/.exec(lines[0] ?? '');
  if (!head) {
    throw new SmolvmPinError(`the vendoring manifest ${manifest} does not start with the archive it was unpacked from; reinstall it with "lazy system smolvm-install"`);
  }
  const entries = lines.slice(1).map((line): ManifestEntry => {
    const file = /^file ([0-9a-f]{64}) (\S+)$/.exec(line);
    if (file) return { kind: 'file', sha256: file[1]!, path: file[2]! };
    const link = /^symlink (\S+) (\S+)$/.exec(line);
    if (link) return { kind: 'symlink', path: link[1]!, target: link[2]! };
    throw new SmolvmPinError(`the vendoring manifest ${manifest} has a line it should not (${JSON.stringify(line)}); reinstall it with "lazy system smolvm-install"`);
  });
  return { archiveName: head[1]!, archiveSha256: head[2]!, entries };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Every entry under `tree`, relative, with the lstat facts a swap would change. */
async function walk(tree: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const st = await lstat(abs);
      const rel = relative(tree, abs);
      if (st.isDirectory()) { await visit(abs); continue; }
      const link = st.isSymbolicLink() ? await readlink(abs) : '';
      out.set(rel, `${st.mode}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}:${link}`);
    }
  };
  await visit(tree);
  return out;
}

const verified = new Map<string, string>();

/**
 * Verify `launcher` against the pin; resolves to the launcher path when it is
 * the pinned release. Throws {@link SmolvmPinError} with the fix otherwise.
 */
export async function verifySmolvmBinary(launcher: string, platformTriple: string | null = smolvmPlatform(), pin: SmolvmPin = SMOLVM_RELEASE): Promise<string> {
  if (!isAbsolute(launcher)) {
    throw new SmolvmPinError(
      `the smolvm binary must be an absolute path to a vendored copy, got ${JSON.stringify(launcher)}. ` +
      'A bare name would be resolved from PATH, and lazy never runs a smolvm because it had the right name — ' +
      'install it with "lazy system smolvm-install" and set [smolvm] binary to the path it prints.',
    );
  }
  if (!platformTriple) {
    throw new SmolvmPinError(`smolvm ${pin.version} has no release for ${process.platform}/${process.arch} (an Intel Mac cannot run it)`);
  }
  try { await access(launcher, constants.X_OK); }
  catch { throw new SmolvmPinError(`no executable smolvm at ${launcher}; install it with "lazy system smolvm-install"`); }

  const tree = dirname(launcher);
  // smolvm's decompressed disk templates (`<name>.ext4` beside a listed
  // `<name>.ext4.zst`) are written by smolvm itself on first use; they are
  // left out of the fingerprint and tolerated below, exactly as Teams does
  // (SmolvmRelease.tolerated_derivative?).
  const derivative = (p: string, present: Map<string, string>) => present.has(`${p}.zst`);
  const present0 = await walk(tree);
  const fingerprint = [...present0.entries()].filter(([p]) => !derivative(p, present0))
    .sort(([a], [b]) => a.localeCompare(b)).map(([p, f]) => `${p}=${f}`).join('\n');
  if (verified.get(launcher) === fingerprint) return launcher;

  const manifestPath = `${launcher}.sha256`;
  let text: string;
  try { text = await readFile(manifestPath, 'utf8'); }
  catch {
    throw new SmolvmPinError(`no vendoring manifest at ${manifestPath}: a smolvm tree that appeared without one was never verified. Install it with "lazy system smolvm-install"`);
  }
  const manifest = parseManifest(manifestPath, text);
  const expectedArchive = smolvmArchiveName(platformTriple, pin);
  if (manifest.archiveName !== expectedArchive) {
    throw new SmolvmPinError(
      `the smolvm at ${launcher} was vendored from ${manifest.archiveName}, but lazy runs smolvm ${pin.version} ` +
      `(${expectedArchive}). Reinstall it with "lazy system smolvm-install"`,
    );
  }
  const pinned = pin.archiveSha256[platformTriple];
  if (manifest.archiveSha256 !== pinned) {
    throw new SmolvmPinError(
      `the smolvm at ${launcher} was vendored from a ${expectedArchive} with digest ${manifest.archiveSha256}, ` +
      `but the pin is ${pinned}. Do not run it; reinstall it with "lazy system smolvm-install"`,
    );
  }

  const present = await walk(tree);
  const manifestName = relative(tree, manifestPath);
  const recorded = new Set<string>([manifestName]);
  let launcherListed = false;
  for (const entry of manifest.entries) {
    if (entry.path.split('/').includes('..') || isAbsolute(entry.path)) {
      throw new SmolvmPinError(`the vendoring manifest ${manifestPath} names a path outside its tree (${entry.path}); reinstall it with "lazy system smolvm-install"`);
    }
    recorded.add(entry.path);
    const abs = join(tree, entry.path);
    if (!present.has(entry.path)) throw new SmolvmPinError(`${abs} is listed in ${manifestPath} but missing; reinstall it with "lazy system smolvm-install"`);
    const st = await lstat(abs);
    if (entry.kind === 'symlink') {
      if (!st.isSymbolicLink() || (await readlink(abs)) !== entry.target) {
        throw new SmolvmPinError(`${abs} is not the symlink to ${entry.target} that ${manifestPath} records; reinstall it with "lazy system smolvm-install"`);
      }
      continue;
    }
    if (!st.isFile() || (await sha256File(abs)) !== entry.sha256) {
      throw new SmolvmPinError(`${abs} does not match the digest ${manifestPath} records; the vendored smolvm was changed after it was verified. Reinstall it with "lazy system smolvm-install"`);
    }
    if (abs === launcher) launcherListed = true;
  }
  if (!launcherListed) throw new SmolvmPinError(`${manifestPath} does not list the launcher ${launcher} itself; reinstall it with "lazy system smolvm-install"`);
  const listedFiles = new Set(manifest.entries.filter((e) => e.kind === 'file').map((e) => e.path));
  const unlisted = [...present.keys()].filter((p) => !recorded.has(p) && !listedFiles.has(`${p}.zst`));
  if (unlisted.length > 0) {
    throw new SmolvmPinError(`the vendored smolvm tree ${tree} holds files its manifest does not list (${unlisted.slice(0, 5).join(', ')}); reinstall it with "lazy system smolvm-install"`);
  }
  verified.set(launcher, fingerprint);
  return launcher;
}

/** Tests only. */
export function forgetVerifiedSmolvmForTests(): void {
  verified.clear();
}
