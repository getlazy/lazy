/**
 * The git half of review regions — layer (a) and (c) of §1.5.2.
 *
 * Everything here works on a bare clone with no `.lazy`, no network and no
 * forge token. That is the whole point: lazy's store is enrichment, and a
 * project where none of the work went through lazy must still get regions.
 */

import { runGit } from '../utils/git';

/** One identity on a commit: the git author, or a `Co-authored-by:` trailer. */
export interface CommitIdentity {
  name: string;
  email: string;
  /**
   * True when this is a machine attribution rather than a person.
   *
   * Load-bearing, not cosmetic. Expansion trigger 2 asks "did more than one
   * PERSON write this", and on an agent-driven repo every commit carries a
   * `Co-authored-by:` trailer naming the agent — 471 `Lazy <noreply@…>` and 15
   * `Claude Opus 4.8 <noreply@…>` across this repo's own v0.22 release. Counting
   * those as co-authors made the trigger fire on essentially every task branch
   * and shattered each one into its commits. See {@link isAutomatedIdentity}.
   */
  automated: boolean;
}

/** One commit on a first-parent walk, with the paths its first-parent diff touches. */
export interface WalkedCommit {
  sha: string;
  /** Parent SHAs in order. Length > 1 means a real merge. */
  parents: string[];
  subject: string;
  /** Git author plus every `Co-authored-by:` identity, deduped by name+email. */
  identities: CommitIdentity[];
  /** Paths of `diff <first parent> <this commit>`. */
  paths: string[];
}

// Record and field separators. Chosen over newlines because a commit subject
// and a trailer value may both contain anything a newline can.
const REC = '\x01';
const FIELD = '\x02';
const ENDHEAD = '\x03';

const LOG_FORMAT =
  `${REC}%H${FIELD}%P${FIELD}%an <%ae>${FIELD}%s${FIELD}` +
  `%(trailers:key=Co-authored-by,valueonly,separator=%x1f)${ENDHEAD}`;

/**
 * First-parent walk of `from..to`, with each commit's first-parent diff paths.
 *
 * `--diff-merges=first-parent` is what makes a merge commit report the files
 * its branch brought in rather than nothing at all; without it a merge unit
 * would look empty and every merge-based repo would carve into nothing.
 *
 * `excludeRef` is appended as a `^<ref>` exclusion so that a sub-range can
 * never wander outside the reviewed range. Without it, expanding a "merge main
 * into the release branch" commit walks all of `main` — history the review was
 * explicitly based against and does not contain.
 *
 * Never throws: an unresolvable ref yields an empty walk, and the caller
 * records a note. A carving that refuses to render because one deleted branch
 * did not resolve is worse than a coarser one.
 */
export async function walkFirstParent(
  cwd: string,
  from: string,
  to: string,
  excludeRef?: string,
): Promise<WalkedCommit[]> {
  const args = [
    'log',
    '-z',
    '--first-parent',
    '--diff-merges=first-parent',
    '--name-only',
    `--format=${LOG_FORMAT}`,
    `${from}..${to}`,
  ];
  if (excludeRef) args.push(`^${excludeRef}`);
  const result = await runGit(args, { cwd });
  if (result.exitCode !== 0 || !result.stdout) return [];
  return parseWalk(result.stdout);
}

/**
 * Exported for the unit suite: the parse is where the separators earn their keep.
 *
 * Paths arrive NUL-separated (`-z`) and are used VERBATIM. Git's default output
 * QUOTES a path containing a non-ASCII byte, a quote or a backslash —
 * `"src/\303\251.ts"` — and does not unquote it on input, so a region recorded
 * from the default output scoped its own diff to nothing and came back short
 * with no error. `-z` makes the path make the round trip unchanged; do not add
 * trimming here, since a path may legitimately begin or end with a space.
 */
export function parseWalk(stdout: string): WalkedCommit[] {
  const commits: WalkedCommit[] = [];
  for (const record of stdout.split(REC)) {
    if (!record) continue;
    const end = record.indexOf(ENDHEAD);
    if (end < 0) continue;
    const head = record.slice(0, end);
    const [sha = '', parents = '', author = '', subject = '', coAuthors = ''] = head.split(FIELD);
    const identities = parseIdentities([author, ...coAuthors.split('\x1f')]);
    commits.push({
      sha: sha.trim(),
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      subject,
      identities,
      // `-z` terminates each path with NUL. Git puts its own separator between
      // the format output and the first path, so strip only the leading
      // NUL/newline run — never the paths themselves.
      paths: record
        .slice(end + 1)
        .replace(/^[\0\n]+/, '')
        .split('\0')
        .filter((p) => p.length > 0 && p !== '\n'),
    });
  }
  return commits;
}

const IDENTITY_RE = /^(.*?)\s*<([^>]*)>\s*$/;

/** Parse `Name <mail@example.com>` strings into deduped identities. */
export function parseIdentities(raw: string[]): CommitIdentity[] {
  const seen = new Map<string, CommitIdentity>();
  for (const entry of raw) {
    const text = entry.trim();
    if (!text) continue;
    const match = IDENTITY_RE.exec(text);
    const name = (match ? match[1]! : text).trim();
    const email = (match ? match[2]! : '').trim();
    if (!name && !email) continue;
    const key = `${name.toLowerCase()}|${email.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.set(key, { name, email, automated: isAutomatedIdentity(name, email) });
  }
  return [...seen.values()];
}

/**
 * Is this identity a machine rather than a person?
 *
 * Deliberately a rule about the ADDRESS, not a list of agent names: a list
 * would need an entry per agent forever, and would be wrong on the next one.
 * Forges already mark automation this way — a `noreply@` sender or a `[bot]`
 * suffix — and lazy's own attributions (`Lazy <noreply@getlazy.dev>`,
 * `Claude … <noreply@anthropic.com>`) follow the same convention.
 *
 * `user@users.noreply.github.com` is deliberately NOT automated: that is
 * GitHub's privacy address for a real person, and treating it as a machine
 * would erase human co-authors on exactly the repos most likely to have them.
 */
export function isAutomatedIdentity(name: string, email: string): boolean {
  const mail = email.toLowerCase();
  const who = name.toLowerCase();
  if (who.endsWith('[bot]')) return true;
  if (mail.endsWith('@users.noreply.github.com')) return false;
  const local = mail.split('@')[0] ?? '';
  return local === 'noreply' || local === 'no-reply' || mail === 'actions@github.com';
}

/** Distinct HUMAN identities across a set of commits — expansion trigger 2. */
export function humanIdentities(commits: readonly WalkedCommit[]): string[] {
  const people = new Set<string>();
  for (const commit of commits) {
    for (const id of commit.identities) {
      if (!id.automated) people.add(id.name || id.email);
    }
  }
  return [...people];
}

/** Paths touched by `from..to`, in one call. Empty when the range does not resolve. */
export async function rangePaths(cwd: string, from: string, to: string): Promise<string[]> {
  // `-z` for the same round-trip reason as the walk: these paths are handed
  // back to git as a pathspec.
  const result = await runGit(['diff', '-z', '--name-only', `${from}..${to}`], { cwd });
  if (result.exitCode !== 0 || !result.stdout) return [];
  return [...new Set(result.stdout.split('\0').filter((p) => p.length > 0))];
}

/**
 * Every path the range changes, as `<path> -> "<old blob>:<new blob>"`.
 *
 * Blob shas, not modes or line counts: they are CONTENT identity, which is
 * what a per-region sign-off hash needs — two commits that leave a file
 * byte-identical produce the same pair, and two that differ by a byte do not.
 * One call over the whole review range, however many regions hash out of it.
 *
 * `--no-renames` keeps one path per record (a rename reads as a delete plus
 * an add), so the parser never has to consume a second path token; the
 * deleted side carries `0000000` as its new blob, which still changes the
 * pair and so still stales a sign-off on the region that owned the file.
 *
 * Never throws: an unresolvable range yields an empty map, and the caller
 * hashes from nothing rather than failing a read.
 */
export async function blobPairs(cwd: string, range: string): Promise<Map<string, string>> {
  const result = await runGit(['diff', '--raw', '-z', '--no-renames', range], { cwd });
  const out = new Map<string, string>();
  if (result.exitCode !== 0 || !result.stdout) return out;
  const fields = result.stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i]!;
    if (!head.startsWith(':')) continue;
    // `:<old-mode> <new-mode> <old-sha> <new-sha> <status>`, joined to its
    // path(s) by NULs. With `--no-renames` every record names exactly one
    // path, so the paths are consumed positionally rather than parsed.
    const parts = head.split(' ');
    if (parts.length < 5) continue;
    const path = fields[++i];
    if (!path) continue;
    out.set(path, `${parts[2]}:${parts[3]}`);
  }
  return out;
}

/** Does this ref resolve to a commit in this repo? */
export async function refResolves(cwd: string, ref: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  return result.exitCode === 0;
}

/** Resolve a ref to a full SHA, or null. */
export async function resolveSha(cwd: string, ref: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Every `lazy-accept-<taskId>` tag in the repo, as commit sha → task id.
 *
 * THE authoritative answer to "is this commit a lazy accept, and of what".
 * The tag is created by accept itself, before the task's status flips, and is
 * already the single source of truth the zombie sweep trusts — so a tag hit
 * beats any amount of reading commit messages. Subject conventions stay as the
 * FALLBACK for a repo that has no tags: a non-lazy project, a shallow clone, or
 * this project after the tags are retired.
 *
 * One `for-each-ref` for the whole repo, whatever the region count.
 * `%(*objectname)` is the peeled commit on an annotated tag (accept writes
 * annotated ones) and empty on a lightweight tag, where `%(objectname)` is
 * already the commit.
 *
 * Note on tag retirement: a cover PERSISTS each region's unit id and commit
 * range, so covers carved while tags exist keep their attribution afterwards.
 * Newly carved ranges fall back to subjects.
 */
export async function listAcceptTagCommits(cwd: string): Promise<Map<string, string>> {
  const result = await runGit(
    [
      'for-each-ref',
      '--format=%(refname:short)%09%(*objectname)%09%(objectname)',
      'refs/tags/lazy-accept-*',
    ],
    { cwd },
  );
  const byCommit = new Map<string, string>();
  if (result.exitCode !== 0) return byCommit;
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name = '', peeled = '', object = ''] = line.split('\t');
    const sha = (peeled || object).trim();
    const taskId = name.trim().replace(/^lazy-accept-/, '');
    if (sha && taskId && taskId !== name.trim()) byCommit.set(sha, taskId);
  }
  return byCommit;
}

/**
 * What a commit subject says about the unit behind it — layer (c).
 *
 * Cheap, and the only layer that survives branch deletion on its own. Three
 * conventions, in order of how much they pin down:
 *   - lazy's `Accept task <code>: <goal>` names the task outright
 *   - `Merge pull request #123 from <owner>/<branch>` names both PR and branch
 *   - GitHub's squash suffix `… (#123)` names only the PR
 */
export interface SubjectUnit {
  kind: 'lazy-task' | 'pr-merge' | 'pr-squash';
  /** Task code, for `lazy-task`. */
  code?: string;
  /** Full lazy task id, set only when an accept TAG identified this commit. */
  taskId?: string;
  /** Branch name, for `pr-merge`. */
  branch?: string;
  /** PR/MR number, for both PR forms. */
  pr?: string;
  /** The human-readable part of the subject, with the convention stripped. */
  title: string;
}

const ACCEPT_RE = /^Accept task ([^\s:]+):\s*(.*)$/;
const PR_MERGE_RE = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/;
const PR_SQUASH_RE = /^(.*?)\s*\(#(\d+)\)\s*$/;

export function unitFromSubject(subject: string): SubjectUnit | null {
  const accept = ACCEPT_RE.exec(subject);
  if (accept) {
    return { kind: 'lazy-task', code: accept[1]!, title: accept[2]! || accept[1]! };
  }
  const prMerge = PR_MERGE_RE.exec(subject);
  if (prMerge) {
    return { kind: 'pr-merge', pr: prMerge[1]!, branch: prMerge[2]!, title: subject };
  }
  const prSquash = PR_SQUASH_RE.exec(subject);
  if (prSquash && prSquash[1]!.trim()) {
    return { kind: 'pr-squash', pr: prSquash[2]!, title: prSquash[1]!.trim() };
  }
  return null;
}

/**
 * Branch refs to try for a squash commit, most specific first.
 *
 * `refs/heads/<name>` then every remote — the order §1.5.2 specifies. The
 * lazy spellings come first because on a lazy project they are the ones that
 * exist; on any other project they simply do not resolve and cost one
 * rev-parse each.
 */
export function branchCandidates(unit: SubjectUnit, remotes: string[]): string[] {
  const names: string[] = [];
  if (unit.kind === 'lazy-task' && unit.code) {
    names.push(`lazy/${unit.code}`, unit.code);
  }
  if (unit.kind === 'pr-merge' && unit.branch) {
    names.push(unit.branch);
  }
  const refs: string[] = [];
  for (const name of names) {
    refs.push(`refs/heads/${name}`);
    for (const remote of remotes) refs.push(`refs/remotes/${remote}/${name}`);
  }
  return refs;
}

/** Remote names in this repo, for the remote-tracking branch sweep. */
export async function listRemotes(cwd: string): Promise<string[]> {
  const result = await runGit(['remote'], { cwd });
  if (result.exitCode !== 0) return [];
  return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Every local and remote-tracking branch ref, as full refnames, in ONE call.
 *
 * Branch recovery asks "does `refs/heads/lazy/<code>` exist?" for up to four
 * spellings per unit. On a repo with 340 accepts and 1,400 refs that is 1,400
 * `rev-parse` spawns; one `for-each-ref` answers all of them.
 */
export async function listBranchRefs(cwd: string): Promise<Set<string>> {
  const result = await runGit(
    ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'],
    { cwd },
  );
  if (result.exitCode !== 0) return new Set();
  return new Set(result.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
}
