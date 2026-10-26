/**
 * The interactive shell a person gets inside a task's environment — the
 * member's own container in Lazy Teams, the task container for solo
 * `lazy shell <task>` and the dashboard's Shell — runs in a NAMED tmux session
 * (docs/design/task-sessions-and-ssh.md §1). Opening a terminal is
 * `tmux new-session -A -s shell`: the first terminal creates the session, every
 * later one (a reconnect, a reload, a second tab) attaches to the same one, so
 * what the person started is still running when they come back.
 *
 * One tmux server per container, on a fixed socket lazy owns
 * ({@link TMUX_SOCKET}), so every exec — whoever makes it — reaches the same
 * server. The directory is made on demand (directly, or through `sudo -n` when
 * the directory is root's), because the container may predate any entrypoint that
 * makes it.
 *
 * The image is the project's, so tmux may be missing: then the command falls
 * back to the plain shell lazy always opened (bash, else sh), with no session
 * to come back to. Deciding that INSIDE the container beats guessing out here.
 *
 * No `-l` on the shell: a login shell would cd to HOME, and the working
 * directory is already the worktree, which is where the person means to be.
 */

import { SESSIONS_DIR, TMUX_SOCKET } from '../sessions/tmux';

// ONE socket per container: a person's shell session and the task's `services`
// session live in the same tmux server (src/sessions/tmux.ts owns the path), so
// every listing and attach sees both.
export { TMUX_SOCKET };
const TMUX_SOCKET_DIR = SESSIONS_DIR;

/** The session a person's terminal opens unless it names another. */
export const SHELL_SESSION = 'shell';

/** What a named session may be called — safe as a tmux target and in a shell word. */
const SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The session a terminal asked for (`?session=`), or the default `shell`.
 * Null when the name is not allowed — the caller refuses it.
 */
export function parseShellSessionName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return SHELL_SESSION;
  return SESSION_NAME.test(raw) ? raw : null;
}

/** The plain shell, for an image without tmux. */
const PLAIN_SHELL = 'if command -v bash >/dev/null 2>&1; then exec bash; fi; exec sh';

/**
 * The shell script that makes the socket directory usable by the container's
 * user, succeeding only when it is.
 */
const ENSURE_SOCKET_DIR =
  `{ { mkdir -p ${TMUX_SOCKET_DIR} && chmod 700 ${TMUX_SOCKET_DIR}; } 2>/dev/null || ` +
  `{ sudo -n mkdir -p ${TMUX_SOCKET_DIR} && sudo -n chown "$(id -u):$(id -g)" ${TMUX_SOCKET_DIR}; } 2>/dev/null; } && ` +
  `[ -w ${TMUX_SOCKET_DIR} ]`;

/**
 * argv for a person's interactive terminal: attach to (or create) the named
 * session (`shell` by default), else a plain shell. Throws on a name
 * {@link parseShellSessionName} would refuse — it is interpolated into a script.
 *
 * `notice` (one line, e.g. who else is in the task) is shown in tmux's status
 * line for {@link NOTICE_MS} once attached — tmux takes over the screen, so
 * anything printed before the attach is hidden. It travels as an ARGUMENT
 * (`$1`), never in the script text, and with tmux's format character escaped
 * ({@link escapeTmuxFormat}), so nothing in it is run. Shown only by a tmux that
 * knows `display-message -d` (3.2+): on an older one an unknown flag would fail
 * the whole attach.
 */
export function shellSessionCommand(session: string = SHELL_SESSION, notice?: string | null): string[] {
  if (!SESSION_NAME.test(session)) throw new Error(`invalid shell session name: ${JSON.stringify(session)}`);
  const sh = 'if command -v bash >/dev/null 2>&1; then SH=bash; else SH=sh; fi';
  const attach = `tmux -S ${TMUX_SOCKET} new-session -A -s ${session} "$SH"`;
  const withNotice = notice
    ? `if [ -n "$1" ] && tmux -V 2>/dev/null | awk '{ split($2, v, "."); exit !((v[1] + 0) > 3 || ((v[1] + 0) == 3 && (v[2] + 0) >= 2)) }'; then ` +
      `exec ${attach} \\; display-message -d ${NOTICE_MS} "$1"; fi; `
    : '';
  return [
    'sh', '-c',
    `if command -v tmux >/dev/null 2>&1 && ${ENSURE_SOCKET_DIR}; then ` +
    `${sh}; ${withNotice}exec ${attach}; fi; ` +
    PLAIN_SHELL,
    ...(notice ? ['lazy-shell', escapeTmuxFormat(notice.replace(/[\r\n]+/g, ' '))] : []),
  ];
}

/** How long the entry notice stays in tmux's status line. */
export const NOTICE_MS = 10_000;

/** `#` starts a tmux format (`#()` runs a command); `##` is a literal `#`. */
export function escapeTmuxFormat(text: string): string {
  return text.replace(/#/g, '##');
}

/**
 * argv that prints one line per live tmux session — `<attached clients>
 * <last activity, epoch seconds> <session name>` — and nothing when there is no tmux, no
 * server or no session. Exit status is always 0 unless `docker exec` itself
 * fails, so "no sessions" and "could not ask" stay distinguishable.
 */
export function listSessionsCommand(): string[] {
  return [
    'sh', '-c',
    `command -v tmux >/dev/null 2>&1 || exit 0; ` +
    `tmux -S ${TMUX_SOCKET} list-sessions -F '#{session_attached} #{session_activity} #{session_name}' 2>/dev/null; exit 0`,
  ];
}

/** argv that ends every tmux session in the container (the whole server). */
export function killSessionsCommand(): string[] {
  return ['sh', '-c', `command -v tmux >/dev/null 2>&1 || exit 0; tmux -S ${TMUX_SOCKET} kill-server 2>/dev/null; exit 0`];
}

export interface SessionActivity {
  /** How many sessions are alive. */
  sessions: number;
  /** Whether any of them has a client attached right now. */
  attached: boolean;
  /** The most recent activity across them, epoch ms; null with no sessions. */
  lastActivityMs: number | null;
  /** Each session by name — names and states only, never what runs in it. */
  named?: NamedSessionActivity[];
}

export interface NamedSessionActivity {
  name: string;
  /** Clients attached right now. */
  attachedClients: number;
  /** Last activity, epoch ms. */
  lastActivityMs: number;
}

/** A name the presence list repeats: what tmux sessions are usually called, nothing stranger. */
const SESSION_NAME_IN_LIST = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Parse {@link listSessionsCommand}'s output. Malformed lines are skipped. */
export function parseSessionActivity(output: string): SessionActivity {
  let sessions = 0;
  let attached = false;
  let last: number | null = null;
  const named: NamedSessionActivity[] = [];
  for (const line of output.split('\n')) {
    // Every line with the two numbers is a session, whatever its name — a
    // person can name one with spaces on the shared socket, and a session left
    // uncounted is one the keep-or-vacate check would remove from under them.
    const m = /^(\d+) (\d+)(?: (.*))?$/.exec(line.trim());
    if (!m) continue;
    sessions += 1;
    if (Number(m[1]) > 0) attached = true;
    const at = Number(m[2]) * 1000;
    if (last === null || at > last) last = at;
    if (m[3] && SESSION_NAME_IN_LIST.test(m[3])) named.push({ name: m[3], attachedClients: Number(m[1]), lastActivityMs: at });
  }
  return { sessions, attached, lastActivityMs: last, named };
}
