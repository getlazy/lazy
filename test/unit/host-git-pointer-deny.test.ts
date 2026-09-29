/**
 * INVARIANT: on the host-process runner in `permission_mode = "sandbox"`, an
 * agent cannot write what decides the code the next git OUTSIDE its sandbox
 * runs — its worktree's git pointers (`<worktree>/.git`, `<gitdir>/commondir`,
 * `<gitdir>/gitdir`), the common `config` and `hooks`, and every other task
 * worktree's pointers — neither from Bash (`sandbox.filesystem.denyWrite`) nor
 * with its file tools (`permissions.deny`, plus a Write deny on the whole
 * common git dir). There is no container mount to hold them read-only there
 * (docs/design/git-pointer-boundary.md). The rules are added per worktree by
 * the supervisor, from pointers it has validated first; a tampered worktree
 * gets no agent. Merge-conflict agents carry the same sandbox as work agents.
 *
 * INVARIANT: the common dir itself is NOT an Edit or sandbox deny. Claude Code
 * turns Edit denies into read-only binds for Bash, and Bash must keep writing
 * the index and objects there for `git add`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyGitPointerDenies,
  buildAgentSandboxArgs,
  buildSandboxSettings,
  withGitPointerDenyArgs,
  withGitPointerDenies,
  PROBE_GIT_POINTERS,
  type HostPermissionConfig,
} from '../../src/runner/host-sandbox';
import { hostGitPointerDenyPaths, GitPointerTamperError } from '../../src/git/worktree-pointers';
import { addGitPointerDenies } from '../../src/supervisor/index';
import { buildMergeAgentArgs } from '../../src/supervisor/merge';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { agentSettingsJson, boundaryFingerprint } from '../../src/runner/host-boundary-guard';
import type { Command } from '../../src/protocol/types';

const SANDBOX: HostPermissionConfig = {
  mode: 'sandbox',
  allowedDomains: ['*.anthropic.com'],
  allowWeakerNested: false,
  denyRead: [],
  denyWrite: [],
};

const PATHS = {
  protectedPaths: ['/p/wt/.git', '/p/.git/worktrees/wt/commondir', '/p/.git/worktrees/wt/gitdir', '/p/.git/config', '/p/.git/hooks'],
  commonDirs: ['/p/.git'],
};

describe('the git-pointer deny rules', () => {
  test('Bash: every protected path is a sandbox denyWrite, the common dir is not', () => {
    const s = buildSandboxSettings(SANDBOX, false);
    applyGitPointerDenies(s, PATHS);
    const denyWrite = (s.sandbox.filesystem as { denyWrite: string[] }).denyWrite;
    expect(denyWrite).toEqual(PATHS.protectedPaths);
    expect(denyWrite).not.toContain('/p/.git');
  });

  test('file tools: Write and Edit denied on protected paths; Write only on the common dir', () => {
    const s = buildSandboxSettings(SANDBOX, false);
    applyGitPointerDenies(s, PATHS);
    for (const p of PATHS.protectedPaths) {
      for (const tool of ['Write', 'Edit']) {
        expect(s.permissions.deny).toContain(`${tool}(/${p})`);
        expect(s.permissions.deny).toContain(`${tool}(/${p}/**)`);
      }
    }
    expect(s.permissions.deny).toContain('Write(//p/.git/**)');
    expect(s.permissions.deny).not.toContain('Edit(//p/.git/**)');
  });

  test('the project posture is kept whole, not replaced', () => {
    const before = buildSandboxSettings(SANDBOX, false);
    const after = JSON.parse(withGitPointerDenies(JSON.stringify(before), PATHS));
    for (const rule of before.permissions.deny) expect(after.permissions.deny).toContain(rule);
    expect(after.sandbox.filesystem.denyRead).toEqual((before.sandbox.filesystem as { denyRead: string[] }).denyRead);
    expect(after.sandbox.allowUnsandboxedCommands).toBe(false);
  });

  test('args without a host --settings (container, bypass) are untouched', () => {
    expect(withGitPointerDenyArgs(undefined, PATHS)).toBeUndefined();
    expect(withGitPointerDenyArgs([], PATHS)).toEqual([]);
    expect(withGitPointerDenyArgs(buildAgentSandboxArgs({ ...SANDBOX, mode: 'bypass' }), PATHS)).toEqual([]);
  });

  test('the guard probes the same rules on placeholder paths', () => {
    const json = withGitPointerDenies(JSON.stringify(buildSandboxSettings(SANDBOX, false)), PROBE_GIT_POINTERS);
    expect(json).toContain('/__lazy_probe_worktree__/.git');
    expect(json).toContain('/__lazy_probe_gitdir__/gitdir');
    expect(json).toContain('/__lazy_probe_common__/config');
    expect(json).toContain('Write(//__lazy_probe_common__/**)');
  });

  // INVARIANT: a cached guard verdict covers only what was probed, so the
  // probed pointer posture and the probe script key the cache too.
  test('the guard fingerprint covers more than version, platform and project settings', () => {
    const s = agentSettingsJson(SANDBOX)!;
    const bare = createHash('sha256').update(`1.0.0\0linux\0${s}`).digest('hex').slice(0, 16);
    expect(boundaryFingerprint('1.0.0', 'linux', s)).not.toBe(bare);
  });

  test('a merge-conflict agent carries the host sandbox args', () => {
    const extra = withGitPointerDenyArgs(buildAgentSandboxArgs(SANDBOX), PATHS)!;
    const args = buildMergeAgentArgs(new ClaudeCodeAgent(), 'resolve', 'm', undefined, false, undefined, extra);
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings.sandbox.filesystem.denyWrite).toContain('/p/.git/worktrees/wt/gitdir');
  });
});

describe('per-worktree resolution and the supervisor hook', () => {
  let base: string;
  let repo: string;
  let worktree: string;
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (args: string[], cwd: string) => {
    const r = Bun.spawnSync(['git', ...args], { cwd, env });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  };

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'host-ptr-')));
    repo = join(base, 'repo');
    await mkdir(repo);
    git(['init', '-q', '-b', 'main'], repo);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], repo);
    worktree = join(repo, '.lazy', 'worktrees', 'some-task');
    git(['worktree', 'add', '-q', '-b', 'lazy/some-task', worktree], repo);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test('a task worktree resolves to its pointers, the common config and hooks', async () => {
    const paths = await hostGitPointerDenyPaths(worktree);
    const gitdir = join(repo, '.git', 'worktrees', 'some-task');
    expect(paths).not.toBeNull();
    expect(paths!.protectedPaths).toEqual(expect.arrayContaining([
      join(worktree, '.git'), join(gitdir, 'commondir'), join(gitdir, 'gitdir'),
      join(repo, '.git', 'config'), join(repo, '.git', 'hooks'),
    ]));
    expect(paths!.commonDirs).toEqual([join(repo, '.git')]);
  });

  test("another task worktree's pointers are protected too", async () => {
    git(['worktree', 'add', '-q', '-b', 'lazy/other', join(repo, '.lazy', 'worktrees', 'other')], repo);
    const paths = await hostGitPointerDenyPaths(worktree);
    const other = join(repo, '.git', 'worktrees', 'other');
    expect(paths!.protectedPaths).toEqual(expect.arrayContaining([
      join(other, 'commondir'), join(other, 'gitdir'), join(other, 'config.worktree'),
    ]));
  });

  test('a symlinked project root gets both spellings', async () => {
    const link = join(base, 'link');
    await symlink(repo, link);
    const paths = await hostGitPointerDenyPaths(join(link, '.lazy', 'worktrees', 'some-task'));
    expect(paths!.commonDirs).toEqual(expect.arrayContaining([join(repo, '.git'), join(link, '.git')]));
    expect(paths!.protectedPaths).toEqual(expect.arrayContaining([
      join(link, '.git', 'config'), join(repo, '.git', 'config'),
      join(link, '.lazy', 'worktrees', 'some-task', '.git'), join(worktree, '.git'),
    ]));
  });

  test('a directory that is not a task worktree has nothing to deny', async () => {
    expect(await hostGitPointerDenyPaths(repo)).toBeNull();
  });

  test('the supervisor adds the denies to the command before any agent runs', async () => {
    const cmd = { type: 'start', agent_extra_args: buildAgentSandboxArgs(SANDBOX) } as unknown as Command;
    await addGitPointerDenies(cmd, worktree);
    const args = (cmd as { agent_extra_args: string[] }).agent_extra_args;
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings.sandbox.filesystem.denyWrite).toContain(join(repo, '.git', 'worktrees', 'some-task', 'gitdir'));
    expect(settings.permissions.deny).toContain(`Write(/${join(repo, '.git')}/**)`);
  });

  test('a tampered worktree gets no agent, with a refusal naming the task and the repair', async () => {
    await writeFile(join(repo, '.git', 'worktrees', 'some-task', 'commondir'), join(base, 'evil') + '\n');
    const cmd = { type: 'sync', agent_extra_args: buildAgentSandboxArgs(SANDBOX) } as unknown as Command;
    const err = await addGitPointerDenies(cmd, worktree).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GitPointerTamperError);
    expect((err as Error).message).toContain('some-task');
    expect((err as Error).message).toContain('lazy doctor --repair-git-pointers');
  });

  test('a container command (no --settings) is left alone, even on a tampered worktree', async () => {
    await writeFile(join(worktree, '.git'), 'gitdir: /elsewhere\n');
    const cmd = { type: 'start' } as unknown as Command;
    await addGitPointerDenies(cmd, worktree);
    expect((cmd as { agent_extra_args?: string[] }).agent_extra_args).toBeUndefined();
  });
});
