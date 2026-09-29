/**
 * Per-task env values (`lazy env set`) are secrets whatever they are NAMED, so
 * they must be scrubbed from free text — daemon logs, the supervisor's log, and
 * agent turn text — and must not ride `docker run`'s argv, where `ps` shows them.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, stat, readFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  setTaskEnv,
  unsetTaskEnv,
  clearTaskEnv,
  primeTaskEnvRedaction,
  planTaskEnvLaunchFile,
  taskEnvKeysEnv,
} from '../../src/daemon/task-env';
import { getDaemonDir, getTaskEnvPath } from '../../src/daemon/paths';
import { redactSecretValues, setRegisteredSecretValues, TASK_ENV_KEYS_VAR, REDACTED } from '../../src/utils/redact';
import { writeFile } from 'fs/promises';

const VALUE = 'stripe-sandbox-value-0123456789';

let base: string;
let root: string;
let prevBaseDir: string | undefined;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'lazy-taskenv-redact-'));
  root = join(base, 'project');
  await mkdir(root, { recursive: true });
  prevBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
  process.env.LAZY_DAEMON_BASE_DIR = join(base, 'daemon-base');
});

afterEach(async () => {
  setRegisteredSecretValues('task-env', []);
  if (prevBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
  else process.env.LAZY_DAEMON_BASE_DIR = prevBaseDir;
  await rm(base, { recursive: true, force: true });
});

describe('per-task env: free-text scrubbing', () => {
  // INVARIANT: a value set with `lazy env set` is scrubbed from every free-text
  // log line and turn from the moment it is set. Its key (here STRIPE_SANDBOX)
  // matches no credential name shape, so without registration it went to log
  // files and turn text verbatim.
  test('a set value is scrubbed; an unset or cleared one no longer is', async () => {
    await setTaskEnv(root, 'task-1', { STRIPE_SANDBOX: VALUE });
    expect(redactSecretValues(`agent echoed ${VALUE} here`)).toBe(`agent echoed ${REDACTED} here`);

    await unsetTaskEnv(root, 'task-1', ['STRIPE_SANDBOX']);
    expect(redactSecretValues(`x ${VALUE}`)).toBe(`x ${VALUE}`);

    await setTaskEnv(root, 'task-2', { OTHER: VALUE });
    await clearTaskEnv(root, 'task-2');
    expect(redactSecretValues(`x ${VALUE}`)).toBe(`x ${VALUE}`);
  });

  // A restarted daemon has not read the registry yet, but a task's container
  // may still be running with the value — priming at start covers that window.
  test('priming registers values already on disk', async () => {
    const path = getTaskEnvPath(root);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, tasks: { t: { STRIPE_SANDBOX: VALUE } } }), { mode: 0o600 });
    expect(redactSecretValues(VALUE)).toBe(VALUE);
    await primeTaskEnvRedaction(root);
    expect(redactSecretValues(VALUE)).toBe(REDACTED);
  });

  // The supervisor is a separate process with no access to the registry; it
  // learns WHICH of its env vars are per-task from LAZY_TASK_ENV_KEYS.
  test('a process launched with LAZY_TASK_ENV_KEYS scrubs those values', () => {
    const prevKeys = process.env[TASK_ENV_KEYS_VAR];
    process.env.STRIPE_SANDBOX_TEST_ONLY = VALUE;
    process.env[TASK_ENV_KEYS_VAR] = 'STRIPE_SANDBOX_TEST_ONLY';
    try {
      expect(redactSecretValues(`v=${VALUE}`)).toBe(`v=${REDACTED}`);
    } finally {
      delete process.env.STRIPE_SANDBOX_TEST_ONLY;
      if (prevKeys === undefined) delete process.env[TASK_ENV_KEYS_VAR];
      else process.env[TASK_ENV_KEYS_VAR] = prevKeys;
    }
  });

  test('keys env names keys, never values', () => {
    expect(taskEnvKeysEnv({ B: VALUE, A: 'x' })).toEqual({ [TASK_ENV_KEYS_VAR]: 'A,B' });
    expect(taskEnvKeysEnv({})).toEqual({});
  });
});

describe('per-task env: docker --env-file delivery', () => {
  // INVARIANT: per-task values never appear in `docker run`'s argv (readable by
  // any local user via `ps`); they go through a 0600 file in the daemon dir that
  // exists only while `docker run` does.
  test('values go in a 0600 env file, not argv, and cleanup removes it', async () => {
    const plan = planTaskEnvLaunchFile(root, 'lazy-task-1', { STRIPE_SANDBOX: VALUE });
    expect(plan.args.join(' ')).not.toContain(VALUE);
    expect(plan.args[0]).toBe('--env-file');
    const path = plan.args[1];
    expect(path.startsWith(getDaemonDir(root))).toBe(true);
    expect(plan.args).toContain(`${TASK_ENV_KEYS_VAR}=STRIPE_SANDBOX`);

    await plan.write();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf-8')).toBe(`STRIPE_SANDBOX=${VALUE}\n`);

    await plan.cleanup();
    await expect(access(path)).rejects.toThrow();
  });

  // Docker's env-file format has no escapes, so a value with a line break
  // cannot go there; it keeps the argv route rather than being corrupted.
  test('a multi-line value falls back to -e argv', () => {
    const plan = planTaskEnvLaunchFile(root, 'lazy-task-1', { CERT: 'a\nb', TOKEN_X: VALUE });
    expect(plan.args).toContain('CERT=a\nb');
    expect(plan.args.join(' ')).not.toContain(VALUE);
  });

  test('no env means no file and no args', () => {
    expect(planTaskEnvLaunchFile(root, 'lazy-task-1', {}).args).toEqual([]);
  });
});

describe('per-task env: agent turn text', () => {
  // INVARIANT: turn rows are durable and human-visible; an agent that echoes its
  // own per-task token must not record it for good.
  test('an agent turn row is written with set values scrubbed', async () => {
    const { createRecoveredAgentTurn } = await import('../../src/daemon/turn-owner');
    await setTaskEnv(root, 'task-1', { STRIPE_SANDBOX: VALUE });
    const written: Array<{ content: string }> = [];
    const storage = { createTurn: async (o: { content: string }) => { written.push(o); return o; } };
    await createRecoveredAgentTurn(
      storage as never,
      { sessionId: 's', sequence: 1, role: 'agent', content: `my token is ${VALUE}` } as never,
      null,
    );
    expect(written[0].content).toBe(`my token is ${REDACTED}`);
  });
});

describe('per-task env: container reuse', () => {
  // INVARIANT: a running container is reused only when it was created with the
  // task's CURRENT env; any set/unset since then forces a recreate, because env
  // is fixed at container creation.
  test('changes since the recorded launch force a recreate', async () => {
    const { recordTaskEnvLaunched, mustRecreateForTaskEnv, getTaskEnv } = await import('../../src/daemon/task-env');
    expect(await mustRecreateForTaskEnv(root, 't', 'lazy-t')).toBe(false); // none set, none launched

    await setTaskEnv(root, 't', { A_TOKEN: 'one' });
    expect(await mustRecreateForTaskEnv(root, 't', 'lazy-t')).toBe(true);
    await recordTaskEnvLaunched(root, 't', 'lazy-t', await getTaskEnv(root, 't'));
    expect(await mustRecreateForTaskEnv(root, 't', 'lazy-t')).toBe(false);

    await setTaskEnv(root, 't', { A_TOKEN: 'two' });
    expect(await mustRecreateForTaskEnv(root, 't', 'lazy-t')).toBe(true);
    await recordTaskEnvLaunched(root, 't', 'lazy-t', await getTaskEnv(root, 't'));

    await unsetTaskEnv(root, 't', ['A_TOKEN']);
    expect(await mustRecreateForTaskEnv(root, 't', 'lazy-t')).toBe(true);
    await recordTaskEnvLaunched(root, 't', 'lazy-t', {});
    expect(await mustRecreateForTaskEnv(root, 't', 'lazy-t')).toBe(false);
  });

  test('the fingerprint file never holds a value outside the 0600 registry', async () => {
    const { recordTaskEnvLaunched } = await import('../../src/daemon/task-env');
    await setTaskEnv(root, 't', { A_TOKEN: VALUE });
    await recordTaskEnvLaunched(root, 't', 'lazy-t', { A_TOKEN: VALUE });
    const raw = JSON.parse(await readFile(getTaskEnvPath(root), 'utf-8'));
    expect(JSON.stringify(raw.launched)).not.toContain(VALUE);
    await clearTaskEnv(root, 't');
    const after = JSON.parse(await readFile(getTaskEnvPath(root), 'utf-8'));
    expect(after.launched.t).toBeUndefined();
  });
});

describe('per-task env: reuse is decided per run', () => {
  // INVARIANT: review and accept-gate containers are launched with the task's id
  // too; recording their env must not make a stale WORK container look current.
  test('a review launch does not mask a stale work container', async () => {
    const { recordTaskEnvLaunched, mustRecreateForTaskEnv } = await import('../../src/daemon/task-env');
    await setTaskEnv(root, 't', { A_TOKEN: 'one' });
    await recordTaskEnvLaunched(root, 't', 'lazy-t', { A_TOKEN: 'one' });
    await setTaskEnv(root, 't', { A_TOKEN: 'two' });
    await recordTaskEnvLaunched(root, 't', 'lazy-review-t', { A_TOKEN: 'two' });
    expect(await mustRecreateForTaskEnv(root, 't', 'lazy-t')).toBe(true);
  });

  test('an unreadable registry answers recreate instead of throwing', async () => {
    const { mustRecreateForTaskEnv } = await import('../../src/daemon/task-env');
    const path = getTaskEnvPath(root);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '{ nope', { mode: 0o600 });
    expect(await mustRecreateForTaskEnv(root, 't', 'lazy-t')).toBe(true);
  });

  test('a very long value keeps the argv route', () => {
    const big = 'x'.repeat(70 * 1024);
    const plan = planTaskEnvLaunchFile(root, 'lazy-t', { BIG: big, TOKEN_X: VALUE });
    expect(plan.args).toContain(`BIG=${big}`);
    expect(plan.args.join(' ')).not.toContain(VALUE);
  });

  test('daemon start removes launch files a crash left behind', async () => {
    const plan = planTaskEnvLaunchFile(root, 'lazy-t', { TOKEN_X: VALUE });
    await plan.write();
    await primeTaskEnvRedaction(root);
    await expect(access(plan.args[1])).rejects.toThrow();
  });
});
