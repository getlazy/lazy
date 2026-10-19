/**
 * The environment every NEW task starts with — variables and secret files a
 * control plane (Lazy Teams) wants on every task of the project, its `always`
 * entries.
 *
 * WHY THE DAEMON HOLDS IT
 * -----------------------
 * Teams pushes a task's environment (`taskEnv` / `taskFiles`) before the
 * launches IT starts. A task can also be created and started by its cluster's
 * agent (`lazy_create` then `lazy_start`, milliseconds apart), by a builder or
 * from the CLI, and Teams learns of those only afterwards — its first turn
 * would already be running without the environment. No push from outside can
 * win that race, so the daemon copies this seed into a task's own per-task
 * registries at the moment the task is CREATED, in the storage decorator every
 * create flows through (tapTaskEnvSeed). From there the existing per-task
 * machinery — launch injection, file delivery, redaction, clearing at the end —
 * applies unchanged, and Teams reconciles the task's set later as before.
 *
 * Stored next to task-env.json, mode 0600, for the same reason (see
 * task-env.ts): the daemon dir is never mounted into a container. Values are
 * registered with the log scrubber while they are in the seed. Bounded by the
 * same per-task caps, since a seed IS a task's set.
 */

import { mkdir, readFile } from 'fs/promises';
import { writePrivateFileAtomic } from '../utils/fs';
import { dirname } from 'path';
import type { Storage } from '../storage/interface';
import type { Task } from '../types';
import { getTaskEnvSeedPath } from './paths';
import { assertWithinCaps, setTaskEnv, validateTaskEnvKey } from './task-env';
import { normalizeTaskFiles, setTaskFiles } from './task-files';
import { secretStringsForFile } from '../utils/secret-file-strings';
import { assertRegistrableSecretValues, setRegisteredSecretValues } from '../utils/redact';
import { logger } from '../utils/logger';
import { shortId } from '../task/identity';

interface SeedFile {
  version: 1;
  vars: Record<string, string>;
  /** normalized path -> base64 content */
  files: Record<string, string>;
}

const EMPTY: SeedFile = { version: 1, vars: {}, files: {} };

function seedValues(seed: SeedFile): string[] {
  const values = [...Object.values(seed.vars)];
  for (const [path, b64] of Object.entries(seed.files)) values.push(...secretStringsForFile(path, Buffer.from(b64, 'base64').toString('utf-8')));
  return values;
}

let registerFailureLogged = false;

/**
 * Never throws: a seed already on disk that the scrubber cannot hold must not
 * break `list` (Teams calls it before every re-save, so a throw here would make
 * the seed impossible to replace). Intake refuses such a seed up front.
 */
function register(seed: SeedFile): void {
  try {
    setRegisteredSecretValues('task-env-seed', seedValues(seed));
    registerFailureLogged = false;
  } catch (err) {
    if (registerFailureLogged) return;
    registerFailureLogged = true;
    logger.error(`The new-task environment's values cannot all be scrubbed from logs: ${err instanceof Error ? err.message : String(err)}. Re-save the project's environment with fewer or smaller secret files.`);
  }
}

async function load(projectRoot: string): Promise<SeedFile> {
  const path = getTaskEnvSeedPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw new Error(`Failed to read the new-task environment ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: SeedFile;
  try {
    parsed = JSON.parse(raw) as SeedFile;
  } catch (err) {
    throw new Error(`The new-task environment ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Re-save the project's environment in Lazy Teams to rewrite it.`);
  }
  const seed: SeedFile = {
    version: 1,
    vars: parsed && typeof parsed.vars === 'object' && parsed.vars ? parsed.vars : {},
    files: parsed && typeof parsed.files === 'object' && parsed.files ? parsed.files : {},
  };
  register(seed);
  return seed;
}

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Replace the whole seed. Validated exactly like a task's own set, so a seed
 * that would be refused for a task is refused here, when it is pushed, not
 * silently at some later create. `files` is the `taskFiles` input shape.
 * Returns names and paths only.
 */
export async function setTaskEnvSeed(
  projectRoot: string,
  vars: Record<string, string>,
  files: unknown,
): Promise<{ keys: string[]; paths: string[] }> {
  for (const key of Object.keys(vars)) validateTaskEnvKey(key);
  assertWithinCaps(vars, 'new-task environment');
  const normalized = normalizeTaskFiles(files ?? [], 'new-task environment');
  const seed: SeedFile = { version: 1, vars: { ...vars }, files: normalized };
  // Refused BEFORE anything is written, as setTaskFiles does: a seed the
  // scrubber cannot hold would otherwise be stored and fail at every read.
  try {
    assertRegistrableSecretValues('task-env-seed', seedValues(seed));
  } catch (err) {
    throw new Error(
      `The new-task environment holds too many distinct secret values or lines for lazy to scrub from logs and turns ` +
      `(${err instanceof Error ? err.message : String(err)}). Nothing was stored. Use fewer or smaller always-applied secret files.`,
    );
  }
  const run = writeChain.then(async () => {
    const path = getTaskEnvSeedPath(projectRoot);
    await mkdir(dirname(path), { recursive: true });
    // Atomic: a torn seed fails the `list` Teams calls before every re-save,
    // so the control plane could never rewrite it.
    await writePrivateFileAtomic(path, JSON.stringify(seed, null, 2));
    register(seed);
  });
  writeChain = run.catch(() => undefined);
  await run;
  return { keys: Object.keys(seed.vars).sort(), paths: Object.keys(seed.files).sort() };
}

/** Names and paths in the seed — never values. */
export async function listTaskEnvSeed(projectRoot: string): Promise<{ keys: string[]; paths: string[] }> {
  const seed = await load(projectRoot);
  return { keys: Object.keys(seed.vars).sort(), paths: Object.keys(seed.files).sort() };
}

/** Load once at daemon start so seed values are scrubbed from the first log line. */
export async function primeTaskEnvSeedRedaction(projectRoot: string): Promise<void> {
  await load(projectRoot);
}

/**
 * Give a just-created task the seed. Returns what was given (names only).
 * A task's set starts empty, so this never overwrites anything.
 */
export async function applyTaskEnvSeed(projectRoot: string, taskId: string): Promise<{ keys: string[]; paths: string[] }> {
  const seed = await load(projectRoot);
  const keys = Object.keys(seed.vars);
  const paths = Object.keys(seed.files);
  if (keys.length > 0) await setTaskEnv(projectRoot, taskId, seed.vars);
  if (paths.length > 0) {
    await setTaskFiles(projectRoot, taskId, paths.map(path => ({ path, contentsBase64: seed.files[path] })));
  }
  return { keys: keys.sort(), paths: paths.sort() };
}

/**
 * Storage decorator: every task the daemon creates — whichever surface asked —
 * gets the seed before `createTask` returns, so before anything can launch it.
 * A failure is logged and never fails the create: the task exists, and the
 * control plane's reconcile delivers its environment afterwards.
 */
export function tapTaskEnvSeed(storage: Storage, projectRoot: string): Storage {
  return new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop !== 'createTask') {
        void receiver;
        const value = Reflect.get(target, prop, target);
        // Bind to the real target, as parent-child-tap does: through the proxy
        // a backend's private-field access would throw.
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        const created: Task = await (target.createTask as (...a: unknown[]) => Promise<Task>)(...args);
        try {
          await applyTaskEnvSeed(projectRoot, created.id);
        } catch (err) {
          logger.warn(`Task ${shortId(created.id)} was created without the project's new-task environment: ${err instanceof Error ? err.message : String(err)}`);
        }
        return created;
      };
    },
  });
}
