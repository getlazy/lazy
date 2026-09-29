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

import { createHash } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { getDaemonDir, getTaskEnvPath } from './paths';
import { setRegisteredSecretValues, TASK_ENV_KEYS_VAR } from '../utils/redact';
import { logger } from '../utils/logger';

/**
 * Keep the free-text scrubber's view of per-task values equal to the file.
 *
 * Called on every read and write of the registry, so the daemon's logger (and
 * everything else that goes through redactSecretValues — turn text included)
 * scrubs a value from the moment it is set until the moment it is unset or the
 * task ends. The registry is bounded by the caps below, so the scrub set is too.
 */
function registerForRedaction(registry: TaskEnvFile): void {
  setRegisteredSecretValues(
    'task-env',
    Object.values(registry.tasks).flatMap(vars => Object.values(vars)),
  );
}

/** On-disk shape. Keyed by full task UUID, mirroring the token registry. */
interface TaskEnvFile {
  version: 1;
  /** taskId -> { KEY: VALUE }. */
  tasks: Record<string, Record<string, string>>;
  /**
   * taskId -> runName -> fingerprint of the env that run (container or host
   * supervisor) was launched with (see taskEnvFingerprint). Absent = none.
   * Keyed by RUN, not task: a task's review and accept-gate containers are
   * launched with the task's id too, and must not stand in for the work run.
   */
  launched?: Record<string, Record<string, string>>;
}

/**
 * Caps. Values reach docker through an env file (argv for multi-line or very
 * long values — see planTaskEnvLaunchFile); more importantly an unbounded secret file
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
      return { version: 1, tasks: {}, launched: {} };
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
  const launched: Record<string, Record<string, string>> = {};
  for (const [id, runs] of Object.entries(parsed.launched ?? {})) {
    if (runs && typeof runs === 'object') launched[id] = runs;
  }
  const registry: TaskEnvFile = { version: 1, tasks: parsed.tasks, launched };
  registerForRedaction(registry);
  return registry;
}

async function persist(projectRoot: string, registry: TaskEnvFile): Promise<void> {
  const path = getTaskEnvPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  // 0600: these are user secrets. Same posture as the token files next to it.
  await writeFile(path, JSON.stringify(registry, null, 2), { mode: 0o600 });
  registerForRedaction(registry);
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
 * that hands out values; it exists for the launch path (the docker env file /
 * the host spawn env) and nothing else. Empty object when the task has none, which
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

/**
 * Load the registry once so every value in it is registered with the free-text
 * scrubber. Called at daemon start; every later read and write re-registers.
 */
export async function primeTaskEnvRedaction(projectRoot: string): Promise<void> {
  // A launch file outlives its `docker run` only if the daemon died mid-launch;
  // no launch is in flight at start, so every one left is stale and holds values.
  await rm(launchFileDir(projectRoot), { recursive: true, force: true });
  await loadRegistry(projectRoot);
}

function launchFileDir(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'task-env-launch');
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
    const runs = Object.keys(registry.launched?.[taskId] ?? {});
    // Belt to the finally in the launcher: a crashed launch's file goes with the task.
    await Promise.all(runs.map(run => rm(launchFilePath(projectRoot, run), { force: true })));
    if (count === 0 && runs.length === 0) return 0;
    delete registry.tasks[taskId];
    delete registry.launched?.[taskId];
    await persist(projectRoot, registry);
    return count;
  });
}

/**
 * `['-e', 'KEY=VALUE', ...]` for `docker run` — the argv shape, which launches
 * now use only for values an env file cannot carry (planTaskEnvLaunchFile). Sorted so the argv is stable and
 * diffable in tests. Pure — takes the already-read values, so the argv builder
 * stays inspectable without touching the filesystem.
 */
export function buildTaskEnvArgs(vars: Record<string, string>): string[] {
  return Object.keys(vars)
    .sort()
    .flatMap(key => ['-e', `${key}=${vars[key]}`]);
}

/**
 * `{ LAZY_TASK_ENV_KEYS: 'A,B' }` — tells the launched supervisor which of its
 * env vars are per-task values so ITS log scrubber covers them too (it has no
 * access to this file). Key names only. Empty when the task has none.
 */
export function taskEnvKeysEnv(vars: Record<string, string>): Record<string, string> {
  const keys = Object.keys(vars).sort();
  return keys.length > 0 ? { [TASK_ENV_KEYS_VAR]: keys.join(',') } : {};
}

/**
 * Deliver a task's env to `docker run` through a 0600 `--env-file` in the
 * daemon's own state dir instead of `-e KEY=VALUE` argv, so the values are not
 * in the host process table (`ps`) while docker runs. The caller MUST call
 * `write()` just before spawning `docker run` and `cleanup()` once it has
 * exited, success or not. Planning is pure, so the argv can be built (and
 * tested) before anything touches the filesystem.
 *
 * What this does NOT hide: `docker inspect <container>` still shows every
 * value for the container's life — env is part of a container's config, and
 * no delivery mechanism changes that. Anyone who can reach the docker socket
 * can read it.
 *
 * Docker's env-file format is one literal `KEY=VALUE` per line with no quoting
 * or escapes, so a value containing a line break cannot be written there, and
 * the docker CLI reads it with a line scanner capped at 64 KiB; such values are
 * passed as `-e` argv, as every value was before.
 *
 * The file is not a mount — docker reads it on the host — so the daemon dir
 * still never enters a container (test/unit/daemon-dir-never-mounted.test.ts).
 */
/** Below the docker CLI's 64 KiB env-file line limit, with headroom. */
const MAX_ENV_FILE_LINE_BYTES = 60 * 1024;

function launchFilePath(projectRoot: string, runName: string): string {
  return join(launchFileDir(projectRoot), `${runName}.env`);
}

export function planTaskEnvLaunchFile(
  projectRoot: string,
  runName: string,
  vars: Record<string, string>,
): { args: string[]; write: () => Promise<void>; cleanup: () => Promise<void> } {
  const keys = Object.keys(vars).sort();
  const argvOnly = (k: string) =>
    /[\r\n]/.test(vars[k]) || Buffer.byteLength(`${k}=${vars[k]}`, 'utf-8') > MAX_ENV_FILE_LINE_BYTES;
  const lineSafe = keys.filter(k => !argvOnly(k));
  const multiLine = keys.filter(argvOnly);
  const keysArgs = Object.entries(taskEnvKeysEnv(vars)).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const argvArgs = multiLine.flatMap(k => ['-e', `${k}=${vars[k]}`]);
  if (lineSafe.length === 0) {
    return { args: [...argvArgs, ...keysArgs], write: async () => {}, cleanup: async () => {} };
  }
  const dir = launchFileDir(projectRoot);
  const path = launchFilePath(projectRoot, runName);
  return {
    args: ['--env-file', path, ...argvArgs, ...keysArgs],
    write: async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path, lineSafe.map(k => `${k}=${vars[k]}\n`).join(''), { mode: 0o600 });
    },
    cleanup: () => rm(path, { force: true }),
  };
}

/**
 * Stable fingerprint of a task's env. Stored only in this same 0600 file, next
 * to the values themselves, so it discloses nothing the file does not.
 */
export function taskEnvFingerprint(vars: Record<string, string>): string {
  const canonical = JSON.stringify(Object.keys(vars).sort().map(k => [k, vars[k]]));
  return createHash('sha256').update(canonical).digest('hex');
}

const EMPTY_FINGERPRINT = taskEnvFingerprint({});

/**
 * Record the env a task's container/supervisor is being launched with. Called
 * by the runners at the one point that reads the values for a launch.
 */
export async function recordTaskEnvLaunched(
  projectRoot: string,
  taskId: string,
  runName: string,
  vars: Record<string, string>,
): Promise<void> {
  const fingerprint = taskEnvFingerprint(vars);
  await mutate(projectRoot, async registry => {
    const launched = registry.launched ?? {};
    const runs = { ...(launched[taskId] ?? {}) };
    if ((runs[runName] ?? EMPTY_FINGERPRINT) === fingerprint) return;
    if (fingerprint === EMPTY_FINGERPRINT) delete runs[runName];
    else runs[runName] = fingerprint;
    if (Object.keys(runs).length === 0) delete launched[taskId];
    else launched[taskId] = runs;
    registry.launched = launched;
    await persist(projectRoot, registry);
  });
}

/**
 * Whether a RUNNING container/supervisor for this task was launched with a
 * different env than the task has now.
 *
 * Env is fixed when a container is created and launch paths reuse a running
 * one, so without this a `lazy env set` made while the container was alive
 * never reached a later turn. Every reuse site asks this and recreates on true;
 * the new container simply carries the new values (no notice is sent).
 *
 * An unreadable registry answers true rather than throwing: the reuse sites run
 * outside the launch's revert-on-failure guard, and a recreate re-reads the
 * registry inside it, where the same error fails the launch loudly.
 */
export async function mustRecreateForTaskEnv(
  projectRoot: string,
  taskId: string,
  runName: string,
): Promise<boolean> {
  let registry: TaskEnvFile;
  try {
    registry = await loadRegistry(projectRoot);
  } catch (err) {
    logger.error(`Cannot check task ${taskId}'s environment for container reuse; recreating: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
  const launched = registry.launched?.[taskId]?.[runName] ?? EMPTY_FINGERPRINT;
  return launched !== taskEnvFingerprint(registry.tasks[taskId] ?? {});
}
