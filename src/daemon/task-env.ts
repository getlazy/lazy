/**
 * Per-task environment variables — give ONE task an API token without exposing
 * it to every other task.
 *
 * WHERE THE VALUES LIVE, AND WHY IT IS NOT STORAGE
 * -----------------------------------------------
 * `~/.lazy/daemon/<slug>/task-env.json`, mode 0600 — the daemon's own state
 * directory, alongside `mcp-tokens.json`, and NEVER under the project root.
 * That placement is the whole security property:
 *
 *  - Task containers bind-mount the project root read-only
 *    (`-v ${repoRoot}:${repoRoot}:ro`, see buildSupervisorDockerArgs), so a
 *    secret stored under `<project>/.lazy/` is readable by EVERY agent — the
 *    exact separation this feature exists to provide.
 *  - The daemon dir is never mounted into anything: the mount builder refuses
 *    sources inside it (assertSourceOutsideDaemonState) and
 *    test/unit/daemon-dir-never-mounted.test.ts asserts the supervisor argv
 *    never exposes it.
 *
 * It is deliberately NOT behind the Storage interface. Storage is for
 * persistent domain objects that must survive and TRAVEL with the project —
 * they are pushed to an external store and could one day live on Postgres. A
 * task's API token must do neither. Values also never enter task state, turns,
 * prompts, comments or the journal: those are durable and human-visible, and a
 * token leaked into a turn is unrecoverable. Same carve-out reasoning as the
 * proxy audit log in CLAUDE.md, with the two conditions that carve-out demands:
 * bounded by construction (MAX_VARS_PER_TASK / MAX_TOTAL_BYTES) and disposable
 * (losing the file costs the user one `lazy env set`).
 *
 * LIFETIME
 * --------
 * Set once; the value persists for the task's lifetime and is injected at
 * EVERY launch — start, unblock, sync, ask, and daemon-initiated auto-resume —
 * then deleted when the task reaches a terminal state, next to the task's MCP
 * token (see revokeTaskTokens in src/daemon/task-lifecycle.ts).
 *
 * The alternative — require `--env` on every unblock — was rejected: launches
 * the human never types (auto-resume, queue drain, the reconciler) would get no
 * value, so the var would silently vanish mid-task and the agent would fail in
 * a way that looks like a bug in the user's own code. The accepted cost is that
 * the value sits at rest in a 0600 host file until the task ends, which is
 * exactly what the per-task MCP token already does.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { getTaskEnvPath } from './paths';

/** On-disk shape. Keyed by full task UUID, mirroring the token registry. */
interface TaskEnvFile {
  version: 1;
  /** taskId -> { KEY: VALUE }. */
  tasks: Record<string, Record<string, string>>;
}

/**
 * Caps. Docker passes each var as a separate `-e KEY=VALUE` argv element and
 * the whole argv shares one ARG_MAX; more importantly an unbounded secret file
 * is not the "bounded by construction" thing the non-Storage carve-out
 * requires. These are far above any legitimate use (a handful of tokens).
 */
export const MAX_VARS_PER_TASK = 64;
export const MAX_TOTAL_BYTES = 128 * 1024;

/** POSIX env var name shape. */
const ENV_KEY_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Keys lazy sets itself on the agent process. Letting a task override one would
 * not be "a per-task variable" — it would be a per-task hijack of where model
 * traffic is pointed (ANTHROPIC_BASE_URL), which credential is used, or how the
 * agent reaches the daemon (LAZY_DAEMON_CONFIG). Rejected at intake so the user
 * finds out when they type it, not from a confusing launch three turns later.
 */
const RESERVED_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TMPDIR',
  'GIT_SSH_COMMAND', 'CLAUDECODE',
]);
const RESERVED_PREFIXES = ['LAZY_', 'ANTHROPIC_', 'CLAUDE_', 'CURSOR_', 'PI_'];

/** True when `key` is one lazy owns and a task may not set. */
export function isReservedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (RESERVED_EXACT.has(upper)) return true;
  return RESERVED_PREFIXES.some(p => upper.startsWith(p));
}

/**
 * Validate one key. Throws with actionable text (fail-loud config style) — the
 * caller surfaces the message verbatim.
 */
export function validateTaskEnvKey(key: string): void {
  if (!ENV_KEY_SHAPE.test(key)) {
    throw new Error(
      `Invalid environment variable name '${key}'. ` +
      `Names must match [A-Za-z_][A-Za-z0-9_]* (e.g. STRIPE_API_KEY).`,
    );
  }
  if (isReservedEnvKey(key)) {
    throw new Error(
      `'${key}' is reserved by lazy and cannot be set per task. ` +
      `Reserved: ${[...RESERVED_EXACT].join(', ')}, and anything starting with ` +
      `${RESERVED_PREFIXES.join(', ')}. These carry the agent's credentials, ` +
      `model routing, and daemon connection — overriding one would break the launch.`,
    );
  }
}

/**
 * Parse a `KEY=VALUE` assignment as typed on the command line or in an env file.
 * Everything after the FIRST `=` is the value, verbatim (values routinely
 * contain `=`); surrounding single/double quotes are stripped, so a line copied
 * out of a `.env` file works as written.
 */
export function parseEnvAssignment(spec: string, where = 'value'): { key: string; value: string } {
  const eq = spec.indexOf('=');
  if (eq < 0) {
    // No '=' at all. A bare token pasted alone on an env-file line lands here,
    // and the whole spec would then BE the secret — so describe the shape
    // rather than quoting it back, same as the empty-key branch below.
    throw new Error(`Invalid ${where}: expected KEY=VALUE, but no '=' was found.`);
  }
  if (eq === 0) {
    // An empty key ('=secret'). Everything after the '=' is the user's value —
    // quoting the raw spec here would print a token to the terminal (and, from
    // an env file, into whatever captured that output). Describe it instead.
    throw new Error(`Invalid ${where}: expected KEY=VALUE, but the name before '=' is empty.`);
  }
  const key = spec.slice(0, eq).trim();
  let value = spec.slice(eq + 1);
  if (value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
       (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  validateTaskEnvKey(key);
  return { key, value };
}

/**
 * Parse a dotenv-style file: `KEY=VALUE` per line, `#` comments and blank lines
 * ignored, an optional leading `export ` stripped. Deliberately minimal — this
 * is the shape every `.env` file already has, and inventing more syntax would
 * mean guessing at the user's intent for a secret.
 */
export function parseEnvFile(text: string, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  text.split('\n').forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    try {
      const { key, value } = parseEnvAssignment(body, 'line');
      out[key] = value;
    } catch (err) {
      throw new Error(`${path}:${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return out;
}

/**
 * Read the registry, tolerating a missing file (nothing has been set yet).
 *
 * A file that EXISTS but does not parse is an error, not an empty result:
 * silently treating it as empty would launch the agent without the token it
 * needs and the failure would surface as an unexplained API 401 inside the
 * container.
 */
async function loadRegistry(projectRoot: string): Promise<TaskEnvFile> {
  const path = getTaskEnvPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, tasks: {} };
    }
    throw new Error(
      `Failed to read per-task env registry ${path}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: TaskEnvFile;
  try {
    parsed = JSON.parse(raw) as TaskEnvFile;
  } catch (err) {
    throw new Error(
      `Per-task env registry ${path} is not valid JSON ` +
      `(${err instanceof Error ? err.message : String(err)}). ` +
      `Delete the file and re-run 'lazy env set' for any task that needs one.`,
    );
  }
  if (!parsed || typeof parsed.tasks !== 'object' || parsed.tasks === null) {
    throw new Error(
      `Per-task env registry ${path} has an unexpected shape ` +
      `(expected { version, tasks: {} }).`,
    );
  }
  return { version: 1, tasks: parsed.tasks };
}

async function persist(projectRoot: string, registry: TaskEnvFile): Promise<void> {
  const path = getTaskEnvPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  // 0600: these are user secrets. Same posture as the token files next to it.
  await writeFile(path, JSON.stringify(registry, null, 2), { mode: 0o600 });
}

/**
 * Serializes read-modify-write cycles within this process.
 *
 * Deliberately uncached, unlike the MCP token registry: that one is on the hot
 * request-verify path, this one is read once per launch. A cache here would
 * also be wrong more often — `lazy env set` may run in a CLI process while the
 * daemon holds the reader, so the authoritative answer is always the file.
 */
let writeChain: Promise<unknown> = Promise.resolve();

async function mutate<T>(
  projectRoot: string,
  fn: (registry: TaskEnvFile) => Promise<T> | T,
): Promise<T> {
  const run = writeChain.then(async () => fn(await loadRegistry(projectRoot)));
  // Keep the chain alive after a rejection, or one failure wedges every later
  // set/unset behind a permanently rejected promise.
  writeChain = run.catch(() => undefined);
  return run;
}

/** Enforce the caps against the post-write state. Throws on violation. */
function assertWithinCaps(vars: Record<string, string>, taskId: string): void {
  const keys = Object.keys(vars);
  if (keys.length > MAX_VARS_PER_TASK) {
    throw new Error(
      `Task ${taskId} would have ${keys.length} environment variables ` +
      `(limit ${MAX_VARS_PER_TASK}). Remove some with 'lazy env unset'.`,
    );
  }
  const bytes = Buffer.byteLength(JSON.stringify(vars), 'utf-8');
  if (bytes > MAX_TOTAL_BYTES) {
    throw new Error(
      `Task ${taskId}'s environment would be ${bytes} bytes ` +
      `(limit ${MAX_TOTAL_BYTES}). Per-task env is for tokens and short values, ` +
      `not file contents — mount a file with [[mounts]] instead.`,
    );
  }
}

/**
 * Set (or overwrite) variables for one task. Returns the resulting key names,
 * sorted — never the values, so a caller cannot accidentally print one.
 */
export async function setTaskEnv(
  projectRoot: string,
  taskId: string,
  vars: Record<string, string>,
): Promise<string[]> {
  for (const key of Object.keys(vars)) validateTaskEnvKey(key);
  return mutate(projectRoot, async registry => {
    const merged = { ...(registry.tasks[taskId] ?? {}), ...vars };
    assertWithinCaps(merged, taskId);
    registry.tasks[taskId] = merged;
    await persist(projectRoot, registry);
    return Object.keys(merged).sort();
  });
}

/**
 * Every variable for one task, as `{ KEY: VALUE }`. This is the ONE function
 * that hands out values; it exists for the launch path (docker `-e` args / the
 * host spawn env) and nothing else. Empty object when the task has none, which
 * is the overwhelmingly common case — behavior is then byte-identical to before
 * this feature existed.
 */
export async function getTaskEnv(
  projectRoot: string,
  taskId: string,
): Promise<Record<string, string>> {
  const registry = await loadRegistry(projectRoot);
  return { ...(registry.tasks[taskId] ?? {}) };
}

/** Key names only, sorted. The read path for anything user-facing. */
export async function listTaskEnvKeys(projectRoot: string, taskId: string): Promise<string[]> {
  return Object.keys(await getTaskEnv(projectRoot, taskId)).sort();
}

/**
 * Remove named variables. Returns the keys actually removed (so the caller can
 * tell the user which of the names they typed were not set). Idempotent.
 */
export async function unsetTaskEnv(
  projectRoot: string,
  taskId: string,
  keys: string[],
): Promise<string[]> {
  return mutate(projectRoot, async registry => {
    const vars = registry.tasks[taskId];
    if (!vars) return [];
    const removed = keys.filter(k => k in vars);
    if (removed.length === 0) return [];
    for (const k of removed) delete vars[k];
    if (Object.keys(vars).length === 0) delete registry.tasks[taskId];
    await persist(projectRoot, registry);
    return removed.sort();
  });
}

/**
 * Drop every variable for one task. Returns how many were removed. Idempotent —
 * called on every terminal transition, including for the vast majority of tasks
 * that never had any.
 */
export async function clearTaskEnv(projectRoot: string, taskId: string): Promise<number> {
  return mutate(projectRoot, async registry => {
    const count = Object.keys(registry.tasks[taskId] ?? {}).length;
    if (count === 0) return 0;
    delete registry.tasks[taskId];
    await persist(projectRoot, registry);
    return count;
  });
}

/**
 * `['-e', 'KEY=VALUE', ...]` for `docker run`. Sorted so the argv is stable and
 * diffable in tests. Pure — takes the already-read values, so the argv builder
 * stays inspectable without touching the filesystem.
 */
export function buildTaskEnvArgs(vars: Record<string, string>): string[] {
  return Object.keys(vars)
    .sort()
    .flatMap(key => ['-e', `${key}=${vars[key]}`]);
}
