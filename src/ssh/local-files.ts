/**
 * The lazy-owned SSH files on a person's machine, all under `~/.lazy/ssh/`
 * (docs/design/task-sessions-and-ssh.md §5). Lazy writes Host blocks to
 * {@link lazySshConfigPath} and, with consent, adds an Include to ~/.ssh/config.
 * Host keys stay in its own {@link lazyKnownHostsPath}.
 *
 *   id_ed25519 / .pub   this machine's key, made by `--ssh-config --install`
 *   known_hosts         host keys pinned from the authenticated lazy channel
 *   config              the Host blocks, one per task, replaced in place
 *   authorized_keys     solo only, optional: further keys the LOCAL daemon
 *                       accepts besides id_ed25519.pub (one per line)
 */

import { join, resolve } from 'path';
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { getHome } from '../utils/home';
import { generateEd25519KeyPair, parseAuthorizedKeys, parsePublicKeyLine, type ParsedPublicKey } from './keys';

export function lazySshDir(): string {
  return join(getHome(), '.lazy', 'ssh');
}
export const lazySshKeyPath = () => join(lazySshDir(), 'id_ed25519');
export const lazyKnownHostsPath = () => join(lazySshDir(), 'known_hosts');
export const lazySshConfigPath = () => join(lazySshDir(), 'config');
export const lazyAuthorizedKeysPath = () => join(lazySshDir(), 'authorized_keys');

/** The `~` spelling a config file can carry, so it survives a home move. */
export const LAZY_SSH_CONFIG_INCLUDE = 'Include ~/.lazy/ssh/config';

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Write a file atomically (beside, then rename) with the given mode. */
async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

/**
 * This machine's lazy key, made on first use. Returns the public line and
 * whether it was created now.
 */
export async function ensureLocalSshKey(comment: string): Promise<{ publicKey: ParsedPublicKey; publicLine: string; created: boolean }> {
  await mkdir(lazySshDir(), { recursive: true, mode: 0o700 });
  const existing = await readIfExists(`${lazySshKeyPath()}.pub`);
  if (existing !== null) {
    const parsed = parsePublicKeyLine(existing);
    if (!parsed) throw new Error(`${lazySshKeyPath()}.pub is not an OpenSSH public key; move it aside and run again`);
    if ((await readIfExists(lazySshKeyPath())) === null) {
      throw new Error(`${lazySshKeyPath()} is missing but its .pub exists; move the .pub aside and run again`);
    }
    return { publicKey: parsed, publicLine: existing.trim(), created: false };
  }
  const pair = generateEd25519KeyPair(comment);
  await writeAtomic(lazySshKeyPath(), pair.privateKey, 0o600);
  await writeAtomic(`${lazySshKeyPath()}.pub`, `${pair.publicKey}\n`, 0o644);
  return { publicKey: parsePublicKeyLine(pair.publicKey)!, publicLine: pair.publicKey, created: true };
}

/**
 * The keys a SOLO daemon accepts: this machine's lazy key plus the optional
 * `authorized_keys` beside it. Read by the daemon from its own user's home —
 * never from a request. Empty when neither exists.
 */
export async function soloAuthorizedKeys(): Promise<{ ok: true; keys: ParsedPublicKey[] } | { ok: false; error: string }> {
  const own = await readIfExists(`${lazySshKeyPath()}.pub`);
  const extra = await readIfExists(lazyAuthorizedKeysPath());
  return parseAuthorizedKeys([own ?? '', extra ?? ''].join('\n'));
}

/** Replace (or add) the known_hosts line for one alias. */
export async function pinKnownHost(alias: string, hostPublicKey: string): Promise<void> {
  const parsed = parsePublicKeyLine(hostPublicKey);
  if (!parsed) throw new Error('the server sent a host key that is not an OpenSSH public key');
  await mkdir(lazySshDir(), { recursive: true, mode: 0o700 });
  const current = (await readIfExists(lazyKnownHostsPath())) ?? '';
  const kept = current.split('\n').filter((l) => l.trim() && l.split(/\s+/)[0] !== alias);
  kept.push(`${alias} ${parsed.line}`);
  await writeAtomic(lazyKnownHostsPath(), `${kept.join('\n')}\n`, 0o644);
}

/**
 * Replace (or add) one Host block in the lazy-owned config. Blocks are kept
 * between marker comments so a re-install replaces exactly its own block.
 */
export async function upsertSshConfigBlock(alias: string, block: string): Promise<void> {
  await mkdir(lazySshDir(), { recursive: true, mode: 0o700 });
  const begin = `# >>> lazy ${alias}`;
  const end = `# <<< lazy ${alias}`;
  const current = (await readIfExists(lazySshConfigPath())) ?? '';
  const lines = current.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (l === begin) { skipping = true; continue; }
    if (skipping) { if (l === end) skipping = false; continue; }
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  out.push(...(out.length ? [''] : []), begin, block.trimEnd(), end, '');
  await writeAtomic(lazySshConfigPath(), out.join('\n'), 0o644);
}

type IncludeStatus = 'installed' | 'scoped' | 'unexpanded' | 'missing';
interface IncludePath { value: string; start: number; end: number }

/** Keep token positions so moving lazy's path leaves other arguments untouched. */
function includePaths(line: string): { paths: IncludePath[]; comment: number | null } | null {
  const prefix = /^\s*Include(?:\s*=\s*|\s+)/i.exec(line);
  if (!prefix) return null;
  const paths: IncludePath[] = [];
  let position = prefix[0].length;
  while (position < line.length) {
    if (/\s/.test(line[position]!)) { position++; continue; }
    if (line[position] === '#') return { paths, comment: position };
    const start = position;
    let value = '';
    let quote: string | null = null;
    while (position < line.length) {
      const c = line[position]!;
      if (!quote && (/\s/.test(c) || c === '#')) break;
      position++;
      if (c === '\\' && position < line.length) { value += line[position++]!; }
      else if (c === quote) quote = null;
      else if (!quote && (c === '"' || c === "'")) quote = c;
      else value += c;
    }
    paths.push({ value, start, end: position });
  }
  return { paths, comment: null };
}

function expandedIncludePath(value: string): string {
  const home = getHome();
  const expanded = value.replace(/^~(?=\/|$)/, () => home)
    .replace(/\$(?:\{HOME\}|HOME)(?=\/|$)/g, () => home);
  // OpenSSH resolves relative Include paths under ~/.ssh, not the current cwd.
  return resolve(home, '.ssh', expanded);
}

function includesLazy(value: string): boolean {
  return new Bun.Glob(expandedIncludePath(value)).match(lazySshConfigPath());
}

// OpenSSH expands ${HOME}, but interprets bare $HOME as a literal path component.
const hasBareHome = (value: string) => /\$HOME(?=\/|$)/.test(value);

function inspectIncludes(content: string): IncludeStatus {
  let scoped = false;
  let foundScoped = false;
  let foundUnexpanded = false;
  for (const line of content.split('\n')) {
    if (/^\s*(Host|Match)(?:\s|=)/i.test(line)) scoped = true;
    const include = includePaths(line);
    for (const path of include?.paths ?? []) {
      if (!includesLazy(path.value)) continue;
      if (hasBareHome(path.value)) foundUnexpanded = true;
      else if (!scoped) return 'installed';
      else foundScoped = true;
    }
  }
  return foundScoped ? 'scoped' : foundUnexpanded ? 'unexpanded' : 'missing';
}

/** Distinguish a working global Include from one restricted by Host/Match. */
export async function sshConfigIncludeStatus(): Promise<IncludeStatus> {
  return inspectIncludes((await readIfExists(join(getHome(), '.ssh', 'config'))) ?? '');
}

export async function sshConfigIncludesLazy(): Promise<boolean> {
  return await sshConfigIncludeStatus() === 'installed';
}

/** Replace only scoped or unexpanded exact paths; never move a shared glob. */
function withoutReplacedLazyIncludes(content: string): { content: string; moved: boolean } {
  let scoped = false;
  let moved = false;
  const lines: string[] = [];
  for (const line of content.split('\n')) {
    if (/^\s*(Host|Match)(?:\s|=)/i.test(line)) scoped = true;
    const include = includePaths(line);
    if (!include) { lines.push(line); continue; }
    const own = include.paths.filter(path => (scoped || hasBareHome(path.value)) && expandedIncludePath(path.value) === lazySshConfigPath());
    if (!own.length) { lines.push(line); continue; }
    moved = true;
    if (own.length === include.paths.length) {
      // Retain a person's comment even when its Include line moves away.
      if (include.comment !== null) lines.push((line.match(/^\s*/)?.[0] ?? '') + line.slice(include.comment));
      continue;
    }
    let kept = line;
    for (const path of own.reverse()) kept = kept.slice(0, path.start) + kept.slice(path.end);
    lines.push(kept);
  }
  return { content: lines.join('\n'), moved };
}

/** Called only after consent. Preserve the original content before changing config. */
export async function installSshConfigInclude(): Promise<{ backup: string | null; changed: boolean; moved: boolean }> {
  const dir = join(getHome(), '.ssh');
  const path = join(dir, 'config');
  const previous = await readIfExists(path);
  if (inspectIncludes(previous ?? '') === 'installed') return { backup: null, changed: false, moved: false };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const backup = previous === null ? null : path + '.lazy-backup';
  if (backup) await writeAtomic(backup, previous!, 0o600);
  const relocated = withoutReplacedLazyIncludes(previous ?? '');
  await writeAtomic(path, LAZY_SSH_CONFIG_INCLUDE + '\n' + relocated.content, 0o600);
  return { backup, changed: true, moved: relocated.moved };
}
