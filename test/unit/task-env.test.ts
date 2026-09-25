/**
 * Per-task environment variables — validation, storage placement, and the
 * argv/redaction seams.
 *
 * The security properties this feature exists for are asserted here directly:
 * the file lives in the daemon dir (never the project, which every task
 * container bind-mounts read-only), it is 0600, reserved keys cannot be
 * hijacked, and a value never reaches a debug log line.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, stat, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

import {
  setTaskEnv,
  getTaskEnv,
  listTaskEnvKeys,
  unsetTaskEnv,
  clearTaskEnv,
  buildTaskEnvArgs,
  parseEnvAssignment,
  parseEnvFile,
  validateTaskEnvKey,
  isReservedEnvKey,
  MAX_VARS_PER_TASK,
} from '../../src/daemon/task-env';
import { getTaskEnvPath } from '../../src/daemon/paths';
import { redactSecrets } from '../../src/utils/redact';
import { buildSupervisorDockerArgs } from '../../src/capture/claude';

describe('per-task env: key validation', () => {
  test('accepts ordinary POSIX names', () => {
    for (const key of ['STRIPE_API_KEY', 'API_BASE', '_PRIVATE', 'X1']) {
      expect(() => validateTaskEnvKey(key)).not.toThrow();
    }
  });

  test('rejects malformed names with actionable text', () => {
    for (const key of ['', '1ABC', 'A-B', 'A B', 'A=B', 'lower.case']) {
      expect(() => validateTaskEnvKey(key)).toThrow(/Invalid environment variable name/);
    }
  });

  // INVARIANT: a task may never override the variables lazy itself sets on the
  // agent. Allowing ANTHROPIC_BASE_URL or LAZY_DAEMON_CONFIG through would turn
  // "give this task a token" into "redirect this task's model traffic" — a
  // privilege escalation, not a convenience. Refused at intake so the user sees
  // it when they type it, not as a broken launch three turns later.
  test('rejects keys lazy owns', () => {
    for (const key of [
      'PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'GIT_SSH_COMMAND', 'CLAUDECODE',
      'LAZY_DAEMON_CONFIG', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_ENTRYPOINT', 'CURSOR_API_KEY',
    ]) {
      expect(isReservedEnvKey(key)).toBe(true);
      expect(() => validateTaskEnvKey(key)).toThrow(/reserved by lazy/);
    }
  });

  test('reserved matching is case-insensitive (env lookup on some platforms is not)', () => {
    expect(isReservedEnvKey('anthropic_api_key')).toBe(true);
    expect(isReservedEnvKey('Path')).toBe(true);
  });
});

describe('per-task env: parsing', () => {
  test('splits on the FIRST = so values may contain =', () => {
    expect(parseEnvAssignment('TOKEN=abc=def==')).toEqual({ key: 'TOKEN', value: 'abc=def==' });
  });

  test('strips matched surrounding quotes so a copied .env line works', () => {
    expect(parseEnvAssignment('TOKEN="sk-1 2"').value).toBe('sk-1 2');
    expect(parseEnvAssignment("TOKEN='sk-1 2'").value).toBe('sk-1 2');
    // Unmatched quotes are part of the value — guessing would corrupt a secret.
    expect(parseEnvAssignment('TOKEN="sk-1').value).toBe('"sk-1');
  });

  test('rejects a spec with no = or an empty key', () => {
    expect(() => parseEnvAssignment('TOKEN')).toThrow(/expected KEY=VALUE/);
    expect(() => parseEnvAssignment('=value')).toThrow(/expected KEY=VALUE/);
  });

  // INVARIANT: no error message ever quotes the spec. Two malformed shapes can
  // carry the whole secret — '=sk-secret' (empty key) and a bare token pasted
  // alone on an env-file line (no '=' at all) — so echoing the raw spec back
  // would print the user's token to their terminal, and into whatever captured
  // that output, from a plain typo.
  test('malformed specs are described, never echoed', () => {
    for (const spec of ['=sk-secret-value', 'sk-secret-value']) {
      expect(() => parseEnvAssignment(spec)).toThrow(/expected KEY=VALUE/);
      try {
        parseEnvAssignment(spec);
      } catch (err) {
        expect((err as Error).message).not.toContain('sk-secret-value');
      }
    }
  });

  test('parses a dotenv-style file, ignoring comments and blanks', () => {
    const vars = parseEnvFile(
      [
        '# a comment',
        '',
        'TOKEN=sk-123',
        'export API_BASE=https://x.test',
        '   SPACED=yes   ',
      ].join('\n'),
      '/tmp/task.env',
    );
    expect(vars).toEqual({ TOKEN: 'sk-123', API_BASE: 'https://x.test', SPACED: 'yes' });
  });

  test('a bad line names the file and line number', () => {
    expect(() => parseEnvFile('GOOD=1\nnonsense\n', '/tmp/task.env'))
      .toThrow(/\/tmp\/task\.env:2/);
  });
});

describe('per-task env: store', () => {
  let base: string;
  let root: string;
  let prevBaseDir: string | undefined;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'lazy-taskenv-'));
    root = join(base, 'project');
    await mkdir(root, { recursive: true });
    prevBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = join(base, 'daemon-base');
  });

  afterEach(async () => {
    if (prevBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = prevBaseDir;
    await rm(base, { recursive: true, force: true });
  });

  // INVARIANT: every task container bind-mounts the project root read-only, so
  // a secret written under <project>/.lazy would be readable by every OTHER
  // task's agent — the exact isolation this feature provides. The registry must
  // live in the daemon's own state dir, which is never mounted anywhere.
  test('the registry lives in the daemon dir, never under the project', async () => {
    await setTaskEnv(root, 'task-1', { TOKEN: 'sk-secret' });
    const path = getTaskEnvPath(root);
    expect(path.startsWith(process.env.LAZY_DAEMON_BASE_DIR!)).toBe(true);
    expect(path.includes(root)).toBe(false);
    expect(dirname(path).includes('.lazy/tasks')).toBe(false);
  });

  test('the registry file is 0600', async () => {
    await setTaskEnv(root, 'task-1', { TOKEN: 'sk-secret' });
    const st = await stat(getTaskEnvPath(root));
    expect(st.mode & 0o777).toBe(0o600);
  });

  test('set/get/list round-trips, and list never exposes values', async () => {
    const keys = await setTaskEnv(root, 'task-1', { B_TOKEN: 'two', A_TOKEN: 'one' });
    expect(keys).toEqual(['A_TOKEN', 'B_TOKEN']);
    expect(await getTaskEnv(root, 'task-1')).toEqual({ A_TOKEN: 'one', B_TOKEN: 'two' });
    expect(await listTaskEnvKeys(root, 'task-1')).toEqual(['A_TOKEN', 'B_TOKEN']);
  });

  test('a second set merges rather than replacing', async () => {
    await setTaskEnv(root, 'task-1', { A: '1' });
    await setTaskEnv(root, 'task-1', { B: '2' });
    expect(await getTaskEnv(root, 'task-1')).toEqual({ A: '1', B: '2' });
    await setTaskEnv(root, 'task-1', { A: 'updated' });
    expect((await getTaskEnv(root, 'task-1')).A).toBe('updated');
  });

  test('tasks do not see each other, which is the whole point', async () => {
    await setTaskEnv(root, 'task-1', { TOKEN: 'mine' });
    expect(await getTaskEnv(root, 'task-2')).toEqual({});
  });

  test('unset removes only named keys and reports what it removed', async () => {
    await setTaskEnv(root, 'task-1', { A: '1', B: '2' });
    expect(await unsetTaskEnv(root, 'task-1', ['A', 'NOPE'])).toEqual(['A']);
    expect(await getTaskEnv(root, 'task-1')).toEqual({ B: '2' });
    expect(await unsetTaskEnv(root, 'task-1', ['NOPE'])).toEqual([]);
  });

  test('clear empties a task and is idempotent', async () => {
    await setTaskEnv(root, 'task-1', { A: '1', B: '2' });
    expect(await clearTaskEnv(root, 'task-1')).toBe(2);
    expect(await getTaskEnv(root, 'task-1')).toEqual({});
    expect(await clearTaskEnv(root, 'task-1')).toBe(0);
  });

  test('a missing registry reads as empty (the common case)', async () => {
    expect(await getTaskEnv(root, 'never-set')).toEqual({});
  });

  // A registry that exists but does not parse is a broken state, not an empty
  // one: treating it as empty would launch the agent without the token it needs
  // and surface as an unexplained 401 inside the container.
  test('a corrupt registry throws instead of reading as empty', async () => {
    const path = getTaskEnvPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not json', { mode: 0o600 });
    await expect(getTaskEnv(root, 'task-1')).rejects.toThrow(/not valid JSON/);
  });

  test('the per-task variable cap is enforced', async () => {
    const vars: Record<string, string> = {};
    for (let i = 0; i <= MAX_VARS_PER_TASK; i++) vars[`K_${i}`] = 'v';
    await expect(setTaskEnv(root, 'task-1', vars)).rejects.toThrow(/limit 64/);
  });

  test('reserved keys are refused by the store, not only by the CLI', async () => {
    await expect(setTaskEnv(root, 'task-1', { ANTHROPIC_API_KEY: 'x' }))
      .rejects.toThrow(/reserved by lazy/);
    // Nothing partial was written.
    expect(await getTaskEnv(root, 'task-1')).toEqual({});
  });

  test('concurrent sets do not lose writes', async () => {
    await Promise.all([
      setTaskEnv(root, 'task-1', { A: '1' }),
      setTaskEnv(root, 'task-1', { B: '2' }),
      setTaskEnv(root, 'task-1', { C: '3' }),
    ]);
    expect(await listTaskEnvKeys(root, 'task-1')).toEqual(['A', 'B', 'C']);
  });
});

describe('per-task env: docker argv', () => {
  test('builds sorted -e pairs', () => {
    expect(buildTaskEnvArgs({ B: '2', A: '1' })).toEqual(['-e', 'A=1', '-e', 'B=2']);
    expect(buildTaskEnvArgs({})).toEqual([]);
  });

  // `docker run` only honours -e BEFORE the image name; anything after it is
  // the container's own command line. A regression that moved these would look
  // fine in a diff and silently deliver no variable at all.
  test('supervisor argv places -e pairs before the image name', () => {
    const args = buildSupervisorDockerArgs({
      binary: 'docker',
      containerName: 'lazy-task-1',
      imageName: 'lazy-runner:test',
      repoRoot: '/repo',
      sandbox: { permission_mode: 'bypass' } as never,
      protocolDir: '/protocol',
      agentBinaryPath: '/usr/local/bin/lazy-agent',
      authEnvVars: [],
      customMountArgs: [],
      gitMountArgs: [],
      publishArgs: [],
      runArgs: [],
      taskEnvArgs: buildTaskEnvArgs({ TASK_TOKEN: 'sk-secret' }),
      wrapperScript: 'echo hi',
    });
    const envIdx = args.indexOf('TASK_TOKEN=sk-secret');
    const imageIdx = args.indexOf('lazy-runner:test');
    expect(envIdx).toBeGreaterThan(-1);
    expect(args[envIdx - 1]).toBe('-e');
    expect(imageIdx).toBeGreaterThan(envIdx);
  });

  // INVARIANT: per-task env can only ADD to the agent's environment, never
  // redirect lazy's own. `docker run` resolves a repeated -e by last-one-wins,
  // so the task's pairs must come BEFORE lazy's auth vars — earlier is lower
  // precedence. Reserved names are refused at intake; this is the second line
  // of defense, and it mirrors the host-process runner, which spreads the task
  // env before its own auth vars for exactly the same reason.
  test('task env pairs come before lazy auth env pairs', () => {
    const args = buildSupervisorDockerArgs({
      binary: 'docker',
      containerName: 'lazy-task-1',
      imageName: 'lazy-runner:test',
      repoRoot: '/repo',
      sandbox: { permission_mode: 'bypass' } as never,
      protocolDir: '/protocol',
      agentBinaryPath: '/usr/local/bin/lazy-agent',
      authEnvVars: [{ key: 'ANTHROPIC_BASE_URL', value: 'https://lazy.example' }],
      customMountArgs: [],
      gitMountArgs: [],
      publishArgs: [],
      runArgs: [],
      taskEnvArgs: buildTaskEnvArgs({ TASK_TOKEN: 'sk-secret' }),
      wrapperScript: 'echo hi',
    });
    const taskIdx = args.indexOf('TASK_TOKEN=sk-secret');
    const authIdx = args.indexOf('ANTHROPIC_BASE_URL=https://lazy.example');
    expect(taskIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeLessThan(authIdx);
    // GIT_SSH_COMMAND is set after both for the same last-one-wins reason.
    expect(args.findIndex(a => typeof a === 'string' && a.startsWith('GIT_SSH_COMMAND=')))
      .toBeGreaterThan(taskIdx);
  });
});

describe('per-task env: redaction', () => {
  // A per-task value is a secret regardless of what it is CALLED: a user may
  // name it STRIPE_SANDBOX rather than STRIPE_API_KEY, and the name-shape
  // heuristic would let that value through into a debug line verbatim.
  test('alwaysRedactKeys redacts values whose names look harmless', () => {
    const argv = ['docker', 'run', '-e', 'STRIPE_SANDBOX=sk-live-abc', '-e', 'OTHER=fine'];
    const out = redactSecrets(argv, ['STRIPE_SANDBOX']);
    expect(out.join(' ')).not.toContain('sk-live-abc');
    expect(out).toContain('OTHER=fine');
  });

  test('the name-shape heuristic still applies without an explicit list', () => {
    const out = redactSecrets(['-e', 'SOME_TOKEN=abc123']);
    expect(out.join(' ')).not.toContain('abc123');
  });
});
