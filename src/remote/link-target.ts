/**
 * Classify a `lazy link` argument as a PR/MR URL, a branch URL, or a bare branch.
 *
 * The daemon (not the CLI) calls this, then either asks the remote driver to
 * import a PR URL or fetches the named branch and looks for a PR afterwards.
 * Unit tests cover the classification so a GitHub tree URL cannot silently
 * become "not a PR" with no branch either.
 *
 * Branch and remote names are validated here — this is an external surface.
 * A name starting with `-` is a git option (`--upload-pack=…`); a decoded
 * URL segment can carry anything. Reject at the boundary so later git
 * argv never sees the raw user string.
 */

export type LinkTargetKind = 'pr-url' | 'branch-url' | 'branch';

export interface LinkTarget {
  kind: LinkTargetKind;
  /** The original argument, trimmed. */
  raw: string;
  /**
   * Branch name with no remote prefix. Set for branch-url and branch.
   * For pr-url this is undefined — the driver reads the head branch from the forge.
   */
  branch?: string;
  /** Remote name when the user wrote `origin/foo` and `origin` is a known remote. */
  remote?: string;
}

const DEFAULT_REMOTES = ['origin', 'upstream'];

/**
 * JS stand-in for `git check-ref-format --branch` (one-level names allowed)
 * plus the extra rule that a name starting with `-` is an option, not a ref.
 *
 * Kept sync so the parser stays a pure function. `linkTask` still runs the
 * real `git check-ref-format --branch` before any fetch, as a second check
 * on names that arrived from the forge rather than from this parser.
 */
export function assertSafeGitName(name: string, kind: 'branch' | 'remote'): void {
  const label = kind === 'remote' ? 'remote' : 'branch';
  if (!name) {
    throw new Error(`A ${label} name is required.`);
  }
  if (name.startsWith('-')) {
    throw new Error(
      `Invalid ${label} name '${name}': names starting with '-' are refused ` +
      '(they are parsed as git options).',
    );
  }
  // git check-ref-format rules (Documentation/git-check-ref-format.txt),
  // with --allow-onelevel so `main` / `origin` stay valid.
  if (name === '@') {
    throw new Error(`Invalid ${label} name '${name}'.`);
  }
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    throw new Error(`Invalid ${label} name '${name}': slashes must separate non-empty components.`);
  }
  if (name.endsWith('.')) {
    throw new Error(`Invalid ${label} name '${name}': cannot end with a dot.`);
  }
  if (name.includes('..')) {
    throw new Error(`Invalid ${label} name '${name}': cannot contain '..'.`);
  }
  if (name.includes('@{')) {
    throw new Error(`Invalid ${label} name '${name}': cannot contain '@{'.`);
  }
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) {
    throw new Error(
      `Invalid ${label} name '${name}': contains a character git does not allow in a ref.`,
    );
  }
  for (const part of name.split('/')) {
    if (part.startsWith('-')) {
      throw new Error(
        `Invalid ${label} name '${name}': a component cannot start with '-' ` +
        '(it would be parsed as a git option).',
      );
    }
    if (part.startsWith('.')) {
      throw new Error(`Invalid ${label} name '${name}': a component cannot start with a dot.`);
    }
    if (part.endsWith('.lock')) {
      throw new Error(`Invalid ${label} name '${name}': a component cannot end with '.lock'.`);
    }
  }
}

/**
 * Parse `ref` into a PR URL, a forge branch URL, or a bare git branch.
 *
 * `knownRemotes` decides whether `origin/feature/x` is remote+branch or a
 * branch literally named that. Defaults to `origin` and `upstream` so the
 * parser is usable without git; the daemon passes `git remote` output.
 *
 * Throws when the string is empty, is an http(s) URL that is neither a
 * PR/MR nor a `/tree/` branch page, or names a branch/remote git would
 * treat as an option or an illegal ref.
 */
export function parseLinkTarget(ref: string, knownRemotes: string[] = DEFAULT_REMOTES): LinkTarget {
  const raw = ref.trim();
  if (!raw) {
    throw new Error('A branch name or pull-request URL is required.');
  }

  if (/^https?:\/\//i.test(raw)) {
    return parseUrlTarget(raw);
  }

  return parseBranchSpec(raw, knownRemotes);
}

function parseUrlTarget(raw: string): LinkTarget {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }

  const path = parsed.pathname.replace(/\/+$/, '');

  // GitHub PR or GitLab MR (including `/-/merge_requests/N`).
  if (/\/(?:pull|merge_requests)\/\d+/.test(path)) {
    return { kind: 'pr-url', raw };
  }

  // GitLab: /group/proj/-/tree/branch
  const gitlabTree = path.match(/\/-\/tree\/(.+)$/);
  if (gitlabTree) {
    const branch = decodeBranch(gitlabTree[1]);
    assertSafeGitName(branch, 'branch');
    return { kind: 'branch-url', raw, branch };
  }

  // GitHub / GHES: /owner/repo/tree/branch (branch may contain slashes)
  const githubTree = path.match(/^\/[^/]+\/[^/]+\/tree\/(.+)$/);
  if (githubTree) {
    const branch = decodeBranch(githubTree[1]);
    assertSafeGitName(branch, 'branch');
    return { kind: 'branch-url', raw, branch };
  }

  throw new Error(
    `This URL is not a pull request, merge request, or branch page: ${raw}`,
  );
}

function decodeBranch(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function parseBranchSpec(raw: string, knownRemotes: string[]): LinkTarget {
  // Drop remotes that would themselves be git options so a compromised
  // `git remote` list cannot make `--upload-pack=…/foo` look like remote+branch.
  const remotes = new Set(
    knownRemotes.filter((name) => {
      try {
        assertSafeGitName(name, 'remote');
        return true;
      } catch {
        return false;
      }
    }),
  );
  const slash = raw.indexOf('/');
  if (slash > 0) {
    const maybeRemote = raw.slice(0, slash);
    const rest = raw.slice(slash + 1);
    if (remotes.has(maybeRemote) && rest.length > 0) {
      assertSafeGitName(maybeRemote, 'remote');
      assertSafeGitName(rest, 'branch');
      return { kind: 'branch', raw, branch: rest, remote: maybeRemote };
    }
  }
  assertSafeGitName(raw, 'branch');
  return { kind: 'branch', raw, branch: raw };
}
