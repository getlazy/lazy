/**
 * Artifact name validation.
 *
 * An artifact name is a relative POSIX path. It is joined onto a worktree path
 * at materialization time, so this is a SECURITY boundary, not a tidiness one:
 * a name containing `..` or a leading `/` would let whoever attached the file
 * write anywhere the daemon can reach. Validate once, here, and let every
 * surface (CLI, MCP, RPC) call it.
 *
 * Fail loud rather than silently rewriting: a caller who asked for `../x` wants
 * something this cannot give them, and quietly turning it into `x` would put a
 * file somewhere they did not ask for.
 */

import { MAX_ARTIFACT_NAME_LENGTH } from './limits';

/** Thrown for a name this can never accept. */
export class ArtifactNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactNameError';
  }
}

/**
 * Normalize and validate an artifact name.
 *
 * Accepts a relative POSIX path with `/` separators. Backslashes are converted
 * (a Windows-style path pasted in is a typo, not an attack), duplicate and
 * trailing slashes are collapsed, and a leading `./` is dropped. Everything
 * else that could escape the artifact root is rejected.
 */
export function normalizeArtifactName(raw: string): string {
  if (typeof raw !== 'string') {
    throw new ArtifactNameError('Artifact name must be a string.');
  }

  const trimmed = raw.trim().replace(/\\/g, '/');
  if (trimmed.length === 0) {
    throw new ArtifactNameError('Artifact name cannot be empty.');
  }
  if (trimmed.includes('\0')) {
    throw new ArtifactNameError('Artifact name cannot contain a NUL byte.');
  }
  if (trimmed.startsWith('/')) {
    throw new ArtifactNameError(
      `Artifact name must be relative, got '${raw}'. Names are paths inside the task's artifact space, e.g. 'design/index.html'.`,
    );
  }
  // A Windows drive letter is absolute even without a leading slash.
  if (/^[a-zA-Z]:/.test(trimmed)) {
    throw new ArtifactNameError(`Artifact name must be relative, got '${raw}'.`);
  }

  const segments = trimmed.split('/').filter(s => s.length > 0 && s !== '.');
  if (segments.length === 0) {
    throw new ArtifactNameError(`Artifact name '${raw}' has no path segments.`);
  }
  if (segments.some(s => s === '..')) {
    throw new ArtifactNameError(
      `Artifact name cannot contain '..', got '${raw}'. Names may not escape the task's artifact directory.`,
    );
  }

  const name = segments.join('/');
  if (name.length > MAX_ARTIFACT_NAME_LENGTH) {
    throw new ArtifactNameError(
      `Artifact name is ${name.length} characters, the maximum is ${MAX_ARTIFACT_NAME_LENGTH}.`,
    );
  }
  return name;
}

/** Extensions we recognize. Anything unlisted falls back by text/binary sniff. */
const MIME_BY_EXTENSION: Record<string, string> = {
  css: 'text/css',
  csv: 'text/csv',
  gif: 'image/gif',
  html: 'text/html',
  htm: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  toml: 'application/toml',
  ts: 'text/typescript',
  txt: 'text/plain',
  webp: 'image/webp',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
};

/**
 * Guess a mime type from the name, falling back to the text/binary verdict.
 *
 * Deliberately a lookup table and not a dependency: the mime type is metadata
 * for a human reading `lazy artifact list` and for whoever renders it later. It
 * is never used to decide how the bytes are stored or transported.
 */
export function guessMimeType(name: string, binary: boolean): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ?? (binary ? 'application/octet-stream' : 'text/plain');
}

/**
 * Is this buffer text? True when it decodes as UTF-8 with no NUL bytes.
 *
 * A NUL check alone would call UTF-16 text "text"; a strict decode alone would
 * accept a NUL-laden binary that happens to be valid UTF-8. Both together is the
 * cheap, boring answer, and this only feeds display decisions.
 */
export function isBinaryContent(buf: Uint8Array): boolean {
  if (buf.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return false;
  } catch {
    // Not valid UTF-8 — by definition not text. Nothing to surface: the caller
    // wants a boolean verdict, and "it failed to decode" IS the verdict.
    return true;
  }
}
