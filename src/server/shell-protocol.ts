/**
 * Wire protocol for the web shell WebSocket (browser <-> daemon).
 *
 * Framing rule, both directions:
 *  - BINARY frames are raw terminal bytes, passed through untouched. Browser
 *    keystrokes go to the exec's stdin; exec output goes to the terminal.
 *  - TEXT frames are JSON control messages, defined here.
 *
 * Raw bytes ride binary frames deliberately: terminal I/O is not text (partial
 * UTF-8 sequences, escape bytes), and wrapping every chunk in JSON+base64 would
 * cost ~33% on the hot path for nothing. Control messages are rare and small,
 * so JSON is fine there.
 *
 * The parser is a system boundary: frames come from a browser, so every field
 * is validated and an unparseable message is rejected with a reason rather
 * than guessed at (see CLAUDE.md "external surfaces validate inputs").
 */

/** Bounds for a resize request. Wider than any real terminal, small enough
 * that a hostile value cannot make the PTY layer allocate absurd buffers. */
export const MIN_TERM_DIM = 2;
export const MAX_TERM_COLS = 1000;
export const MAX_TERM_ROWS = 500;

/** Default terminal geometry when the client has not measured yet. */
export const DEFAULT_TERM_COLS = 80;
export const DEFAULT_TERM_ROWS = 24;

/** Control messages the browser may send. */
export type ShellClientMessage =
  | { type: 'resize'; cols: number; rows: number };

/** Control messages the daemon sends. */
export type ShellServerMessage =
  | { type: 'ready'; container: string }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; message: string };

export type ParseResult =
  | { ok: true; message: ShellClientMessage }
  | { ok: false; error: string };

function isDim(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_TERM_DIM && v <= max;
}

/**
 * Parse a TEXT frame from the browser. Never throws: a malformed frame from a
 * (possibly hostile) client yields a reason the caller can log and ignore —
 * one bad frame must not tear down a live shell session.
 */
export function parseShellClientMessage(raw: string): ParseResult {
  if (raw.length > 1024) {
    return { ok: false, error: 'control message too large' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON from the network is an expected input at this boundary,
    // reported via the ok:false result — not an exception path.
    return { ok: false, error: 'control message is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'control message is not an object' };
  }
  const msg = parsed as Record<string, unknown>;
  if (msg.type === 'resize') {
    if (!isDim(msg.cols, MAX_TERM_COLS) || !isDim(msg.rows, MAX_TERM_ROWS)) {
      return {
        ok: false,
        error: `resize dimensions must be integers within ${MIN_TERM_DIM}..${MAX_TERM_COLS} cols / ${MIN_TERM_DIM}..${MAX_TERM_ROWS} rows`,
      };
    }
    return { ok: true, message: { type: 'resize', cols: msg.cols, rows: msg.rows } };
  }
  return { ok: false, error: `unknown control message type: ${String(msg.type)}` };
}

/** Serialize a server control message for a TEXT frame. */
export function shellServerMessage(msg: ShellServerMessage): string {
  return JSON.stringify(msg);
}

/** Serialize a client control message for a TEXT frame. */
export function shellClientMessage(msg: ShellClientMessage): string {
  return JSON.stringify(msg);
}

export type ServerParseResult =
  | { ok: true; message: ShellServerMessage }
  | { ok: false; error: string };

/**
 * Parse a TEXT frame from the daemon — the CLIENT's half of this protocol,
 * used by a terminal that attaches through Lazy Teams (src/teams/session-terminal.ts).
 * Never throws, for the same reason as {@link parseShellClientMessage}: the
 * frame crossed a network and a relay, and one unreadable control message
 * must not take a live terminal down with it.
 */
export function parseShellServerMessage(raw: string): ServerParseResult {
  if (raw.length > 64 * 1024) return { ok: false, error: 'control message too large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON from the network is an expected input at this boundary,
    // reported via the ok:false result — not an exception path.
    return { ok: false, error: 'control message is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'control message is not an object' };
  }
  const msg = parsed as Record<string, unknown>;
  switch (msg.type) {
    case 'ready':
      if (typeof msg.container !== 'string') return { ok: false, error: 'ready message has no container' };
      return { ok: true, message: { type: 'ready', container: msg.container } };
    case 'exit':
      if (msg.code !== null && !(typeof msg.code === 'number' && Number.isInteger(msg.code))) {
        return { ok: false, error: 'exit code must be an integer or null' };
      }
      return { ok: true, message: { type: 'exit', code: msg.code as number | null } };
    case 'error':
      if (typeof msg.message !== 'string') return { ok: false, error: 'error message has no text' };
      return { ok: true, message: { type: 'error', message: msg.message } };
    default:
      return { ok: false, error: `unknown control message type: ${String(msg.type)}` };
  }
}
