/**
 * The command an SSH connection runs inside a task's environment: `sshd -i`
 * (inetd mode) on the exec's own stdin/stdout, started fresh for every
 * connection by the daemon over the Docker API exec stream — no sshd listens
 * anywhere and nothing needs a network path to the container
 * (docs/design/task-sessions-and-ssh.md §5).
 *
 * Everything sshd needs arrives in the exec's ENVIRONMENT, never on disk ahead
 * of time: the stable host key, the authorized keys of THIS connection and the
 * per-session script. The wrapper writes them into a private temp directory
 * (mode 0700, removed when the connection ends) and unsets them before it
 * captures the container's environment for the session.
 *
 * sshd runs as the container's own user (non-root sshd: it can only log in as
 * the user it runs as), so the login name `lazy` that every config lazy writes
 * uses is added as an ALIAS of that user (same uid, home and shell) when the
 * image does not have one — through `sudo -n` when /etc/passwd is root's. A
 * container that runs as root gets the privilege-separation dir sshd wants.
 *
 * sshd's log (stderr, demultiplexed by the daemon) is AUDIT ONLY: it is written
 * inside the person's own environment, where they have root by design, so the
 * key and forwards read from it are what the environment REPORTS. Nothing is
 * enforced from it — revoking a key is enforced by Lazy Teams from the keys it
 * sent, and access by the attach route.
 *
 * The bounds the design note sets are in the config, not left to defaults: key
 * authentication only, no agent forwarding, no X11, no tunnel devices, no
 * Unix-socket forwarding, and TCP forwarding LOCAL only (`-L`; never `-R`).
 * `~/.ssh/rc` and `~/.ssh/environment` are ignored.
 *
 * The session script (`ForceCommand`) puts each kind of channel where it
 * belongs: an interactive login with a terminal lands in the person's tmux
 * `shell` session, exactly where the web Shell lands (../terminal/shell-session.ts),
 * while commands (`ssh host cmd`, VS Code's and JetBrains' remote agents) and
 * SFTP run directly — a remote editor must never be wrapped in tmux. Every one
 * starts in the task's worktree with the container's environment, the same
 * environment a web terminal's exec gets.
 */

import { shellSessionCommand } from '../terminal/shell-session';
import { SSH_LOGIN_USER } from './keys';
import { FORWARD_ENV, SERVICE_FORWARD_ADDR } from './forward-constants';

/** Ends the /etc/hosts line an SSH connection writes, so the next one replaces it. */
const HOSTS_MARKER = 'lazy-ssh-services';

/** The exec's environment variable names. */
export const SSH_ENV_HOST_KEY = 'LAZY_SSH_HOST_KEY';
export const SSH_ENV_AUTHORIZED_KEYS = 'LAZY_SSH_AUTHORIZED_KEYS';
export const SSH_ENV_SESSION_SCRIPT = 'LAZY_SSH_SESSION_SCRIPT';
export const SSH_ENV_WORKDIR = 'LAZY_SSH_WORKDIR';

/** What the wrapper exits with when the image has no OpenSSH server. */
export const SSHD_MISSING_EXIT = 127;
/** The first word of every line the wrapper itself writes to stderr. */
export const WRAPPER_LOG_PREFIX = 'lazy-ssh:';

/** Quote one word for a POSIX shell. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The ForceCommand script. It finds its own directory from `$0` (the wrapper
 * writes it there), restores sshd's view of the terminal and command after
 * loading the container's environment, and dispatches.
 */
export function sshSessionScript(notice?: string | null): string {
  // An interactive login joins the member's `shell` session, with the
  // one-line "who else is here" as its argument (escaped, never in the script
  // text); commands and editors get nothing.
  const shellArgv = shellSessionCommand(undefined, notice);
  const tmuxScript = shellArgv[2]!;
  const noticeArgs = shellArgv.slice(3).map(shQuote).join(' ');
  return [
    '#!/bin/sh',
    'd=$(dirname "$0")',
    '_term=${TERM-}; _cmd=${SSH_ORIGINAL_COMMAND-}; _shell=${SHELL:-/bin/sh}',
    '_tty=${SSH_TTY-}; _conn=${SSH_CONNECTION-}; _client=${SSH_CLIENT-}',
    // The container's environment (the member's credential, PATH, …) as the
    // web terminal's exec has it; sshd starts sessions with almost nothing.
    '[ -r "$d/env" ] && . "$d/env"',
    'export TERM="$_term" SHELL="$_shell"',
    '[ -n "$_tty" ] && export SSH_TTY="$_tty"',
    'export SSH_CONNECTION="$_conn" SSH_CLIENT="$_client"',
    'unset SSH_ORIGINAL_COMMAND',
    `cd "\${${SSH_ENV_WORKDIR}:-.}" 2>/dev/null || true`,
    'case "$_cmd" in',
    '  "")',
    '    if [ -n "$_tty" ]; then',
    `      exec sh -c ${shQuote(tmuxScript)}${noticeArgs ? ` ${noticeArgs}` : ''}`,
    '    fi',
    '    exec "$_shell" ;;',
    '  internal-sftp|*sftp-server*)',
    '    for s in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/libexec/sftp-server /usr/lib/ssh/sftp-server; do',
    '      [ -x "$s" ] && exec "$s"',
    '    done',
    `    echo "${WRAPPER_LOG_PREFIX} this environment has no sftp-server; use scp -O" >&2; exit 1 ;;`,
    '  *) exec "$_shell" -c "$_cmd" ;;',
    'esac',
    '',
  ].join('\n');
}

/**
 * argv for the exec: `sh -c <wrapper>`. The wrapper never echoes key material
 * and exits {@link SSHD_MISSING_EXIT} when there is no `sshd`.
 */
export function sshdExecCommand(): string[] {
  const script = [
    'umask 077',
    `S=; for c in /usr/sbin/sshd /usr/local/sbin/sshd /sbin/sshd; do [ -x "$c" ] && { S=$c; break; }; done`,
    `[ -n "$S" ] || { echo "${WRAPPER_LOG_PREFIX} sshd-missing" >&2; exit ${SSHD_MISSING_EXIT}; }`,
    'd=$(mktemp -d "${TMPDIR:-/tmp}/lazy-ssh.XXXXXX") || exit 1',
    'fp=',
    `trap '[ -n "$fp" ] && kill "$fp" 2>/dev/null; rm -rf "$d"' EXIT HUP INT TERM`,
    `printf %s "$${SSH_ENV_HOST_KEY}" | base64 -d > "$d/host_key" || exit 1`,
    `printf %s "$${SSH_ENV_AUTHORIZED_KEYS}" | base64 -d > "$d/authorized_keys" || exit 1`,
    `printf %s "$${SSH_ENV_SESSION_SCRIPT}" | base64 -d > "$d/session" && chmod 700 "$d/session" || exit 1`,
    `unset ${SSH_ENV_HOST_KEY} ${SSH_ENV_AUTHORIZED_KEYS} ${SSH_ENV_SESSION_SCRIPT}`,
    // A member's container: the task's services by name (./service-forward.ts).
    // The hosts line is REPLACED in place (/etc/hosts is a bind mount — never
    // renamed over) so a changed [serve] is picked up on the next connection.
    `if [ -n "\${${FORWARD_ENV.token}-}" ] && command -v lazy-agent >/dev/null 2>&1; then ` +
      `{ grep -v ' ${HOSTS_MARKER}$' /etc/hosts; printf '%s %s ${HOSTS_MARKER}\\n' ${SERVICE_FORWARD_ADDR} "$${FORWARD_ENV.hosts}"; } > "$d/hosts" 2>/dev/null; ` +
      `{ cat "$d/hosts" > /etc/hosts || sudo -n tee /etc/hosts < "$d/hosts" >/dev/null; } 2>/dev/null || echo "${WRAPPER_LOG_PREFIX} hosts-failed" >&2; ` +
      'lazy-agent service-forward </dev/null >/dev/null & fp=$!; ' +
    'fi',
    `unset ${FORWARD_ENV.url} ${FORWARD_ENV.token} ${FORWARD_ENV.ports} ${FORWARD_ENV.hosts}`,
    'export -p > "$d/env"',
    'me=$(id -un 2>/dev/null || echo root)',
    // The login alias, only when the image lacks one.
    `if [ "$me" != ${SSH_LOGIN_USER} ] && ! getent passwd ${SSH_LOGIN_USER} >/dev/null 2>&1; then ` +
      'lsh=$(getent passwd "$me" | cut -d: -f7); ' +
      `line="${SSH_LOGIN_USER}:x:$(id -u):$(id -g)::\${HOME:-/}:\${lsh:-/bin/sh}"; ` +
      '{ printf "%s\\n" "$line" >> /etc/passwd || printf "%s\\n" "$line" | sudo -n tee -a /etc/passwd >/dev/null; } 2>/dev/null || ' +
      `echo "${WRAPPER_LOG_PREFIX} login-alias-failed $me" >&2; ` +
    'fi',
    '[ "$(id -u)" = 0 ] && mkdir -p /run/sshd',
    'cat > "$d/sshd_config" <<EOF',
    'HostKey $d/host_key',
    'AuthorizedKeysFile $d/authorized_keys',
    'AuthenticationMethods publickey',
    'PubkeyAuthentication yes',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'HostbasedAuthentication no',
    'PermitEmptyPasswords no',
    'PermitRootLogin prohibit-password',
    `AllowUsers ${SSH_LOGIN_USER} $me`,
    'StrictModes no',
    'AllowAgentForwarding no',
    'AllowStreamLocalForwarding no',
    'AllowTcpForwarding local',
    'GatewayPorts no',
    'X11Forwarding no',
    'PermitTunnel no',
    'PermitUserEnvironment no',
    'PermitUserRC no',
    'PrintMotd no',
    'PrintLastLog no',
    'PidFile none',
    // DEBUG1 is what logs each forward's target; the daemon parses the
    // accepted key and the forwards for the audit and drops the rest.
    'LogLevel DEBUG1',
    'ForceCommand $d/session',
    'Subsystem sftp internal-sftp',
    'EOF',
    // Not exec'd: the shell stays to remove the directory when sshd exits.
    '"$S" -i -e -f "$d/sshd_config"',
  ].join('\n');
  return ['sh', '-c', script];
}

/** The exec's environment for one connection. */
export function sshdExecEnv(opts: {
  hostKey: string;
  authorizedKeys: string[];
  workdir: string;
  /** A member's container: forward the task's services (./service-forward.ts). */
  forward?: { url: string; token: string; ports: number[]; hosts: string[] };
  /** Who else is in the task, for an interactive login (see {@link sshSessionScript}). */
  notice?: string | null;
}): string[] {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const forward = opts.forward && opts.forward.ports.length > 0
    ? [
        `${FORWARD_ENV.url}=${opts.forward.url}`,
        `${FORWARD_ENV.token}=${opts.forward.token}`,
        `${FORWARD_ENV.ports}=${opts.forward.ports.join(',')}`,
        `${FORWARD_ENV.hosts}=${opts.forward.hosts.join(' ')}`,
      ]
    : [];
  return [
    ...forward,
    `${SSH_ENV_HOST_KEY}=${b64(opts.hostKey)}`,
    `${SSH_ENV_AUTHORIZED_KEYS}=${b64(opts.authorizedKeys.join('\n') + '\n')}`,
    `${SSH_ENV_SESSION_SCRIPT}=${b64(sshSessionScript(opts.notice))}`,
    `${SSH_ENV_WORKDIR}=${opts.workdir}`,
  ];
}

/** An audit event read off sshd's log. */
export type SshdAuditEvent =
  | { event: 'key'; keyType: string; fingerprint: string }
  | { event: 'forward'; host: string; port: number }
  | { event: 'sshd-missing' }
  | { event: 'login-alias-failed'; user: string };

/**
 * One line of the wrapper's or sshd's stderr → an audit event, or null.
 * Matches only the few lines lazy acts on; everything else is debug noise.
 */
export function parseSshdLogLine(line: string): SshdAuditEvent | null {
  const accepted = /Accepted publickey for \S+ from .* ssh2: (\S+) (SHA256:[A-Za-z0-9+/]+)/.exec(line);
  if (accepted) return { event: 'key', keyType: accepted[1]!, fingerprint: accepted[2]! };
  const fwd = /server_request_direct_tcpip: originator .* target (\S+) port (\d+)/.exec(line);
  if (fwd) return { event: 'forward', host: fwd[1]!, port: Number(fwd[2]) };
  if (line.startsWith(`${WRAPPER_LOG_PREFIX} sshd-missing`)) return { event: 'sshd-missing' };
  const alias = new RegExp(`^${WRAPPER_LOG_PREFIX} login-alias-failed (\\S+)`).exec(line);
  if (alias) return { event: 'login-alias-failed', user: alias[1]! };
  return null;
}

/** What a connection is told when its environment has no OpenSSH server. */
export const SSHD_MISSING_MESSAGE =
  "This task's environment has no OpenSSH server (sshd), so SSH cannot open in it. Lazy's own runner image ships one; " +
  'a project image of its own needs the `openssh-server` package (Debian/Ubuntu).';
