/**
 * WHO AUTHORS A GIT WRITE THE DAEMON MAKES — answered once, passed to git
 * explicitly, never left to git's auto-detect.
 *
 * Daemon-side git creates commits on people's behalf: `lazy_commit`, sync's
 * merges (host-side and an agent's self-sync), the accept squash, a stranded
 * accept's resume. On a laptop the daemon inherits the human's git config and
 * git finds an author by itself. On a managed (Teams) host the daemon runs with
 * NO git config — and deliberately never reads one for identity — so git fell
 * back to auto-detect and refused every commit ("unable to auto-detect email
 * address (got 'root@…(none)')").
 *
 * The author follows the same rules as attributed rows
 * (docs/design/actor-identity-and-remote-clients.md §3.3, "Git authorship"):
 *
 *   - a request from a person (a member's token) — that person, via
 *     {@link runWithGitAuthor} around the request;
 *   - an agent's tool call — the turn owner recorded on the session, via the
 *     same scope around the MCP call;
 *   - everything else — the daemon's registered fallback
 *     ({@link setGitAuthorFallback}), which answers with the configured system
 *     identity (the service credential's owner in Teams, git config on a
 *     laptop) or, in managed mode with neither, a lazy-worded refusal.
 *
 * The committer is the same person: lazy invents no identity of its own. The
 * answer rides the git call as GIT_AUTHOR_* / GIT_COMMITTER_* env — nothing is
 * ever written into a repository's or the host's git config, because a global
 * fallback there would attribute every member's commit to one account.
 *
 * Zero imports on purpose: `runGit` reads this, and the resolution itself
 * (managed mode, the service credential) is registered by the daemon rather
 * than imported, so the git chokepoint does not pull the daemon in.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface GitAuthor {
  email: string;
  name?: string;
}

/**
 * What the fallback answers: an author, a refusal to show instead of running
 * git, or null — leave git to its own config (a laptop with no scope, which is
 * exactly the behaviour before this existed).
 */
export type GitAuthorAnswer = { author: GitAuthor } | { refusal: string } | null;

const scope = new AsyncLocalStorage<GitAuthor>();
let fallback: (() => Promise<GitAuthorAnswer>) | null = null;

/** Run `fn` with every commit-creating git write inside it authored by `author`. */
export function runWithGitAuthor<T>(author: GitAuthor | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!author?.email) return fn();
  return scope.run({ email: author.email, ...(author.name ? { name: author.name } : {}) }, fn);
}

/** Register (or clear, with null) the answer for git writes outside any scope. The daemon registers one at startup. */
export function setGitAuthorFallback(resolver: (() => Promise<GitAuthorAnswer>) | null): void {
  fallback = resolver;
}

/** git subcommands that create a commit and therefore need an author. */
const COMMIT_CREATING = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'commit-tree', 'am', 'rebase', 'pull']);

/**
 * Leaving an operation in progress, or a fast-forward, creates nothing; it must
 * never be refused for want of an author.
 */
const NON_CREATING_FLAGS = new Set(['--abort', '--quit', '--skip', '--ff-only']);

/** `git tag` needs a tagger only for a tag OBJECT (annotated or signed); a lightweight tag is just a ref. */
const TAG_OBJECT_FLAGS = new Set(['-a', '--annotate', '-m', '--message', '-F', '--file', '-s', '--sign', '-u', '--local-user']);

/** `git stash` subcommands that write stash commits; a bare `git stash` is `push`. */
const STASH_CREATING = new Set(['push', 'save']);

function createsCommit(args: readonly string[]): boolean {
  let subIndex = -1;
  for (let i = 0; i < args.length; i++) {
    // `-c key=value` / `-C dir` take their value as the next argument.
    if (args[i] === '-c' || args[i] === '-C') { i++; continue; }
    if (!args[i].startsWith('-')) { subIndex = i; break; }
  }
  if (subIndex < 0) return false;
  const sub = args[subIndex];
  const rest = args.slice(subIndex + 1);
  if (sub === 'tag') return rest.some((a) => TAG_OBJECT_FLAGS.has(a) || /^(--message|--file|--local-user)=/.test(a));
  if (sub === 'stash') {
    const action = rest.find((a) => !a.startsWith('-'));
    return action === undefined || STASH_CREATING.has(action);
  }
  if (!COMMIT_CREATING.has(sub)) return false;
  return !rest.some((a) => NON_CREATING_FLAGS.has(a));
}

/** The env that names `author` as both author and committer. */
export function gitAuthorEnv(author: GitAuthor): Record<string, string> {
  const name = author.name?.trim() || author.email;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

/**
 * For `runGit`: the env to add to this git call, a refusal to return instead of
 * running it, or null to change nothing (not a commit-creating call, or no
 * answer on an install whose own git config still decides).
 */
export async function resolveGitAuthorForArgs(
  args: readonly string[],
): Promise<{ env: Record<string, string> } | { refusal: string } | null> {
  if (!createsCommit(args)) return null;
  const scoped = scope.getStore();
  if (scoped) return { env: gitAuthorEnv(scoped) };
  if (!fallback) return null;
  const answer = await fallback();
  if (!answer) return null;
  if ('refusal' in answer) return answer;
  return { env: gitAuthorEnv(answer.author) };
}

/**
 * Shown when a managed daemon would otherwise let git guess. The same family
 * as the actor-identity refusal ("Please tell me who you are"), with the
 * remedy that applies on a managed host: nobody's git config is involved.
 */
export const GIT_AUTHOR_REFUSAL = [
  'Commit author unknown.',
  '',
  '*** Please tell me who you are.',
  '',
  'lazy names the author of every commit it makes: the member who asked for the',
  'work, or — for work the daemon started by itself — the owner of the',
  "project's service credential. Neither is known for this write, so lazy did",
  'not run git. Set the project\'s service credential (its owner becomes the',
  'author of automated commits), or run the action as a signed-in member.',
].join('\n');
