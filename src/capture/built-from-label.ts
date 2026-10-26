/**
 * The image label that records which branch commit a project image was built
 * from (the daemon's rebuild when the project's branch advances). It lives on
 * the image itself so `lazy doctor` — a separate process — can read it, and so
 * it survives a daemon restart. Zero imports: the doctor, the daemon and the
 * test module mock all reach it without a load-time cycle.
 */
export const BUILT_FROM_LABEL = 'lazy.built.from';

export interface BuiltFromCommit {
  branch: string;
  /** The full commit sha. */
  sha: string;
}

export function formatBuiltFromLabel(c: BuiltFromCommit): string {
  return `${c.branch}@${c.sha}`;
}

/** Parse a label value; null when it is not `<branch>@<sha>`. */
export function parseBuiltFromLabel(value: string): BuiltFromCommit | null {
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  return { branch: value.slice(0, at), sha: value.slice(at + 1) };
}
