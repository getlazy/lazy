/**
 * Centralized terminal coloring/theming system.
 *
 * Everything that writes coloured text to a terminal imports this module. No
 * ANSI codes should appear anywhere else in the codebase.
 *
 * It lives in `src/render/` rather than `src/cli/` because the CLI is not its
 * only caller: the daemon warns through it, and the web watch stream renders
 * captured terminal output with it. Colouring is presentation, not a
 * command-line concern.
 *
 * Colors are disabled when:
 * - NO_COLOR env var is set (https://no-color.org/)
 * - TERM=dumb
 * - stdout is not a TTY
 */

// ── ANSI escape helpers ──────────────────────────────────────────────────

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

function wrap(code: string, s: string): string {
  if (!colorsEnabled()) return s;
  return `${ESC}${code}m${s}${RESET}`;
}

// ── NO_COLOR detection ───────────────────────────────────────────────────

let _colorsEnabled: boolean | null = null;

function colorsEnabled(): boolean {
  if (_colorsEnabled !== null) return _colorsEnabled;
  _colorsEnabled = !(
    process.env.NO_COLOR !== undefined ||
    process.env.TERM === 'dumb' ||
    !process.stdout.isTTY
  );
  return _colorsEnabled;
}

/** Reset the cached color-enabled state (useful for testing). */
export function resetColorCache(): void {
  _colorsEnabled = null;
}

/**
 * Run a SYNCHRONOUS render with colors forced on, whatever this process's own
 * stdout is.
 *
 * The daemon's stdout is never a TTY, so `colorsEnabled()` is false there — yet
 * the daemon renders the very same `lazy watch` lines into a browser xterm.js
 * terminal, which renders ANSI perfectly well. Without this the web watch panel
 * would show colorless text purely because of where the string was built.
 *
 * The callback MUST be synchronous and MUST do nothing but build strings: the
 * flag is process-global, so an `await` inside would leak forced colors into
 * whatever else the process logged meanwhile. Every renderer used this way
 * (src/render/watch-renderer.ts, proxy-activity-renderer.ts, status-header.ts) is
 * pure string work by construction.
 */
export function renderWithColors<T>(render: () => T): T {
  const previous = _colorsEnabled;
  _colorsEnabled = true;
  try {
    return render();
  } finally {
    _colorsEnabled = previous;
  }
}

// ── Color primitives ─────────────────────────────────────────────────────

export function bold(s: string): string { return wrap('1', s); }
export function dim(s: string): string { return wrap('2', s); }
export function red(s: string): string { return wrap('31', s); }
export function green(s: string): string { return wrap('32', s); }
export function yellow(s: string): string { return wrap('33', s); }
export function blue(s: string): string { return wrap('34', s); }
export function magenta(s: string): string { return wrap('35', s); }
export function cyan(s: string): string { return wrap('36', s); }

// ── Strip ANSI ───────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ── Semantic formatters ──────────────────────────────────────────────────

const STATUS_COLORS: Record<string, (s: string) => string> = {
  working: blue,
  queued: dim,
  blocked: yellow,
  conflict: red,
  submitted: cyan,
  pairing: magenta,
  merging: cyan,
  complete: green,
  completed: green,
  accepted: green,
  zombie: red,
  interrupted: red,
  abandoned: red,
  rejected: red,
  ended: dim,
};

export const theme = {
  taskId(id: string): string { return cyan(id); },

  status(status: string): string {
    const colorFn = STATUS_COLORS[status] ?? ((s: string) => s);
    return colorFn(status);
  },

  model(model: string): string { return magenta(model); },

  /** A tag label, e.g. "#onboarding". Rendered in cyan to stand out in lists. */
  tag(text: string): string { return cyan(text); },

  commitSha(sha: string): string { return yellow(sha); },

  command(cmd: string): string { return cyan(cmd); },

  header(text: string): string { return bold(text); },

  separator(text: string): string { return dim(text); },

  error(text: string): string { return bold(red(text)); },

  warning(text: string): string { return yellow(text); },

  success(text: string): string { return green(text); },

  timestamp(text: string): string { return dim(text); },

  duration(text: string): string { return dim(text); },

  label(text: string): string { return bold(text); },

  value(text: string): string { return text; },

  turnRole(role: string): string {
    if (role === 'human') return green(role);
    if (role === 'agent') return blue(role);
    return role;
  },

  count(text: string): string { return bold(text); },

  /**
   * Pad a (possibly ANSI-colored) string to `width` visible characters.
   * Uses the stripped length so columns stay aligned with colors.
   */
  pad(text: string, width: number): string {
    const visible = stripAnsi(text).length;
    if (visible >= width) return text;
    return text + ' '.repeat(width - visible);
  },
};
