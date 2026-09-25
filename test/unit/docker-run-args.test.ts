/**
 * `[docker] run_args` — extra `docker run` arguments for task containers.
 *
 * Covers the three properties that make the key safe to ship:
 * - argv assembly: the args land verbatim, in order, immediately before the
 *   image name — docker flags, never a new image or command;
 * - boundary validation: anything that is not an array of non-empty strings is
 *   rejected loudly, naming the key and the offending value;
 * - root anchoring: the value comes from the PROJECT ROOT's lazy.toml, never a
 *   task worktree's copy.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSupervisorDockerArgs, resolveDockerRunArgs } from '../../src/capture/claude';
import { loadConfig } from '../../src/config/loader';

function argsWith(runArgs: string[]): string[] {
  return buildSupervisorDockerArgs({
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
    taskEnvArgs: [],
    runArgs,
    wrapperScript: 'echo hi',
  });
}

describe('[docker] run_args in the container create argv', () => {
  test('args appear verbatim and in order', () => {
    const args = argsWith(['--cap-add=SYS_PTRACE', '--security-opt', 'seccomp=unconfined']);
    const i = args.indexOf('--cap-add=SYS_PTRACE');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('--security-opt');
    expect(args[i + 2]).toBe('seccomp=unconfined');
  });

  test('args come immediately before the image name — flags to docker, never a new image or command', () => {
    const args = argsWith(['--cap-add=SYS_PTRACE']);
    const image = args.indexOf('lazy-runner:test');
    expect(args.indexOf('--cap-add=SYS_PTRACE')).toBe(image - 1);
  });

  // INVARIANT: a project with no run_args launches exactly as it did before
  // this key existed. Opting out must cost nothing — not even an argument.
  test('no run_args leaves the argv byte-identical', () => {
    expect(argsWith([])).toEqual(argsWith([]));
    expect(argsWith([]).join(' ')).not.toContain('--cap-add');
  });
});

describe('[docker] run_args config validation', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-run-args-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeConfig(dockerSection: string): Promise<void> {
    await writeFile(join(root, 'lazy.toml'), `[docker]\n${dockerSection}\n`, 'utf-8');
  }

  test('parses a valid array of strings', async () => {
    await writeConfig('run_args = ["--cap-add=SYS_PTRACE"]');
    const config = await loadConfig(root);
    expect(config.docker.run_args).toEqual(['--cap-add=SYS_PTRACE']);
  });

  test('defaults to empty when unset', async () => {
    await writeConfig('dockerfile = ""');
    const config = await loadConfig(root);
    expect(config.docker.run_args).toEqual([]);
  });

  test('rejects a non-array, naming the key and the value', async () => {
    await writeConfig('run_args = "--cap-add=SYS_PTRACE"');
    expect(loadConfig(root)).rejects.toThrow(
      /run_args in lazy\.toml \[docker\] section.*"--cap-add=SYS_PTRACE"/s,
    );
  });

  test('rejects an empty-string entry, naming the key and the value', async () => {
    await writeConfig('run_args = ["--cap-add=SYS_PTRACE", " "]');
    expect(loadConfig(root)).rejects.toThrow(
      /run_args entry " " in lazy\.toml \[docker\] section/,
    );
  });

  test('rejects non-string entries', async () => {
    await writeConfig('run_args = [3]');
    expect(loadConfig(root)).rejects.toThrow(
      /run_args entry 3 in lazy\.toml \[docker\] section/,
    );
  });
});

describe('[docker] run_args root anchoring', () => {
  let root: string;
  let worktree: string;
  let originalCwd: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-run-args-root-'));
    worktree = join(root, '.lazy', 'worktrees', 'some-task');
    await mkdir(worktree, { recursive: true });
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: run_args come from the PROJECT ROOT's lazy.toml, never a task
  // worktree's copy. Task branches are agent-writable — a worktree lazy.toml
  // that could add `--privileged` or a host bind mount would let an agent
  // escalate its own next container. Same reasoning as image resolution
  // (see "Task worktrees never auto-govern container images" in CLAUDE.md).
  test('a worktree lazy.toml with run_args is ignored', async () => {
    await writeFile(join(root, 'lazy.toml'), '[docker]\nrun_args = ["--cap-add=SYS_PTRACE"]\n', 'utf-8');
    await writeFile(join(worktree, 'lazy.toml'), '[docker]\nrun_args = ["--privileged"]\n', 'utf-8');

    // The dangerous posture: the launching process happens to run with its cwd
    // inside the task worktree, which is where the config load used to start.
    process.chdir(worktree);

    const runArgs = await resolveDockerRunArgs(root);
    expect(runArgs).toEqual(['--cap-add=SYS_PTRACE']);
    expect(runArgs).not.toContain('--privileged');
  });

  // The anchoring now lives in loadConfig itself (see findConfigDir), so a
  // worktree copy is invisible to EVERY key, not just this one. Asserted here
  // too: run_args must not regress if that general rule is ever loosened.
  test('loadConfig itself never sees the worktree copy', async () => {
    await writeFile(join(root, 'lazy.toml'), '[docker]\n', 'utf-8');
    await writeFile(join(worktree, 'lazy.toml'), '[docker]\nrun_args = ["--privileged"]\n', 'utf-8');

    process.chdir(worktree);

    expect((await loadConfig(root)).docker.run_args).toEqual([]);
    expect(await resolveDockerRunArgs(root)).toEqual([]);
  });
});
