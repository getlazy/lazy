/**
 * One SSH connection on the daemon's attach route (`?mode=ssh`,
 * ../server/session-attach-ws.ts): the audit and the relay
 * between the socket and `sshd -i`'s exec (docs/design/task-sessions-and-ssh.md §5).
 *
 * The exec runs WITHOUT a TTY — SSH bytes on stdout, sshd's log on stderr,
 * which ../runner/docker-exec-stream.ts keeps apart. The log is read for the
 * audit (the key sshd accepted, each `-L` forward) and otherwise only reaches
 * the daemon's debug log; nothing of it ever reaches the SSH stream.
 *
 * Connections have no idle or lifetime limit. A connection is not a hold on
 * anything — it never blocks a turn, and a turn never refuses it.
 */

import type { ServerWebSocket } from 'bun';
import { parseAuthorizedKeys, type ParsedPublicKey } from './keys';
import { parseSshdLogLine, SSHD_MISSING_EXIT, SSHD_MISSING_MESSAGE } from './sshd-command';
import { shellServerMessage } from '../server/shell-protocol';
import { logger } from '../utils/logger';

/**
 * The header Lazy Teams' relay puts the connecting member's registered keys
 * in: strict Base64 of their authorized-keys text. Honoured on a shared daemon
 * only; solo, the daemon reads its own user's files instead.
 */
export const SSH_AUTHORIZED_KEYS_HEADER = 'x-lazy-ssh-authorized-keys';

/** Upper bound on the header's decoded size — far above 50 keys. */
const MAX_HEADER_BYTES = 64 * 1024;

export function parseAuthorizedKeysHeader(raw: string | null): { ok: true; keys: ParsedPublicKey[] } | { ok: false; error: string } {
  if (!raw) return { ok: true, keys: [] };
  if (raw.length > MAX_HEADER_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
    return { ok: false, error: 'The SSH keys sent with this connection are not valid.' };
  }
  const parsed = parseAuthorizedKeys(Buffer.from(raw, 'base64').toString('utf8'));
  return parsed.ok ? parsed : { ok: false, error: `The SSH keys sent with this connection are not valid: ${parsed.error}.` };
}

/** What a socket in `?mode=ssh` carries (on `ShellSocketData.ssh`). */
export interface SshConnectionData {
  /** Who connected and to which task, for the daemon's own log line. */
  who: string;
  task: string;
  /** Filled in while it runs. */
  startedAt?: number;
  keyFingerprint?: string;
  forwards?: string[];
  stderrTail?: string;
  sshdMissing?: boolean;
  /** Input received before sshd's exec was started, in order. */
  early?: Uint8Array[];
  earlyBytes?: number;
  /** Set once the exec has started and {@link early} was flushed. */
  started?: boolean;
}

/** More input than this before sshd starts is not an SSH client's. */
const MAX_EARLY_INPUT = 1024 * 1024;

/** Client bytes → sshd, held until its exec has started. */
export function queueOrWriteSshInput(
  ws: Sock,
  conn: SshConnectionData,
  exec: { write(data: Uint8Array): void } | null,
  bytes: Uint8Array,
): void {
  if (conn.started && exec) {
    exec.write(bytes);
    return;
  }
  conn.earlyBytes = (conn.earlyBytes ?? 0) + bytes.length;
  if (conn.earlyBytes > MAX_EARLY_INPUT) {
    try { ws.close(1009, 'too much input before the connection opened'); } catch (err) { void err; }
    return;
  }
  (conn.early ??= []).push(bytes);
}

/** The exec is up: send what arrived meanwhile, then pass input straight through. */
export function flushSshInput(conn: SshConnectionData, exec: { write(data: Uint8Array): void }): void {
  for (const b of conn.early ?? []) exec.write(b);
  conn.early = [];
  conn.started = true;
}

/** A forward list kept bounded, whatever a client asks for. */
const MAX_AUDITED_FORWARDS = 50;

type Sock = Pick<ServerWebSocket<unknown>, 'send' | 'sendBinary' | 'close'>;

/** Start the connection's audit record. Connections never expire with age. */
export function startSshConnection(conn: SshConnectionData): void {
  conn.startedAt = Date.now();
  conn.forwards = [];
}

/** sshd's stdout → the socket. */
export function relaySshOutput(ws: Sock, bytes: Uint8Array): void {
  try {
    // 0 means Bun dropped the frame (backpressure limit): a hole in an SSH
    // stream is a corrupted connection, so it ends rather than carries on.
    if (ws.sendBinary(bytes) === 0) ws.close(1011, 'ssh output backlog');
  } catch (err) {
    logger.debug(`ssh output relay failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** sshd's stderr: parse the audit lines, keep a short tail for a failure, drop the rest. */
export function relaySshLog(ws: Sock, conn: SshConnectionData, bytes: Uint8Array): void {
  const text = (conn.stderrTail ?? '') + new TextDecoder().decode(bytes);
  const lines = text.split('\n');
  conn.stderrTail = lines.pop()!.slice(-4096);
  for (const line of lines) {
    const ev = parseSshdLogLine(line);
    if (!ev) continue;
    // AUDIT ONLY. These lines are read off sshd's log INSIDE the person's
    // environment, which they control (root by design), so the key and the
    // forwards are what the environment REPORTS and decide nothing: revoking
    // a key is enforced by Lazy Teams from the keys it sent. The first key
    // report is kept so the row has one stable answer, and a forward before
    // any key is dropped as noise (no channel opens before authentication).
    if (ev.event === 'key') {
      if (conn.keyFingerprint) continue;
      conn.keyFingerprint = ev.fingerprint;
      sendAudit(ws, { type: 'ssh-audit', event: 'key', keyType: ev.keyType, fingerprint: ev.fingerprint });
    } else if (ev.event === 'forward') {
      if (!conn.keyFingerprint) continue;
      if ((conn.forwards ??= []).length < MAX_AUDITED_FORWARDS) conn.forwards.push(`${ev.host}:${ev.port}`);
      sendAudit(ws, { type: 'ssh-audit', event: 'forward', host: ev.host, port: ev.port });
    } else if (ev.event === 'sshd-missing') {
      conn.sshdMissing = true;
    } else if (ev.event === 'login-alias-failed') {
      logger.warn(`ssh into task ${conn.task}: could not add the login name "lazy" for user ${ev.user}; that environment accepts only "${ev.user}"`);
    }
  }
}

function sendAudit(ws: Sock, msg: Parameters<typeof shellServerMessage>[0]): void {
  try {
    ws.send(shellServerMessage(msg));
  } catch (err) {
    logger.debug(`ssh audit frame failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The exec ended: say why when it is lazy's to say, then close. */
export function finishSsh(ws: Sock, conn: SshConnectionData, code: number | null): void {
  if (conn.sshdMissing || code === SSHD_MISSING_EXIT) {
    sendAudit(ws, { type: 'error', message: SSHD_MISSING_MESSAGE });
  }
  try {
    ws.send(shellServerMessage({ type: 'exit', code }));
    ws.close(1000, 'ssh ended');
  } catch (err) {
    logger.debug(`ssh close failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The daemon's own audit line, written once when the socket closes. */
export function logSshConnectionEnd(conn: SshConnectionData, container: string): void {
  const secs = conn.startedAt ? Math.round((Date.now() - conn.startedAt) / 1000) : 0;
  logger.info(
    `ssh connection ended: ${conn.who} → task ${conn.task} (${container}), ${secs}s, ` +
    `key ${conn.keyFingerprint ?? 'none accepted'}, forwards [${(conn.forwards ?? []).join(', ')}]`,
  );
}
