/**
 * Whether a task's container was LAUNCHED holding a session placeholder — the
 * one fact about its credential env that a later turn cannot change.
 *
 * A team-mode turn hands its supervisor the turn's placeholder with the command
 * (`session_credential_env`, src/supervisor/turn-credential-env.ts), and the
 * supervisor swaps it into the agent's env. That swap only REPLACES a session
 * placeholder the container already holds: it never adds one to a container
 * launched without (a codex or cursor task must not be handed an Anthropic
 * credential by a command). So a container created under SOLO billing — the
 * daemon's own credential, as a JIT grant — and still running when the project
 * switched to member billing cannot serve a member's turn: the agent keeps the
 * solo grant and the proxy refuses it (`auth_kind_mismatch`). That container
 * must be recreated, and this record is how the reuse check knows.
 *
 * Recorded at every container/supervisor launch, next to the task-env
 * fingerprint and for the same reason: env is fixed at create. Keyed by task
 * and RUN NAME, because a task's review and accept-gate containers launch with
 * the task's id too and must not stand in for the work container.
 *
 * Lives in the daemon's state dir, outside Storage: it is per-machine container
 * state, meaningless anywhere else, and dropped when the task ends. Bounded by
 * the task's run names (work, review, gate).
 */

import { readFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { getDaemonDir } from './paths';
import { writePrivateFileAtomic } from '../utils/fs';
import { isWorkRunName } from '../task/turn-run-image';
import { logger } from '../utils/logger';

/** `session`: launched holding a session placeholder; `other`: launched without one. */
export type LaunchedCredential = 'session' | 'other';

interface LaunchFile {
  version: 1;
  /** taskId -> runName -> what that run was launched with. */
  tasks: Record<string, Record<string, LaunchedCredential>>;
}

function filePath(projectRoot: string): string {
  return join(getDaemonDir(projectRoot), 'container-credential-launch.json');
}

async function load(projectRoot: string): Promise<LaunchFile> {
  const path = filePath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, tasks: {} };
    throw new Error(`Failed to read the container credential-launch record ${path}: ${(err as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LaunchFile>;
    return { version: 1, tasks: parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {} };
  } catch (err) {
    throw new Error(`The container credential-launch record ${path} is not valid JSON (${(err as Error).message}).`);
  }
}

let writeChain: Promise<unknown> = Promise.resolve();

async function mutate(projectRoot: string, fn: (file: LaunchFile) => boolean): Promise<void> {
  const run = writeChain.then(async () => {
    const file = await load(projectRoot);
    if (!fn(file)) return;
    const path = filePath(projectRoot);
    await mkdir(dirname(path), { recursive: true });
    await writePrivateFileAtomic(path, JSON.stringify(file));
  });
  writeChain = run.catch(() => undefined);
  return run;
}

/** Record what a run of this task is being launched with. Called by the runners at launch. */
export async function recordContainerCredentialLaunch(
  projectRoot: string,
  taskId: string,
  runName: string,
  launched: LaunchedCredential,
): Promise<void> {
  await mutate(projectRoot, (file) => {
    const runs = { ...(file.tasks[taskId] ?? {}) };
    let changed = runs[runName] !== launched;
    runs[runName] = launched;
    // A task has ONE work container at a time: a work launch supersedes every
    // other work-run entry, so a stale 'other' under a name no longer in use
    // can never force a recreate of the container that replaced it.
    if (isWorkRunName(runName)) {
      for (const name of Object.keys(runs)) {
        if (name !== runName && isWorkRunName(name)) {
          delete runs[name];
          changed = true;
        }
      }
    }
    if (!changed) return false;
    file.tasks[taskId] = runs;
    return true;
  });
}

/**
 * True when this task's WORK container — the one work-run entry a work launch
 * leaves (recordContainerCredentialLaunch drops the others) — is recorded as
 * launched WITHOUT a session placeholder. False when it holds one, or when nothing is recorded
 * (every launch records, so "nothing" is a container from before this record
 * existed — and no container survives the daemon restart that upgrade implies).
 *
 * An unreadable record answers true: the caller recreates, and a recreate is
 * the direction that cannot run a turn on the wrong credential.
 */
export async function workContainerLaunchedWithoutSessionPlaceholder(projectRoot: string, taskId: string): Promise<boolean> {
  let file: LaunchFile;
  try {
    file = await load(projectRoot);
  } catch (err) {
    // See the doc comment: recreate rather than guess which credential it holds.
    logger.error(`Cannot tell what task ${taskId}'s container was launched with; recreating it: ${(err as Error).message}`);
    return true;
  }
  const runs = Object.entries(file.tasks[taskId] ?? {}).filter(([name]) => isWorkRunName(name));
  return runs.some(([, launched]) => launched === 'other');
}

/** The task ended: drop its record. Idempotent. */
export async function forgetContainerCredentialLaunches(projectRoot: string, taskId: string): Promise<void> {
  await mutate(projectRoot, (file) => {
    if (!file.tasks[taskId]) return false;
    delete file.tasks[taskId];
    return true;
  });
}
