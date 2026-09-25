/**
 * The playground repository as the demo's project.
 *
 * The playground is a standalone repository — a small link-shortener app with
 * tests, a lazy.toml, a Dockerfile.lazy and a list of starter tasks — authored
 * in this repo under `playground/` and published by
 * `scripts/publish-playground-repo.sh`. `lazy playground up --repo <url|path>` clones
 * it instead of generating the fixture shop, and creates its starter tasks
 * from the repository's own `tasks.json`.
 *
 * A repository IS the playground exactly when it carries a `tasks.json` of the
 * shape below. Any other repository is still adopted as the project — it just
 * gets no seeded tasks, because the seeded demo states commit fixture files
 * that would be nonsense in somebody else's code.
 */

import { readFile } from 'fs/promises';
import { isAbsolute, join, resolve } from 'path';
import { lazy, run, run$, type LazyInvocation } from './runtime';

/**
 * Where the playground repository is published.
 *
 * NULL UNTIL IT EXISTS. Set this to the public https clone URL once
 * `scripts/publish-playground-repo.sh --push` has pushed it (the intended home
 * is https://github.com/getlazy/playground.git). While null, `lazy playground up`
 * without `--repo` generates the fixture shop exactly as before, and `--fleet`
 * still requires `--repo`.
 */
export const PLAYGROUND_REPO_URL: string | null = null;

/** The task types a starter task may declare — `lazy create --type`'s own list. */
const STARTER_TASK_TYPES = [
  'task', 'fix', 'spike', 'refactor', 'test', 'audit', 'migrate', 'document',
  'tidy', 'rework', 'feature',
] as const;

const CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface StarterTask {
  code: string;
  type: (typeof STARTER_TASK_TYPES)[number];
  goal: string;
  prompt: string;
}

/**
 * Parse and validate a playground `tasks.json`.
 *
 * Strict, because the file comes from a repository somebody else controls and
 * every field ends up on a `lazy create` command line: an unknown version, a
 * malformed code or a duplicate is refused with the entry named, never skipped.
 */
export function parseStarterTasks(text: string, source = 'tasks.json'): StarterTask[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  const doc = data as { version?: unknown; tasks?: unknown };
  if (typeof data !== 'object' || data === null || doc.version !== 1) {
    throw new Error(`${source}: expected {"version": 1, "tasks": [...]}; got version ${JSON.stringify(doc?.version)}`);
  }
  if (!Array.isArray(doc.tasks) || doc.tasks.length === 0) {
    throw new Error(`${source}: "tasks" must be a non-empty array`);
  }

  const seen = new Set<string>();
  return doc.tasks.map((raw, index) => {
    const where = `${source} task #${index + 1}`;
    const entry = raw as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null) throw new Error(`${where}: must be an object`);
    for (const key of ['code', 'type', 'goal', 'prompt'] as const) {
      if (typeof entry[key] !== 'string' || (entry[key] as string).trim() === '') {
        throw new Error(`${where}: "${key}" must be a non-empty string`);
      }
    }
    const code = entry.code as string;
    const type = entry.type as string;
    if (!CODE_PATTERN.test(code)) throw new Error(`${where}: code "${code}" must be lowercase words joined by dashes`);
    if (seen.has(code)) throw new Error(`${where}: code "${code}" appears twice`);
    seen.add(code);
    if (!(STARTER_TASK_TYPES as readonly string[]).includes(type)) {
      throw new Error(`${where}: type "${type}" is not one of ${STARTER_TASK_TYPES.join(', ')}`);
    }
    return { code, type: type as StarterTask['type'], goal: entry.goal as string, prompt: entry.prompt as string };
  });
}

/** The repository's starter tasks, or null when it has no `tasks.json` (not the playground). */
export async function readStarterTasks(repoPath: string): Promise<StarterTask[] | null> {
  const path = join(repoPath, 'tasks.json');
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
  return parseStarterTasks(text, path);
}

/**
 * Clone the project repository to `dest`.
 *
 * Returns false only when `fallbackAllowed` and the clone failed — the default
 * URL being unreachable (offline) falls back to the fixture. A repository the
 * human NAMED that cannot be cloned is an error: silently demoing something
 * else would be the surprise.
 *
 * `origin` is removed afterwards, so the demo project is purely local and no
 * demo command can ever fetch from or push to the repository it came from.
 */
export async function cloneProjectRepo(opts: {
  repo: string;
  dest: string;
  env: Record<string, string>;
  fallbackAllowed: boolean;
  report: (message: string) => void;
}): Promise<boolean> {
  opts.report(`cloning ${opts.repo}`);
  opts.report(
    'commands the repository\'s lazy.toml declares run unsandboxed on this machine when a demo task runs — use repositories you trust',
  );
  const result = await run(
    ['git', '-c', 'credential.helper=', 'clone', '--quiet', '--', opts.repo, opts.dest],
    { cwd: '/', env: { ...opts.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    const reason = result.stderr.trim() || `git exited ${result.code}`;
    if (!opts.fallbackAllowed) {
      throw new Error(`Could not clone ${opts.repo}: ${reason}`);
    }
    opts.report(`could not clone ${opts.repo} (${reason.split('\n')[0]}); using the built-in fixture instead`);
    return false;
  }
  await run$('git remote remove origin', ['git', 'remote', 'remove', 'origin'], { cwd: opts.dest, env: opts.env });
  return true;
}

/**
 * Turn a `--repo` value into something `git clone` can take from any cwd.
 *
 * A URL (`scheme://…`) or scp-style address (`user@host:path`) is returned as
 * is; anything else is a local path and is resolved against `cwd`, because the
 * clone does not run in the directory the human typed it in.
 */
export function resolveRepoSource(repo: string, cwd: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || /^[^/\s]+@[^/\s]+:/.test(repo)) return repo;
  return isAbsolute(repo) ? repo : resolve(cwd, repo);
}

/** Create every starter task in the backlog. None is started: that is the human's move. */
export async function seedStarterTasks(ctx: {
  lazyCmd: LazyInvocation;
  repo: string;
  env: Record<string, string>;
  tasks: StarterTask[];
  report: (message: string) => void;
}): Promise<string[]> {
  for (const task of ctx.tasks) {
    ctx.report(`creating ${task.code}`);
    await lazy(`lazy create ${task.code}`, ctx.lazyCmd, [
      'create', '--code', task.code, '--type', task.type, '--goal', task.goal, '--prompt', task.prompt,
    ], { cwd: ctx.repo, env: ctx.env });
  }
  return ctx.tasks.map(task => task.code);
}
