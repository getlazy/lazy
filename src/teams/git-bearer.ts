/**
 * Git to a Teams install, machine-wide, at the exact address typed — the `gh auth setup-git` of
 * lazy. After one `lazy login <install>`, a plain
 * `git clone https://<install>/git/<team>/<project>.git` works, in any
 * directory, with or without an authenticating proxy in front of the install.
 *
 * THE MECHANISM IS A USER-LEVEL INCLUDE, NOT A CREDENTIAL HELPER. An
 * authenticating proxy validates a `Bearer` JWT and cannot read a Basic
 * password, and a credential helper can only hand git a Bearer credential from
 * git 2.46 (`authtype`) — older than what macOS ships (2.39). So the user-level
 * git config (`git config --global`) gets one `include.path` per install,
 * pointing at a 0600 file holding
 *
 *     [http "<origin>/"]
 *         extraHeader =
 *         extraHeader = Authorization: Bearer <token>
 *         followRedirects = false
 *
 * The same header works for an install with no proxy: its git endpoint accepts
 * a Bearer token as well as Basic.
 *
 * THE TOKEN'S REACH, and what holds each part of it:
 *   - only that exact origin: `http.<url>.*` matches scheme, host and port
 *     exactly (no wildcard is ever written), so no other host gets it;
 *   - never across a redirect: `followRedirects = false` for that origin, so a
 *     redirect is an error instead of a request to wherever it pointed;
 *   - one header, never two: the empty `extraHeader =` resets anything the
 *     user-level config set before it, and the per-clone header files older
 *     logins wrote (read AFTER this, from each clone's own config) are deleted
 *     when the machine logs in;
 *   - never in any repository's `.git/config` and never in the user's
 *     `.gitconfig` itself (often world-readable, often pasted into bug
 *     reports) — those hold only the include's PATH. The file is 0600 in a
 *     0700 directory under lazy's per-user directory;
 *   - `lazy logout` removes the include entry and the file.
 *
 * Bound clones from before machine-level login carried the same header through
 * a clone-LOCAL include; {@link removeCloneGitBearer} retires it.
 */

import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { getDaemonBaseDir, getDaemonDir } from '../daemon/paths';
import { getHome } from '../utils/home';
import { runGit } from '../utils/git';
import { jwtIssuerOrigin } from './token-origin';

/**
 * A token is written into a git config file, so it must not be able to break
 * out of the value it sits in: no whitespace, quotes, backslashes, `;`/`#`
 * (comments) or brackets. Every token an install issues — `lz_…` API tokens
 * and three-part base64url JWTs — fits this; anything else is refused rather
 * than escaped, since it is not something an install would send.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]+$/;

export function assertGitSafeToken(token: string): void {
  if (!TOKEN_SHAPE.test(token)) {
    throw new Error(
      'The install returned a token with characters no Lazy Teams token contains, so it was ' +
      'not written into your git config. Check that the address is really your Teams install.',
    );
  }
}

/** The origin a Teams URL names — scheme, host and port, nothing else. */
export function gitAuthOrigin(teamsUrl: string): string {
  return new URL(teamsUrl).origin;
}

export function renderGitAuthInclude(teamsUrl: string, token: string): string {
  assertGitSafeToken(token);
  const origin = gitAuthOrigin(teamsUrl);
  return (
    `# Written by \`lazy login\`; removed by \`lazy logout\`. Do not share this file.\n` +
    `[http "${origin}/"]\n` +
    `\textraHeader =\n` +
    `\textraHeader = Authorization: Bearer ${token}\n` +
    `\tfollowRedirects = false\n`
  );
}

/** Where the per-install include files live: 0700, under lazy's per-user dir. */
export function machineGitAuthDir(): string {
  return join(getDaemonBaseDir(), 'teams-git');
}

/**
 * One file per install ORIGIN — `https_teams.example.com.inc`, `http_host_3000.inc`.
 * The scheme is part of the name because a login is only ever used on the
 * scheme it was issued on: an http login to a host must not overwrite (or be
 * mistaken for) the https one's file.
 */
export function machineGitIncludePath(teamsUrl: string): string {
  const url = new URL(teamsUrl);
  const host = url.host.replace(/[^A-Za-z0-9.-]/g, '_');
  return join(machineGitAuthDir(), `${url.protocol.replace(':', '')}_${host}.inc`);
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The file a login from before origin-keyed files wrote (`host.inc`), if it
 * belongs to this origin. It was written beside the host-keyed MACHINE
 * credential, which now stands for https — so for an https origin it is this
 * origin's file whatever scheme its section names (an older `lazy clone
 * http://…` rewrote it to http, carrying the https token). For an http origin
 * it is this origin's file only when its section says http.
 */
async function legacyIncludeFor(teamsUrl: string): Promise<string | null> {
  const host = new URL(teamsUrl).host.replace(/[^A-Za-z0-9.-]/g, '_');
  const file = join(machineGitAuthDir(), `${host}.inc`);
  const text = await readIfExists(file);
  if (text === null) return null;
  if (new URL(teamsUrl).protocol === 'https:') return file;
  return text.includes(`[http "${gitAuthOrigin(teamsUrl)}/"]`) ? file : null;
}

/**
 * The scheme a pre-origin-keyed (host-only) login was used on, read off the
 * legacy include (`host.inc`) that login wrote: `http` or `https` by its
 * section, or null when there is no such include. A JWT names its issuer, and
 * that wins over the section — an older `lazy clone http://…` rewrote an
 * https login's include to http.
 */
export async function legacyLoginScheme(host: string): Promise<'http' | 'https' | null> {
  const file = join(machineGitAuthDir(), `${host.replace(/[^A-Za-z0-9.-]/g, '_')}.inc`);
  const text = await readIfExists(file);
  if (text === null) return null;
  const token = /Authorization: Bearer (\S+)/.exec(text)?.[1];
  const issuer = token ? jwtIssuerOrigin(token) : null;
  const origin = issuer ?? /\[http "(https?:\/\/[^"]+?)\/"\]/.exec(text)?.[1];
  if (!origin) return null;
  return origin.startsWith('http:') ? 'http' : 'https';
}

/**
 * Retire every machine git include whose token was ISSUED by a different
 * origin than the one the include sends it to — the plaintext leak an older
 * `lazy clone http://…` left by reusing an https login. A JWT says who issued
 * it. A plain token cannot, so an http include carrying one is retired only
 * when `httpsTokenFor` shows it IS the token this machine holds for the same
 * host over https — the leak, provably; otherwise it is a genuine http login
 * and stays. Returns the origins it stopped sending to.
 */
export async function retireMisissuedGitIncludes(
  httpsTokenFor: (httpsOrigin: string) => Promise<string | null> = async () => null,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(machineGitAuthDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const retired: string[] = [];
  for (const entry of entries.filter((e) => e.endsWith('.inc'))) {
    const file = join(machineGitAuthDir(), entry);
    const text = await readIfExists(file);
    if (text === null) continue;
    const section = /\[http "(https?:\/\/[^"]+?)\/"\]/.exec(text)?.[1];
    const token = /Authorization: Bearer (\S+)/.exec(text)?.[1];
    if (!section || !token) continue;
    const issuer = jwtIssuerOrigin(token);
    if (issuer) {
      if (issuer === section) continue;
    } else {
      if (!section.startsWith('http:')) continue;
      const httpsToken = await httpsTokenFor(`https://${new URL(section).host}`);
      if (httpsToken !== token) continue;
    }
    await removeInclude(file);
    retired.push(section);
  }
  return retired;
}

/** Does git to this exact origin carry this machine's login (in either file layout)? */
export async function machineGitConfigured(teamsUrl: string): Promise<boolean> {
  const exists = await stat(machineGitIncludePath(teamsUrl)).then(() => true, () => false);
  return exists || (await legacyIncludeFor(teamsUrl)) !== null;
}

/**
 * User-level git config commands run from HOME, never from inside some repo,
 * with the CURRENT environment (`env` makes runGit read process.env at call
 * time), so `GIT_CONFIG_GLOBAL` decides which file is the user-level one.
 */
const userGitOpts = () => ({ cwd: getHome(), env: {} });

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which file `git config --global` reads — `GIT_CONFIG_GLOBAL`, `~/.gitconfig`
 * or `$XDG_CONFIG_HOME/git/config` — as git itself reports it, so login can
 * name the file it changed.
 */
async function globalConfigFileHolding(includeFile: string): Promise<string | null> {
  const listed = await runGit(
    ['config', '--global', '--show-origin', '--get-all', 'include.path', `^${escapeRegex(includeFile)}$`],
    userGitOpts(),
  );
  if (listed.exitCode !== 0) return null;
  const first = listed.stdout.split('\n')[0] ?? '';
  const origin = first.split('\t')[0] ?? '';
  return origin.startsWith('file:') ? origin.slice('file:'.length) : null;
}

export interface MachineGitConfigured {
  /** The user-level git config file that now includes {@link includeFile}. */
  globalConfigFile: string;
  includeFile: string;
  /** False when the include entry was already there (a repeat login). */
  addedInclude: boolean;
  /** Older per-clone header files for this origin that were deleted. */
  retiredCloneHeaders: number;
}

/**
 * Make git to this install carry `token`, machine-wide.
 *
 * SAVE FIRST: the 0600 file is written before the user-level config points at
 * it, so the config never names a file that does not exist.
 */
export async function configureMachineGitAuth(teamsUrl: string, token: string): Promise<MachineGitConfigured> {
  const content = renderGitAuthInclude(teamsUrl, token);
  const dir = machineGitAuthDir();
  const file = machineGitIncludePath(teamsUrl);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  // A fresh 0600 temp file in the same 0700 dir, renamed over the old one: the
  // token is never in a file that is (even briefly) readable by anyone else,
  // and git never sees a half-written include.
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true });
    throw new Error(`could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let addedInclude = false;
  if (!(await globalConfigFileHolding(file))) {
    const added = await runGit(['config', '--global', '--add', 'include.path', file], userGitOpts());
    if (added.exitCode !== 0) {
      await rm(file, { force: true });
      throw new Error(`could not add an include for ${file} to your user-level git config: ${added.stderr}`);
    }
    addedInclude = true;
  }
  const globalConfigFile = await globalConfigFileHolding(file);
  if (!globalConfigFile) {
    throw new Error(`your user-level git config does not show the include for ${file} after adding it`);
  }
  // The pre-origin-keyed file for this origin, if any: one header, never two.
  const legacy = await legacyIncludeFor(teamsUrl);
  if (legacy) await removeInclude(legacy);
  const retiredCloneHeaders = await retireCloneGitBearers(teamsUrl);
  return { globalConfigFile, includeFile: file, addedInclude, retiredCloneHeaders };
}

/**
 * Delete every clone-LOCAL Bearer include file an earlier login wrote for this
 * origin. Git reads a clone's own config AFTER the user-level one and appends
 * its `extraHeader`, so a leftover would make every such clone send two
 * Authorization headers — which the install refuses (and counts as a failed
 * sign-in). Git ignores an `include.path` whose file is missing, so deleting
 * the file is enough, and it also takes an old token off the disk.
 */
async function retireCloneGitBearers(teamsUrl: string): Promise<number> {
  const section = `[http "${gitAuthOrigin(teamsUrl)}/"]`;
  let entries: string[];
  try {
    entries = await readdir(getDaemonBaseDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let retired = 0;
  for (const entry of entries) {
    const legacy = join(getDaemonBaseDir(), entry, 'teams-git-auth.inc');
    let text: string;
    try {
      text = await readFile(legacy, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw err;
    }
    if (!text.includes(section)) continue;
    await rm(legacy, { force: true });
    retired++;
  }
  return retired;
}

/**
 * Undo {@link configureMachineGitAuth}: the include entry, then the file.
 * Returns the config file the entry was removed from, or null if there was none.
 */
export async function removeMachineGitAuth(teamsUrl: string): Promise<string | null> {
  const current = await removeInclude(machineGitIncludePath(teamsUrl));
  const legacy = await legacyIncludeFor(teamsUrl);
  const legacyConfig = legacy ? await removeInclude(legacy) : null;
  return current ?? legacyConfig;
}

async function removeInclude(file: string): Promise<string | null> {
  const globalConfigFile = await globalConfigFileHolding(file);
  if (globalConfigFile) {
    const unset = await runGit(
      ['config', '--global', '--unset-all', 'include.path', `^${escapeRegex(file)}$`],
      userGitOpts(),
    );
    // Exit 5 is "nothing matched".
    if (unset.exitCode !== 0 && unset.exitCode !== 5) {
      throw new Error(`could not remove the include for ${file} from ${globalConfigFile}: ${unset.stderr}`);
    }
  }
  await rm(file, { force: true });
  return globalConfigFile;
}

/** The clone-LOCAL include an earlier proxy login wrote (pre machine-level login). */
export function cloneGitAuthIncludePath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'teams-git-auth.inc');
}

/**
 * Retire a clone-local Bearer include, if this clone has one. Git auth is
 * machine-level now, and a clone-local header left in place would be sent
 * alongside it.
 */
export async function removeCloneGitBearer(projectRoot: string): Promise<void> {
  const file = cloneGitAuthIncludePath(projectRoot);
  const unset = await runGit(
    ['config', '--local', '--unset-all', 'include.path', `^${escapeRegex(file)}$`],
    projectRoot,
  );
  if (unset.exitCode !== 0 && unset.exitCode !== 5) {
    throw new Error(`could not remove the git auth include from this clone's config: ${unset.stderr}`);
  }
  await rm(file, { force: true });
}
