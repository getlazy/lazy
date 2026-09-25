/**
 * Validation and slicing for "give me lines X..Y of this file", the data behind
 * the review diff's expand-context controls.
 *
 * Pure on purpose: it imports nothing from the daemon or the web layer, so the
 * part that can actually be wrong — the bounds arithmetic and the refusals — is
 * unit-testable without a repository, a task or a running daemon. The daemon
 * handler does the git work and turns a refusal here into an RpcError; the web
 * route turns it into a status code.
 */

/** How many lines one "expand up / expand down" click reveals. GitHub's default. */
export const EXPAND_CHUNK_LINES = 20;

/**
 * Hard ceiling on a single request, including "expand all".
 *
 * A gap between two hunks can be the whole file, and the reviewer's browser has
 * to insert every returned line as a table row. Bounding it at the boundary
 * keeps one click from serialising a 200k-line file into a page; the response
 * says where it stopped so the control can simply be clicked again.
 */
export const MAX_EXPAND_LINES = 2000;

export type FileLinesSide = 'old' | 'new';

export interface FileLinesRequest {
  path: string;
  side: FileLinesSide;
  /** 1-based, inclusive. */
  start: number;
  /** 1-based, inclusive, already clamped to at most MAX_EXPAND_LINES from start. */
  end: number;
}

export type FileLinesValidation =
  | { ok: true; request: FileLinesRequest }
  | { ok: false; status: number; error: string };

export interface FileLinesInput {
  path: unknown;
  side: unknown;
  start: unknown;
  end: unknown;
  /**
   * The paths this diff actually touches, post-image names for `new` and
   * pre-image names for `old`. A request for anything else is a 404 — the
   * review page is a view of ONE change, not a file browser for the worktree.
   */
  allowedPaths: readonly string[];
}

/**
 * Is this a path we are willing to look up at all, independent of the diff?
 *
 * The allow-list below already makes traversal impossible, but a path is a
 * boundary input and gets checked as one: an absolute path or a `..` segment is
 * refused by name so a future caller that loosens the allow-list does not
 * silently gain a filesystem read. Backslashes are rejected too — a Windows
 * separator never appears in a git path, and normalising one is how `..\..` gets
 * past a check written for `/`.
 */
export function isSafeDiffPath(path: string): boolean {
  if (!path) return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  if (path.includes('\0')) return false;
  return !path.split('/').some((seg) => seg === '..');
}

function asPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= 1 ? i : null;
}

/** Parse and bound an expand request, or say exactly why it is refused. */
export function validateFileLinesRequest(input: FileLinesInput): FileLinesValidation {
  if (typeof input.path !== 'string' || input.path.length === 0) {
    return { ok: false, status: 400, error: 'path is required' };
  }
  const path = input.path;
  if (!isSafeDiffPath(path)) {
    return { ok: false, status: 400, error: `Refusing to read path: ${path}` };
  }
  const side: FileLinesSide = input.side === 'old' ? 'old' : 'new';
  if (input.side !== undefined && input.side !== 'old' && input.side !== 'new') {
    return { ok: false, status: 400, error: `side must be 'old' or 'new', got: ${String(input.side)}` };
  }
  if (!input.allowedPaths.includes(path)) {
    return { ok: false, status: 404, error: `File is not part of this diff: ${path}` };
  }
  const start = asPositiveInt(input.start);
  if (start === null) {
    return { ok: false, status: 400, error: 'start must be a line number >= 1' };
  }
  const rawEnd = asPositiveInt(input.end);
  if (rawEnd === null) {
    return { ok: false, status: 400, error: 'end must be a line number >= 1' };
  }
  if (rawEnd < start) {
    return { ok: false, status: 400, error: `end (${rawEnd}) is before start (${start})` };
  }
  const end = Math.min(rawEnd, start + MAX_EXPAND_LINES - 1);
  return { ok: true, request: { path, side, start, end } };
}

export interface FileLinesSlice {
  /** Echoed back clamped to the file: the caller renders numbers from these. */
  start: number;
  end: number;
  lines: string[];
  totalLines: number;
  /** The slice reached the end of the file — the "expand down" control is done. */
  atEof: boolean;
}

/**
 * Take an inclusive 1-based line range out of a file's text.
 *
 * A trailing newline is a terminator, not an empty last line: `"a\nb\n"` is two
 * lines, and counting the empty string after the final `\n` as a third would
 * make every expanded file end in a phantom blank row that no editor shows.
 */
export function sliceFileLines(content: string, start: number, end: number): FileLinesSlice {
  const all = content.split('\n');
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const totalLines = all.length;
  const from = Math.max(1, start);
  const to = Math.min(end, totalLines);
  const lines = to < from ? [] : all.slice(from - 1, to);
  return {
    start: from,
    end: to < from ? from - 1 : to,
    lines,
    totalLines,
    atEof: to >= totalLines,
  };
}
