/**
 * Host extraction for git remote URLs, shared by the GitHub and GitLab drivers.
 *
 * Both drivers used to decide "is this remote GitHub/GitLab?" with
 * `url.includes('github.com')`. That is a substring test against the whole URL,
 * so `https://evil.com/github.com/x.git` matched. Nothing is trusted based on
 * the answer — worst case lazy picks a driver whose API calls then fail — but
 * the check should still mean what it says, so the comparison happens against
 * the parsed HOST.
 *
 * Two URL shapes have to work:
 *   - scp syntax:  git@github.com:getlazy/lazy.git   (no scheme — `new URL()` throws)
 *   - full URLs:   https://github.com/getlazy/lazy.git, ssh://git@github.com/…
 */

/** `[user@]host:path` — scp syntax. Has a colon before any slash and no `://`. */
const SCP_SYNTAX = /^(?:[^@/]+@)?([^@/:]+):(?!\/)/;

/**
 * Extract the lowercased host from a git remote URL, or null if it has none
 * (unparseable, or a local path like `/srv/git/repo.git`).
 *
 * Userinfo is stripped for both shapes, so a credential-bearing
 * `https://user:token@github.com/…` yields `github.com` and never leaks its
 * token into a caller's comparison or warning text.
 */
export function remoteUrlHost(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const scp = SCP_SYNTAX.exec(trimmed);
  if (scp) return scp[1].toLowerCase();

  try {
    const host = new URL(trimmed).hostname;
    return host ? host.toLowerCase() : null;
  } catch {
    // Not a URL and not scp syntax — a local path or garbage. No host.
    return null;
  }
}

/**
 * Extract the repository path from a git remote URL — everything after the
 * host, with the leading slash, any trailing slash and a trailing `.git`
 * removed. Returns null when the URL has no host (a local path) or no path.
 *
 *   git@github.mycorp.com:team/app.git    -> team/app
 *   https://github.com/getlazy/lazy.git   -> getlazy/lazy
 *   ssh://git@ghe.example/team/app        -> team/app
 */
export function remoteUrlPath(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  let path: string;
  const scp = SCP_SYNTAX.exec(trimmed);
  if (scp) {
    // SCP_SYNTAX consumes `[user@]host:`, so the remainder is the path.
    path = trimmed.slice(scp[0].length);
  } else {
    try {
      const parsed = new URL(trimmed);
      if (!parsed.hostname) return null;
      path = parsed.pathname;
    } catch {
      return null;
    }
  }

  const cleaned = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  return cleaned || null;
}

/**
 * True when the remote's host is exactly `domain` or a subdomain of it.
 *
 * `github.com` and `www.github.com` match `github.com`; `evil.com` does not,
 * whatever its path contains, and neither does `notgithub.com`.
 */
export function remoteUrlHasHost(url: string, domain: string): boolean {
  const host = remoteUrlHost(url);
  if (!host) return false;
  const target = domain.toLowerCase();
  return host === target || host.endsWith(`.${target}`);
}

/**
 * True when `label` appears anywhere in the remote's HOST.
 *
 * The self-hosted escape hatch: `gitlab.mycorp.com` and `github.internal.example`
 * are GitLab/GitHub Enterprise installs with arbitrary hostnames, and warning
 * that they "do not appear to be GitLab" is noise. Unlike the old
 * `url.includes('gitlab')`, this looks at the host only — a path segment named
 * `gitlab` on someone else's server does not qualify.
 */
export function remoteUrlHostContains(url: string, label: string): boolean {
  const host = remoteUrlHost(url);
  return host !== null && host.includes(label.toLowerCase());
}
