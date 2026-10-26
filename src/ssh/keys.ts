/**
 * SSH key material for `lazy shell <task> --ssh-config` / `--stdio`
 * (docs/design/task-sessions-and-ssh.md §5).
 *
 * Two kinds of key, both Ed25519 and both made here with `node:crypto` rather
 * than `ssh-keygen`, so neither the daemon's host nor the person's machine
 * needs OpenSSH's tools to make one:
 *
 *   - the HOST key an `sshd -i` inside a task's environment presents. One per
 *     (member, task) in Lazy Teams and one per task solo, held daemon-side and
 *     handed to every container incarnation, so a container removed at its
 *     idle limit and made again still answers with the key a saved config
 *     pinned (no trust-on-first-use, no "host key changed" after a recreate);
 *   - the person's own CLIENT key (`~/.lazy/ssh/id_ed25519`), made once per
 *     machine by `--ssh-config --install`.
 *
 * And the parser for what a person may hand the daemon as authorized keys:
 * plain public keys only, never `authorized_keys` options — an option such as
 * `command=` or `permitopen=` is a decision lazy makes, not a key line's.
 */

import { createHash, generateKeyPairSync, randomBytes } from 'crypto';

/** An Ed25519 keypair in OpenSSH's own file formats. */
export interface OpenSshKeyPair {
  /** `-----BEGIN OPENSSH PRIVATE KEY-----` …, unencrypted, as `ssh-keygen` writes it. */
  privateKey: string;
  /** `ssh-ed25519 AAAA… <comment>` — one authorized_keys / known_hosts line. */
  publicKey: string;
}

function sshString(data: Buffer | string): Buffer {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/** The public key blob (`string "ssh-ed25519" || string pub32`). */
function ed25519PublicBlob(pub: Buffer): Buffer {
  return Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
}

/**
 * Serialize an Ed25519 key as OpenSSH's `openssh-key-v1` private key file,
 * unencrypted (cipher and KDF `none`) — the format `ssh-keygen -t ed25519 -N ''`
 * writes and `sshd -h` / `ssh -i` read.
 */
export function encodeOpenSshEd25519PrivateKey(seed: Buffer, pub: Buffer, comment: string): string {
  if (seed.length !== 32 || pub.length !== 32) throw new Error('an Ed25519 key is a 32-byte seed and a 32-byte public key');
  const check = randomBytes(4).readUInt32BE(0);
  let priv = Buffer.concat([
    uint32(check),
    uint32(check),
    sshString('ssh-ed25519'),
    sshString(pub),
    // OpenSSH stores the 64-byte "private key" as seed || public key.
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  // Padded to the cipher block size (8 for `none`) with 1, 2, 3, …
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    uint32(1),
    sshString(ed25519PublicBlob(pub)),
    sshString(priv),
  ]);
  const b64 = body.toString('base64');
  const lines = b64.match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** A fresh Ed25519 keypair in OpenSSH formats. `comment` lands on both halves. */
export function generateEd25519KeyPair(comment: string): OpenSshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  if (!pubJwk.x || !privJwk.d) throw new Error('the runtime could not export an Ed25519 key');
  const pub = Buffer.from(pubJwk.x, 'base64url');
  const seed = Buffer.from(privJwk.d, 'base64url');
  const safeComment = comment.replace(/[\r\n]/g, ' ').trim();
  return {
    privateKey: encodeOpenSshEd25519PrivateKey(seed, pub, safeComment),
    publicKey: `ssh-ed25519 ${ed25519PublicBlob(pub).toString('base64')}${safeComment ? ` ${safeComment}` : ''}`,
  };
}

/** Key types a person may authorize. DSA and anything unknown are refused. */
export const AUTHORIZED_KEY_TYPES = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
  'ssh-rsa',
]);

/** At most this many keys reach one connection's `authorized_keys`. */
export const MAX_AUTHORIZED_KEYS = 50;

export interface ParsedPublicKey {
  type: string;
  /** The base64 blob, exactly as given. */
  blob: string;
  /** `SHA256:<base64, no padding>` — what `ssh-keygen -lf` and sshd's log print. */
  fingerprint: string;
  /** `<type> <blob>`, no comment and no options: the line lazy writes. */
  line: string;
}

/** `SHA256:` fingerprint of a key blob, as OpenSSH prints it. */
export function sshFingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Parse ONE public key line (`<type> <base64> [comment]`). Returns null for
 * anything else — options, a private key, a type outside
 * {@link AUTHORIZED_KEY_TYPES}, a blob whose embedded type disagrees.
 */
export function parsePublicKeyLine(raw: string): ParsedPublicKey | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [type, blob] = parts as [string, string];
  if (!AUTHORIZED_KEY_TYPES.has(type)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
  const bytes = Buffer.from(blob, 'base64');
  if (bytes.length < 8 || bytes.toString('base64').replace(/=+$/, '') !== blob.replace(/=+$/, '')) return null;
  const typeLen = bytes.readUInt32BE(0);
  if (typeLen + 4 > bytes.length) return null;
  if (bytes.subarray(4, 4 + typeLen).toString('utf8') !== type) return null;
  return { type, blob, fingerprint: sshFingerprint(bytes), line: `${type} ${blob}` };
}

/**
 * Parse an authorized-keys text (one key per line, blank lines and `#`
 * comments allowed). EVERY other line must be a plain key: one malformed or
 * option-carrying line refuses the whole set, because silently dropping a line
 * would leave a person locked out with no reason they can read.
 */
export function parseAuthorizedKeys(text: string): { ok: true; keys: ParsedPublicKey[] } | { ok: false; error: string } {
  const keys: ParsedPublicKey[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;
    const parsed = parsePublicKeyLine(line);
    if (!parsed) return { ok: false, error: `authorized key line ${i + 1} is not a plain OpenSSH public key` };
    if (seen.has(parsed.fingerprint)) continue;
    seen.add(parsed.fingerprint);
    keys.push(parsed);
    if (keys.length > MAX_AUTHORIZED_KEYS) return { ok: false, error: `more than ${MAX_AUTHORIZED_KEYS} authorized keys` };
  }
  return { ok: true, keys };
}

/** The login name every SSH config lazy writes uses (an alias of the container's user). */
export const SSH_LOGIN_USER = 'lazy';
