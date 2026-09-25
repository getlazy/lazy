/**
 * Where a stored credential's SECRET actually lives.
 *
 * Three backends behind one interface. Which one is used is a per-host fact
 * (does this machine have an OS secret service at all?) crossed with an explicit
 * `[credentials] backend` opt-out, and it is always REPORTED — `lazy auth list`
 * and `lazy doctor` name the backend rather than leaving a user to guess how
 * well their token is protected.
 *
 * SECRETS NEVER GO IN ARGV. `ps` shows every argument of every process to every
 * user on the machine, and a shell records them in history — the same reason
 * `lazy system agent set-key` has no argv form. So both write paths feed the
 * secret over the child's STDIN:
 *   - libsecret: `secret-tool store` reads the secret from stdin by design.
 *   - keychain:  `security -i` reads its COMMAND LINES from stdin, so the
 *     `add-generic-password … -w <secret>` line never appears in this process's
 *     argv — only inside the pipe.
 * Reads are the easy direction: the secret comes back on stdout.
 *
 * The two OS backends take an injectable command runner. Their whole substance
 * is argv construction and output parsing, and neither `security` nor
 * `secret-tool` exists on the Linux container lazy is developed in — with the
 * seam that logic is unit-testable anywhere, without it it is testable on
 * exactly one developer's laptop.
 */

import { mkdir, readFile, writeFile, chmod } from 'fs/promises';
import { dirname } from 'path';
import { getCredentialsPath, projectSlug } from '../daemon/paths';
import { spawn } from '../utils/spawn';
import type { CredentialName } from './providers';

/** The backends a credential secret can live in. */
export type BackendId = 'keychain' | 'libsecret' | 'file';

/** Probe order for `backend = "auto"`: OS storage first, file last. */
export const BACKEND_IDS: readonly BackendId[] = ['keychain', 'libsecret', 'file'] as const;

/** What `[credentials] backend` accepts. */
export type BackendSelection = BackendId | 'auto';

export const BACKEND_SELECTIONS: readonly BackendSelection[] = ['auto', ...BACKEND_IDS] as const;

export function isBackendSelection(value: string): value is BackendSelection {
  return (BACKEND_SELECTIONS as readonly string[]).includes(value);
}

/** One line describing the protection a backend actually provides. */
export const BACKEND_DESCRIPTIONS: Record<BackendId, string> = {
  keychain: 'macOS Keychain (encrypted at rest by the OS)',
  libsecret: 'libsecret / Secret Service (encrypted at rest by the OS)',
  file: 'file, mode 0600, outside the repo (not encrypted at rest)',
};

export interface CredentialBackend {
  readonly id: BackendId;
  /** Is this backend usable on this host right now? Never throws. */
  available(): Promise<boolean>;
  get(projectRoot: string, provider: CredentialName): Promise<string | null>;
  set(projectRoot: string, provider: CredentialName, secret: string): Promise<void>;
  /** Returns true when something was actually removed. */
  remove(projectRoot: string, provider: CredentialName): Promise<boolean>;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a helper binary, optionally feeding it `stdin`. The injectable seam. */
export type CommandRunner = (cmd: string[], stdin?: string) => Promise<RunResult>;

/**
 * The real runner.
 *
 * `stdin` is written and its pipe closed before output is drained, so a child
 * that waits for EOF (both of ours do) cannot deadlock against us waiting for
 * its output. A missing binary throws out of `spawn()` as an actionable error;
 * callers that are probing catch it.
 */
export const spawnCommandRunner: CommandRunner = async (cmd, stdin) => {
  const proc = spawn(cmd, {
    stdin: stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });

  if (stdin !== undefined) {
    const sink = proc.stdin as unknown as { write(chunk: string): unknown; end(): unknown };
    sink.write(stdin);
    sink.end();
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  const exitCode = (await proc.exited) ?? -1;
  return { exitCode, stdout, stderr };
};

/**
 * Escape a value for a double-quoted argument on a `security -i` command line.
 *
 * Quoting cannot contain a NEWLINE: `security -i` reads one command per line, so
 * a line break inside the value ends lazy's command and starts a new one. There
 * is no escape for that, hence the throw — the caller (`setCredential`) already
 * rejects such a value, and this is the second lock on the same door, next to
 * the thing that would actually be exploited.
 */
export function quoteForSecurity(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error('Refusing to pass a value containing a line break to `security`.');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Keychain item service name — per project. */
export function keychainService(projectRoot: string): string {
  return `lazy:${projectSlug(projectRoot)}`;
}

/**
 * Bytes `security -i` reads into ONE command line — and the reason a long
 * secret has to be stored in pieces.
 *
 * SecurityTool's own `readline()` fills a caller-supplied buffer and, on
 * reaching `buffer_size - 1`, simply BREAKS without consuming the rest of the
 * line; `security.c` passes a 4096-byte buffer. So a longer line is not
 * rejected, it is SPLIT: the first 4095 bytes run as one command, and the
 * remainder runs as the next one. That is not a hypothetical — a ChatGPT
 * subscription session is two JWTs and lands either side of the limit depending
 * on how long the credential's name is, which is how `lazy auth import codex`
 * stored fine while `lazy auth import chatgpt`, two bytes longer, stored a
 * TRUNCATED secret and then failed with `security: unknown command "}"` — the
 * tail of the JSON being read as a command of its own.
 *
 * Fixed in the only place it can be: the secret is split so every line stays
 * under the limit. It is NOT fixed by putting the secret in argv, which is the
 * one thing this module must never do (see the header).
 */
export const SECURITY_LINE_LIMIT = 4096;

/** Most keychain items one credential may occupy. A guard, never reached. */
const MAX_KEYCHAIN_PARTS = 64;

/**
 * Account name of one part of a credential: the plain name for the first, then
 * `<name>#2`, `<name>#3`, … A single-part secret is therefore stored exactly as
 * it always was, so every credential written before this existed still reads.
 */
export function keychainPartAccount(provider: CredentialName, part: number): string {
  return part === 1 ? provider : `${provider}#${part}`;
}

/** Bytes a quoted value costs on a `security -i` line, without the quotes. */
function quotedByteLength(value: string): number {
  return Buffer.byteLength(value) + (value.match(/["\\]/g)?.length ?? 0);
}

/**
 * Split a secret so each piece fits in `budget` bytes once quoted.
 *
 * Greedy and character-wise rather than a fixed byte stride: quoting escapes
 * `"` and `\`, so how much of a secret fits is a property of the secret. A
 * piece is never cut inside a UTF-16 surrogate pair.
 */
export function splitForSecurityLine(secret: string, budget: number): string[] {
  if (budget < 16) {
    // Only reachable if the service or account name ate the whole line, which
    // would mean an absurd project path. Say so rather than loop forever.
    throw new Error(
      `Cannot store a credential in the macOS Keychain: the \`security\` command line leaves only ` +
      `${budget} bytes for the secret. The project path is too long for the keychain item name.`,
    );
  }
  const parts: string[] = [];
  let current = '';
  let used = 0;
  for (const ch of secret) {
    const cost = quotedByteLength(ch);
    if (used + cost > budget) {
      parts.push(current);
      current = '';
      used = 0;
    }
    current += ch;
    used += cost;
  }
  if (current || parts.length === 0) parts.push(current);
  return parts;
}

/** libsecret lookup attributes — per project, per provider. */
export function libsecretAttributes(projectRoot: string, provider: CredentialName): string[] {
  return ['application', 'lazy', 'project', projectSlug(projectRoot), 'provider', provider];
}

/**
 * macOS Keychain, via `/usr/bin/security` generic passwords.
 *
 * Items are keyed service=`lazy:<project-slug>`, account=`<provider>` — per
 * project and per provider, which is the ask. `-U` updates an existing item in
 * place rather than accumulating duplicates that `find` would then resolve
 * arbitrarily.
 *
 * `-A` (any application may read this item without a prompt) is deliberate, and
 * is the honest trade. The reader is the lazy DAEMON, frequently started
 * detached by an auto-start with no terminal and no GUI session to answer an
 * unlock prompt — an item that prompts would hang daemon startup rather than
 * protect anything. What `-A` gives up is protection from OTHER processes
 * running as the same user, which is exactly what a 0600 file also lacks and is
 * not the threat here. What it keeps is encryption at rest and a secret that is
 * in no file lazy writes.
 */
export class KeychainBackend implements CredentialBackend {
  readonly id = 'keychain' as const;

  constructor(
    private readonly run: CommandRunner = spawnCommandRunner,
    private readonly platform: string = process.platform,
  ) {}

  /** The `add-generic-password` line for one part, secret included. */
  private addLine(projectRoot: string, account: string, secret: string): string {
    return (
      'add-generic-password -U -A ' +
      `-s ${quoteForSecurity(keychainService(projectRoot))} ` +
      `-a ${quoteForSecurity(account)} ` +
      `-D ${quoteForSecurity('lazy credential')} ` +
      `-w ${quoteForSecurity(secret)}\n`
    );
  }

  /**
   * Bytes left for one part's secret once the command itself is on the line.
   *
   * Measured from the real line with the LONGEST account name any part could
   * take, so every part shares one budget and `get` can reason about fullness
   * without being told how many parts there are.
   */
  private budget(projectRoot: string, provider: CredentialName): number {
    const widest = keychainPartAccount(provider, MAX_KEYCHAIN_PARTS);
    // -1: readline breaks at buffer_size - 1, so 4095 bytes is the most that
    // reaches one command. -16: headroom, so a future flag on this line cannot
    // silently re-open the same bug.
    return SECURITY_LINE_LIMIT - 1 - 16 - Buffer.byteLength(this.addLine(projectRoot, widest, ''));
  }

  /**
   * Byte length at or above which a part may have a successor.
   *
   * Quoting at most DOUBLES a value's byte length, so a part that was filled to
   * the budget holds at least half of it — anything shorter than that was the
   * last one, and probing for a next part would be a wasted subprocess on every
   * single-part credential (which is all of them but the ChatGPT session).
   */
  private probeThreshold(budget: number): number {
    return Math.floor((budget - 8) / 2);
  }

  async available(): Promise<boolean> {
    if (this.platform !== 'darwin') return false;
    try {
      // Exit code is irrelevant — `security help` exits non-zero on some
      // releases. What matters is that the binary was found and ran at all;
      // a missing one throws out of the spawn wrapper.
      await this.run(['security', 'help']);
      return true;
    } catch {
      return false;
    }
  }

  /** One part's value, or null when there is no such item. */
  private async getPart(projectRoot: string, account: string): Promise<string | null> {
    const result = await this.run([
      'security', 'find-generic-password',
      '-s', keychainService(projectRoot),
      '-a', account,
      '-w',
    ]);
    if (result.exitCode !== 0) return null;
    // `-w` prints the raw password followed by a newline.
    const value = result.stdout.replace(/\n$/, '');
    return value.length > 0 ? value : null;
  }

  private async removePart(projectRoot: string, account: string): Promise<boolean> {
    const result = await this.run([
      'security', 'delete-generic-password',
      '-s', keychainService(projectRoot),
      '-a', account,
    ]);
    return result.exitCode === 0;
  }

  async get(projectRoot: string, provider: CredentialName): Promise<string | null> {
    const first = await this.getPart(projectRoot, provider);
    if (first === null) return null;

    const threshold = this.probeThreshold(this.budget(projectRoot, provider));
    let value = first;
    let last = first;
    for (let part = 2; part <= MAX_KEYCHAIN_PARTS && Buffer.byteLength(last) >= threshold; part++) {
      const next = await this.getPart(projectRoot, keychainPartAccount(provider, part));
      if (next === null) break;
      value += next;
      last = next;
    }
    return value;
  }

  async set(projectRoot: string, provider: CredentialName, secret: string): Promise<void> {
    // The secret rides in on stdin as part of an interactive command line —
    // never in this process's argv. See the module header. It is split across
    // items when one line cannot carry it — see SECURITY_LINE_LIMIT.
    const parts = splitForSecurityLine(secret, this.budget(projectRoot, provider));
    if (parts.length > MAX_KEYCHAIN_PARTS) {
      throw new Error(
        `Refusing to store a ${secret.length}-character ${provider} credential in the macOS Keychain: ` +
        `it would need ${parts.length} keychain items. Use \`[credentials] backend = "file"\` in lazy.toml.`,
      );
    }

    for (const [index, part] of parts.entries()) {
      const account = keychainPartAccount(provider, index + 1);
      // One `security -i` per part rather than one invocation carrying every
      // line: interactive mode returns only the LAST command's status, so a
      // batch would report success for a failure in any earlier line.
      const result = await this.run(['security', '-i'], this.addLine(projectRoot, account, part));
      if (result.exitCode !== 0) {
        throw new Error(
          `The macOS Keychain refused to store the ${provider} credential ` +
          `(security exited ${result.exitCode}): ${result.stderr.trim() || 'no error output'}`,
        );
      }
    }

    // Drop parts left over from a LONGER previous secret. Without this, a
    // shorter replacement would still read back with the old tail glued on.
    for (let part = parts.length + 1; part <= MAX_KEYCHAIN_PARTS; part++) {
      if (!(await this.removePart(projectRoot, keychainPartAccount(provider, part)))) break;
    }
  }

  async remove(projectRoot: string, provider: CredentialName): Promise<boolean> {
    const removed = await this.removePart(projectRoot, provider);
    for (let part = 2; part <= MAX_KEYCHAIN_PARTS; part++) {
      if (!(await this.removePart(projectRoot, keychainPartAccount(provider, part)))) break;
    }
    return removed;
  }
}

/**
 * Linux (and any freedesktop host) via libsecret's `secret-tool`.
 *
 * Attributes rather than one composite key: `application=lazy`,
 * `project=<slug>`, `provider=<name>`. That makes the items discoverable in a
 * keyring UI and lets a user clear one project's credentials without touching
 * another's.
 *
 * Availability is probed with a real LOOKUP, not with a `--version`. The common
 * headless case is `secret-tool` installed with no Secret Service running behind
 * it, where every call fails with a D-Bus error — a host that would look
 * available on a version probe and then break at daemon start.
 */
export class LibsecretBackend implements CredentialBackend {
  readonly id = 'libsecret' as const;

  constructor(
    private readonly run: CommandRunner = spawnCommandRunner,
    private readonly platform: string = process.platform,
  ) {}

  async available(): Promise<boolean> {
    if (this.platform === 'darwin' || this.platform === 'win32') return false;
    try {
      // A lookup for attributes that match nothing: exit 1 with no diagnostics
      // means "the service answered, and has no such secret" — available. A
      // D-Bus or service failure writes to stderr, which is not.
      const result = await this.run(['secret-tool', 'lookup', 'application', 'lazy-availability-probe']);
      if (result.exitCode === 0) return true;
      return result.stderr.trim().length === 0;
    } catch {
      return false;
    }
  }

  async get(projectRoot: string, provider: CredentialName): Promise<string | null> {
    const result = await this.run(['secret-tool', 'lookup', ...libsecretAttributes(projectRoot, provider)]);
    if (result.exitCode !== 0) return null;
    // secret-tool prints the secret with no trailing newline of its own; trim
    // exactly one so a value that legitimately ends in a newline round-trips.
    const value = result.stdout.replace(/\n$/, '');
    return value.length > 0 ? value : null;
  }

  async set(projectRoot: string, provider: CredentialName, secret: string): Promise<void> {
    const result = await this.run(
      [
        'secret-tool', 'store',
        '--label', `lazy ${provider} credential`,
        ...libsecretAttributes(projectRoot, provider),
      ],
      secret,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `The Secret Service refused to store the ${provider} credential ` +
        `(secret-tool exited ${result.exitCode}): ${result.stderr.trim() || 'no error output'}`,
      );
    }
  }

  async remove(projectRoot: string, provider: CredentialName): Promise<boolean> {
    const result = await this.run(['secret-tool', 'clear', ...libsecretAttributes(projectRoot, provider)]);
    return result.exitCode === 0;
  }
}

/**
 * The fallback: a 0600 JSON file in the per-project DAEMON directory.
 *
 * NOT encrypted, and said so everywhere it is reported. On a host with no OS
 * secret service there is nowhere to keep an encryption key better protected
 * than the ciphertext beside it, so encrypting here would buy obfuscation rather
 * than security while adding a new way to lose credentials permanently. What
 * this backend does provide is the posture lazy's existing credential files
 * already have, and it is not nothing: mode 0600 keeps other users out, and
 * living under `~/.lazy/daemon/<slug>/` keeps it out of the project root, which
 * every task container bind-mounts.
 */
export class FileBackend implements CredentialBackend {
  readonly id = 'file' as const;

  async available(): Promise<boolean> {
    return true;
  }

  async get(projectRoot: string, provider: CredentialName): Promise<string | null> {
    const file = await this.read(projectRoot);
    const value = file[provider];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  async set(projectRoot: string, provider: CredentialName, secret: string): Promise<void> {
    const file = await this.read(projectRoot);
    file[provider] = secret;
    await this.write(projectRoot, file);
  }

  async remove(projectRoot: string, provider: CredentialName): Promise<boolean> {
    const file = await this.read(projectRoot);
    if (!(provider in file)) return false;
    delete file[provider];
    await this.write(projectRoot, file);
    return true;
  }

  private async read(projectRoot: string): Promise<Record<string, string>> {
    const path = getCredentialsPath(projectRoot);
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(
        `Failed to read the credential store at ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('expected a JSON object of provider → secret');
      }
      return { ...(parsed as Record<string, string>) };
    } catch (err) {
      // Found-but-broken is not "no credential". Treating it as empty would
      // send the user chasing an auth problem instead of a one-line JSON fix.
      throw new Error(
        `Failed to parse the credential store at ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Fix or delete the file, then re-run \`lazy auth set <provider>\`.`,
      );
    }
  }

  private async write(projectRoot: string, file: Record<string, string>): Promise<void> {
    const path = getCredentialsPath(projectRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    // writeFile's mode applies on CREATION only — tighten an existing file too.
    await chmod(path, 0o600);
  }
}

const BACKENDS: Record<BackendId, CredentialBackend> = {
  keychain: new KeychainBackend(),
  libsecret: new LibsecretBackend(),
  file: new FileBackend(),
};

export function backendById(id: BackendId): CredentialBackend {
  return BACKENDS[id];
}

/**
 * Pick the backend for a selection.
 *
 * `auto` probes keychain → libsecret → file. An EXPLICIT selection is never
 * silently downgraded: if a user wrote `backend = "libsecret"` and no Secret
 * Service answers, that is an error they need to see, not a quiet fall back to
 * a plaintext file they did not ask for.
 */
export async function resolveBackend(
  selection: BackendSelection,
  backends: Record<BackendId, CredentialBackend> = BACKENDS,
): Promise<CredentialBackend> {
  if (selection !== 'auto') {
    const backend = backends[selection];
    if (!(await backend.available())) {
      throw new Error(
        `lazy.toml sets [credentials] backend = "${selection}", but that backend is not usable on this host.\n` +
        (selection === 'keychain'
          ? '  The macOS Keychain is only available on macOS.\n'
          : selection === 'libsecret'
            ? '  No Secret Service answered. Install libsecret-tools and make sure a keyring\n' +
              '  daemon (gnome-keyring, KWallet, keepassxc) is running for this session.\n'
            : '  The file backend should always be available — check permissions on ~/.lazy.\n') +
        '  Set backend = "auto" to let lazy choose, or "file" for a 0600 file outside the repo.',
      );
    }
    return backend;
  }

  for (const id of BACKEND_IDS) {
    if (await backends[id].available()) return backends[id];
  }
  // Unreachable: the file backend is always available. Kept explicit so a future
  // edit to BACKEND_IDS cannot silently return undefined.
  return backends.file;
}
