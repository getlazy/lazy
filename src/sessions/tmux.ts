/**
 * Named, long-lived tmux sessions inside a task's container.
 *
 * One tmux SERVER per container, on a socket lazy owns ({@link TMUX_SOCKET});
 * lazy only ever addresses a session by its name. The `services` session runs
 * the project's Start services command (src/daemon/serve-run.ts); other names
 * are long-running commands a person or the agent started. Every session lazy
 * creates has `remain-on-exit` on, so the last screen and the exit code of a
 * command that ended stay readable, and its output is copied into a BOUNDED
 * log ({@link SESSION_LOG_MAX_BYTES}, two files) beside the socket.
 *
 * Why tmux: a session outlives whoever is looking at it. A browser reload, a
 * dropped SSH connection or a daemon restart leaves the command running, and
 * anybody may attach to it again — the screen redraws, a debugger or a REPL
 * waiting for input is still waiting. The detached run this replaced had no
 * terminal at all, so `binding.pry` or a REPL simply hung.
 *
 * Everything here is pure: shell text and parsers, no I/O. The daemon runs the
 * scripts with `docker exec` (src/daemon/task-sessions.ts), the CLI builds the
 * attach command from {@link attachSessionArgv} — so this module imports
 * nothing and is safe to reach from any layer.
 *
 * Where it lives in the container: `/tmp/lazy-tmux`, created on demand by
 * every script (mode 0700). Under /tmp rather than /run because the container
 * runs as an unprivileged user that cannot create anything under /run, and
 * because it goes away with the container exactly as the sessions do.
 */

/** The directory holding lazy's tmux socket and session logs, in the container. */
export const SESSIONS_DIR = '/tmp/lazy-tmux';

/** lazy's tmux server socket in the container. */
export const TMUX_SOCKET = `${SESSIONS_DIR}/default`;

/** Where each lazy-created session's output is copied, as `<name>.log` (+ `<name>.log.1`). */
export const SESSION_LOG_DIR = `${SESSIONS_DIR}/logs`;

/** The session the project's Start services command runs in. */
export const SERVICES_SESSION = 'services';

/**
 * A session log is rotated once it reaches this size, keeping one previous
 * file — so a session never holds more than about twice this on disk, however
 * long its command prints. (One write may carry it past the limit by up to one
 * 64 KiB read before the rotation.)
 */
export const SESSION_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** How many lines of the live screen (scrollback included) a read returns by default. */
export const DEFAULT_SCREEN_LINES = 200;

/** The most lines a screen read may ask for. */
export const MAX_SCREEN_LINES = 5000;

/** What a session name may be: what tmux accepts unquoted, and a path segment for its log. */
export const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** True for a name lazy will address. */
export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_RE.test(name);
}

/** The log file a session's output is copied to, in the container. */
export function sessionLogPath(name: string): string {
  return `${SESSION_LOG_DIR}/${name}.log`;
}

/**
 * The argv that attaches a terminal to a session, run INSIDE the container
 * (`docker exec -it <container> …`). `readOnly` attaches a viewer that cannot
 * type (`attach -r`). The name is matched exactly (`=`), never as a prefix.
 */
export function attachSessionArgv(name: string, opts: { readOnly?: boolean } = {}): string[] {
  return ['tmux', '-S', TMUX_SOCKET, 'attach-session', ...(opts.readOnly ? ['-r'] : []), '-t', `=${name}`];
}

/** The exit status a script uses when the container has no tmux. */
export const NO_TMUX_EXIT = 127;

/**
 * What every script starts with: the paths, and a `T` that talks to lazy's
 * server. With `requireTmux`, a container without tmux exits
 * {@link NO_TMUX_EXIT} saying so on stderr; without it, `has_tmux` is 0 and
 * `T` fails, so a read can still answer "nothing running".
 */
export function tmuxPrelude(opts: { requireTmux: boolean }): string {
  return [
    `D=${SESSIONS_DIR}; S=$D/default; L=$D/logs`,
    'has_tmux=1; command -v tmux >/dev/null 2>&1 || has_tmux=0',
    opts.requireTmux
      ? `[ $has_tmux = 1 ] || { echo "tmux is not installed in this container" >&2; exit ${NO_TMUX_EXIT}; }`
      : ':',
    'mkdir -p "$L" 2>/dev/null; chmod 700 "$D" 2>/dev/null',
    'T() { [ $has_tmux = 1 ] && tmux -S "$S" "$@"; }',
  ].join('\n');
}

/**
 * The bounded log writer `pipe-pane` feeds: copies stdin to `$1` as it
 * arrives, rotating `$1` to `$1.1` once it holds `$2` bytes. `dd count=1`
 * copies ONE read — whatever has arrived — so output reaches the file at once
 * (`head -c` waits for its whole count). It ends when the pane's pipe closes.
 *
 * It records its pid in `$1.writer` (and removes the file when it exits, if
 * the file is still its own), so `run_in` can wait for it to finish before it
 * rotates the log: the writer opens the file BY PATH on every read, so one
 * still draining after the rotation would append the previous run's last
 * bytes to the new run's log.
 */
export const LOG_WRITER_SCRIPT = [
  'f=$1; max=$2',
  'echo $$ > "$f.writer"',
  'trap \'[ "$(cat "$f.writer" 2>/dev/null)" = "$$" ] && rm -f "$f.writer"\' EXIT',
  'while :; do',
  '  s=$(wc -c < "$f" 2>/dev/null || echo 0)',
  '  if [ "$s" -ge "$max" ]; then mv -f "$f" "$f.1"; s=0; fi',
  '  dd bs=65536 count=1 status=none >> "$f" 2>/dev/null || exit 0',
  '  a=$(wc -c < "$f" 2>/dev/null || echo 0)',
  '  [ "$a" -gt "$s" ] || exit 0',
  'done',
].join('\n');

/**
 * Shell functions the session scripts share, after {@link tmuxPrelude}:
 *
 *   stop_group <pid>   TERM the process GROUP led by a pane's process, wait up
 *                      to 5s, then KILL — a pane's command is its terminal's
 *                      session leader, so everything it started that stayed in
 *                      its group (foreman's children, cargo's rustc) goes too.
 *   run_in <name> <cwd> <banner> <cmd>
 *                      (re)start <cmd> in session <name>: create the session if
 *                      it is not there, end what its pane runs, wait for the
 *                      previous run's log writer to finish (bounded), rotate
 *                      the previous run's log to `<name>.log.1` (so a run that
 *                      crashed — say during a turn, before the after-turn
 *                      restart — stays readable), open a new log, then run the
 *                      command — gated on a flag file so not a byte of its
 *                      output is printed before the log pipe is open.
 */
export function sessionFunctions(): string {
  return [
    'stop_group() {',
    '  [ -n "$1" ] || return 0',
    '  kill -TERM -"$1" 2>/dev/null || return 0',
    '  i=0; while kill -0 -"$1" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done',
    '  kill -KILL -"$1" 2>/dev/null; return 0',
    '}',
    'pane_pid() { T display-message -p -t "=$1:" \'#{pane_pid}\' 2>/dev/null; }',
    'run_in() {',
    '  n=$1; cwd=$2; banner=$3; cmd=$4; logf=$L/$n.log; go=$D/$n.go',
    `  printf '%s\\n' '${LOG_WRITER_SCRIPT.replace(/'/g, `'\\''`)}' > "$D/log-writer.sh"`,
    '  if T has-session -t "=$n" 2>/dev/null; then',
    '    stop_group "$(pane_pid "$n")"',
    '    T pipe-pane -t "=$n:" 2>/dev/null',
    // Closing the pipe ends the previous run's log writer; wait (bounded, 5s)
    // until it has, so nothing it still drains lands in the new run's log.
    '    w=$(cat "$logf.writer" 2>/dev/null); i=0',
    '    while [ -n "$w" ] && kill -0 "$w" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done',
    // The previous run's lines stay in its rotated log, not on the screen.
    '    T clear-history -t "=$n:" 2>/dev/null',
    '  else',
    // The server is SHARED with a person's shell session, so nothing is set
    // server-wide for good: `history-limit` is global only around creation (it
    // applies to panes created after it) and unset again; `remain-on-exit` is
    // set on this session's window alone — without it a command that ends takes
    // its session with it. The pane runs a placeholder that waits;
    // respawn-pane replaces it below.
    '    T set-option -g history-limit 10000 \\; new-session -d -s "$n" -x 200 -y 50 -c "$cwd" sh -c \'while :; do sleep 3600; done\' || return 1',
    '    T set-option -gu history-limit 2>/dev/null; T set-option -w -t "=$n:" remain-on-exit on || return 1',
    '  fi',
    // The previous run becomes .1 (replacing an older .1), so a session still
    // holds at most two files; reads show both, oldest first.
    '  if [ -s "$logf" ]; then mv -f "$logf" "$logf.1"; fi; : > "$logf"; rm -f "$go"',
    '  printf \'%s\' "$cmd" > "$D/$n.cmd"; date +%s > "$D/$n.started"',
    // The pane's process waits for the flag, prints the banner, then BECOMES
    // the command (`exec`), so the pane's pid — the process group stop_group
    // ends — is the command's own shell, and tmux records its exit status.
    '  T respawn-pane -k -t "=$n:" -c "$cwd" sh -c \'while [ ! -f "$0" ]; do sleep 0.05; done; rm -f "$0"; [ -n "$1" ] && printf "\\033[2m[lazy] %s\\033[0m\\r\\n" "$1"; exec sh -c "$2"\' "$go" "$banner" "$cmd" || return 1',
    // A fresh screen for the new run; the old one is in the rotated log.
    '  T send-keys -R -t "=$n:" 2>/dev/null',
    `  T pipe-pane -t "=$n:" "exec sh $D/log-writer.sh $logf ${SESSION_LOG_MAX_BYTES}"`,
    '  touch "$go"',
    '}',
  ].join('\n');
}

/**
 * Prints one line per session — `name<TAB>pane pid<TAB>pane dead (0/1)<TAB>
 * exit status<TAB>created (epoch)<TAB>attached clients` — between `@@sessions`
 * and `@@end`. `@@notmux` instead when the container has no tmux; nothing
 * between the markers when no server is running.
 */
export function listSessionsScript(): string {
  return [
    tmuxPrelude({ requireTmux: false }),
    'if [ $has_tmux = 0 ]; then echo "@@notmux"; exit 0; fi',
    'echo "@@sessions"',
    'T list-sessions -F \'#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}\t#{session_created}\t#{session_attached}\' 2>/dev/null',
    'echo "@@end"',
    'exit 0',
  ].join('\n');
}

/**
 * Read one session's output. `$1` is the name (validated by the caller and
 * never interpolated). Prints `@@notmux` / `@@nosession` when there is nothing
 * to read, then `@@screen <base64>` (the live pane, ANSI kept, with up to
 * `lines` lines of scrollback), `@@logbytes <n>` when the session has a log,
 * `@@end`, and the log's last `tailBytes` bytes (both files, oldest first).
 */
export function readSessionScript(lines: number, tailBytes: number): string {
  const n = Math.max(1, Math.min(MAX_SCREEN_LINES, Math.floor(lines)));
  const tail = Math.max(1, Math.floor(tailBytes));
  return [
    tmuxPrelude({ requireTmux: false }),
    'logf=$L/$1.log',
    'if [ $has_tmux = 0 ]; then echo "@@notmux"; elif T has-session -t "=$1" 2>/dev/null; then',
    `  echo "@@screen $(T capture-pane -p -e -J -S -${n} -t "=$1:" 2>/dev/null | base64 | tr -d '\\n')"`,
    'else echo "@@nosession"; fi',
    'if [ -f "$logf" ]; then echo "@@logbytes $(cat "$logf.1" "$logf" 2>/dev/null | wc -c)"; fi',
    'echo "@@end"',
    `[ -f "$logf" ] && cat "$logf.1" "$logf" 2>/dev/null | tail -c ${tail}`,
    'exit 0',
  ].join('\n');
}

/** A session in a task's container, as tmux reports it. */
export interface TaskSessionInfo {
  name: string;
  /** Is the pane's command still running? */
  alive: boolean;
  /** The pane's process (its command's shell), while known. */
  pid: number | null;
  /** How the command ended, when it has (`remain-on-exit` keeps the pane). */
  exitCode: number | null;
  /** When the session was created (ISO 8601). */
  createdAt: string | null;
  /** How many terminals are attached to it right now. */
  attachedClients: number;
}

/** {@link listSessionsScript}'s answer: null sessions when the container has no tmux. */
export function parseSessionList(stdout: string): { tmux: boolean; sessions: TaskSessionInfo[] } {
  const lines = stdout.split('\n');
  if (lines.some(l => l.trim() === '@@notmux')) return { tmux: false, sessions: [] };
  const start = lines.indexOf('@@sessions');
  const end = lines.indexOf('@@end');
  const rows = start === -1 ? [] : lines.slice(start + 1, end === -1 ? undefined : end);
  const int = (v: string | undefined) => (v !== undefined && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null);
  const sessions: TaskSessionInfo[] = [];
  for (const row of rows) {
    const [name, pid, dead, status, created, attached] = row.split('\t');
    if (!name || !isValidSessionName(name)) continue;
    const isDead = dead?.trim() === '1';
    const createdEpoch = int(created);
    sessions.push({
      name,
      alive: !isDead,
      pid: int(pid),
      exitCode: isDead ? int(status) : null,
      createdAt: createdEpoch !== null ? new Date(createdEpoch * 1000).toISOString() : null,
      attachedClients: int(attached) ?? 0,
    });
  }
  // The services session first, then by name: what a person looks for first.
  sessions.sort((a, b) => (a.name === SERVICES_SESSION ? -1 : b.name === SERVICES_SESSION ? 1 : a.name.localeCompare(b.name)));
  return { tmux: true, sessions };
}

/** One session's output: its live screen and the tail of its log. */
export interface SessionOutput {
  name: string;
  /** False when no session by this name exists (the log may still be there). */
  exists: boolean;
  /** The live pane with its scrollback, ANSI kept ('' when the session is gone). */
  screen: string;
  /** The tail of the session's log ('' when it has none). */
  log: string;
  /** The whole log's size (both files), or null when the session has no log. */
  logBytes: number | null;
  /** True when `log` holds less than the whole log. */
  logTruncated: boolean;
}

/** Parse {@link readSessionScript}'s output. */
export function parseSessionOutput(name: string, stdout: string): SessionOutput & { tmux: boolean } {
  const lines = stdout.split('\n');
  const endIdx = lines.indexOf('@@end');
  const head = endIdx === -1 ? lines : lines.slice(0, endIdx);
  const log = endIdx === -1 ? '' : lines.slice(endIdx + 1).join('\n');
  let screen = '';
  let exists = false;
  let tmux = true;
  let logBytes: number | null = null;
  for (const line of head) {
    if (line === '@@notmux') tmux = false;
    else if (line.startsWith('@@screen')) {
      exists = true;
      screen = Buffer.from(line.slice('@@screen'.length).trim(), 'base64').toString('utf-8');
    } else if (line.startsWith('@@logbytes ')) {
      const v = line.slice('@@logbytes '.length).trim();
      logBytes = /^\d+$/.test(v) ? Number(v) : null;
    }
  }
  return {
    name,
    tmux,
    exists,
    screen: trimTrailingBlankLines(screen),
    log,
    logBytes,
    logTruncated: logBytes !== null && logBytes > Buffer.byteLength(log),
  };
}

/** A detached pane is 50 rows tall; the rows below the last output are padding, not output. */
export function trimTrailingBlankLines(text: string): string {
  return text.replace(/(?:[ \t]*\n)+$/, '\n').replace(/^\n$/, '');
}
