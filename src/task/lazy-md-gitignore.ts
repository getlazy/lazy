/**
 * Gitignore cascade for the LAZY.md nested sweep.
 *
 * The sweep must not walk into trees the project has already declared irrelevant
 * — dependency dirs, build output, generated code. A hard-coded list of those
 * names is always both incomplete (every language has its own) and wrong for a
 * project that force-tracks one of them. The project's own `.gitignore` files
 * are the source of truth: as the sweep visits a directory it loads that
 * directory's `.gitignore` (if any) and stacks it on the rules inherited from
 * ancestors, the same cascade git itself uses. A child whose path is ignored is
 * not descended into.
 *
 * This is a focused subset of gitignore semantics — enough for "should we walk
 * into this directory", not a reimplementation of `git check-ignore`. Patterns
 * we honour: comments, negation (`!`), directory-only (trailing `/`), rooted
 * patterns (leading `/` or a `/` in the middle), `*`, `?`, and `**`.
 * Dot-directories stay a hard skip in the caller (`.lazy` must never be swept
 * regardless of whether a project's `.gitignore` mentions it).
 */

/** One compiled rule from a single `.gitignore` line. */
export interface GitIgnoreRule {
  negated: boolean;
  directoryOnly: boolean;
  /**
   * Match a path relative to the directory that held this `.gitignore`,
   * POSIX-separated, with no leading `./`. `isDirectory` is true when the
   * candidate is a directory we are considering descending into.
   */
  test: (relPath: string, isDirectory: boolean) => boolean;
}

/** Escape a literal substring so it is safe inside a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert one gitignore glob (already stripped of `!` and trailing `/`) into a
 * RegExp that matches a whole relative path.
 *
 * `anchored` means the pattern is relative to the `.gitignore`'s directory
 * (leading `/`, or a `/` somewhere in the middle). Unanchored patterns may match
 * at any depth below that directory — `node_modules` matches both
 * `node_modules` and `packages/foo/node_modules`.
 */
function globToRegExp(glob: string, anchored: boolean): RegExp {
  let source = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      // Zero or more directories.
      source += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob[i] === '*' && glob[i + 1] === '*') {
      // Lone `**` (end of pattern, or already handled `**/` above).
      source += '.*';
      i += 2;
      continue;
    }
    if (glob[i] === '*') {
      source += '[^/]*';
      i += 1;
      continue;
    }
    if (glob[i] === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }
    source += escapeRegExp(glob[i]!);
    i += 1;
  }

  if (anchored) {
    return new RegExp(`^${source}$`);
  }
  // Unanchored: the pattern may match the whole relative path OR any trailing
  // segment sequence (`foo/bar` matches `a/foo/bar`).
  return new RegExp(`(?:^|/)${source}$`);
}

/**
 * Parse the text of one `.gitignore` into ordered rules. Later rules override
 * earlier ones for the same path (including negation), matching git.
 */
export function parseGitignore(content: string): GitIgnoreRule[] {
  const rules: GitIgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    // Trailing spaces are insignificant unless escaped; we don't honour the
    // escape — alpha-simple. Leading spaces are part of the pattern in git,
    // but almost nobody relies on that; trimEnd only.
    const line = rawLine.trimEnd();
    if (line === '' || line.startsWith('#')) continue;

    let pattern = line;
    let negated = false;
    if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1);
    }
    if (pattern === '') continue;

    let directoryOnly = false;
    if (pattern.endsWith('/')) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }

    // A leading slash anchors at the `.gitignore`'s directory; so does a slash
    // anywhere else (git treats "foo/bar" as relative to the file's location).
    let anchored = false;
    if (pattern.startsWith('/')) {
      anchored = true;
      pattern = pattern.slice(1);
    } else if (pattern.includes('/')) {
      anchored = true;
    }

    if (pattern === '') continue;

    const re = globToRegExp(pattern, anchored);
    rules.push({
      negated,
      directoryOnly,
      test(relPath, isDirectory) {
        if (directoryOnly && !isDirectory) return false;
        return re.test(relPath);
      },
    });
  }
  return rules;
}

interface CascadeLayer {
  /** POSIX path of this layer's directory relative to the discovery root (`''` at root). */
  baseRel: string;
  rules: GitIgnoreRule[];
}

/**
 * Stack of `.gitignore` layers from the discovery root down to the directory
 * currently being scanned. Clone when branching in a BFS so each frontier node
 * carries the cascade that applies to its children.
 */
export class GitIgnoreCascade {
  private layers: CascadeLayer[] = [];

  /**
   * Append the rules from one directory's `.gitignore` (or nothing).
   * `baseRel` is that directory's path relative to the discovery root.
   */
  push(baseRel: string, content: string | null): void {
    this.layers.push({
      baseRel,
      rules: content === null ? [] : parseGitignore(content),
    });
  }

  /** Independent copy — BFS frontier nodes must not share mutable layer lists. */
  clone(): GitIgnoreCascade {
    const copy = new GitIgnoreCascade();
    copy.layers = this.layers.map(layer => ({
      baseRel: layer.baseRel,
      rules: layer.rules,
    }));
    return copy;
  }

  /**
   * Whether `relPath` (POSIX, relative to the discovery root) is ignored by the
   * cascade as currently stacked. `isDirectory` selects directory-only rules.
   *
   * Each layer's patterns are matched against the path relative to THAT layer's
   * directory. Last matching rule across the whole cascade wins.
   */
  ignores(relPath: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const layer of this.layers) {
      const relToLayer =
        layer.baseRel === ''
          ? relPath
          : relPath === layer.baseRel
            ? ''
            : relPath.startsWith(layer.baseRel + '/')
              ? relPath.slice(layer.baseRel.length + 1)
              : null;
      // A pattern relative to a directory cannot match a path outside it.
      if (relToLayer === null || relToLayer === '') continue;
      for (const rule of layer.rules) {
        if (rule.test(relToLayer, isDirectory)) {
          ignored = !rule.negated;
        }
      }
    }
    return ignored;
  }
}
