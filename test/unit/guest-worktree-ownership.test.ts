/**
 * The ownership contract between a ROOT daemon and its uid-1000 task container,
 * on a real Linux dockerd (the Teams microVM guest), exercised with real
 * uids, real git and the real `adopt` step of the supervisor wrapper.
 *
 * INVARIANT: on a Linux host where the daemon runs as root, (1) the files a
 * task container writes — its worktree, its per-worktree gitdir and the
 * objects dir — end up writable by the container's uid, and (2) the daemon's
 * own git (lazy_commit, lazy_final, turn-end commit recording) still accepts
 * that worktree afterwards. Docker Desktop fakes bind-mount ownership, so
 * neither half was ever exercised on a Mac; in the microVM the first half held
 * and the second did not, and every task that wrote a file lost lazy_commit
 * and lazy_final to git's "detected dubious ownership" — a two-sided wall no
 * retry could get past.
 *
 * Needs Linux, a non-root test uid and passwordless sudo (the container this
 * repo's agents run in has all three). Anywhere else it skips, loudly.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { buildSupervisorWrapperScript, supervisorWritablePaths } from '../../src/capture/claude';
import { adoptBeforeCommand, hasForeignEntries, taskWritablePaths, realignOwnershipArgv } from '../../src/utils/worktree-ownership';

const IMAGE_GITCONFIG = join(import.meta.dir, '..', '..', 'lazy-teams', 'deploy', 'daemon-image', 'gitconfig');

function run(argv: string[], cwd?: string) {
  const r = spawnSyncUnsupervised(argv, { cwd, timeout: 30_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const canRun =
  process.platform === 'linux' &&
  typeof process.getuid === 'function' &&
  process.getuid() !== 0 &&
  run(['sudo', '-n', 'true']).code === 0;

if (!canRun) {
  console.log('SKIP guest-worktree-ownership: needs Linux, a non-root uid and passwordless sudo');
}

/**
 * git as the guest daemon: root, with no SUDO_UID (sudo sets it, and git would
 * then judge ownership against the invoking uid — which is exactly the uid the
 * worktree was handed to, so the bug would be invisible), no global config,
 * and the given system config.
 */
function rootGit(systemConfig: string, args: string[]) {
  return run(['sudo', 'env', '-u', 'SUDO_UID', 'GIT_CONFIG_GLOBAL=/dev/null',
    `GIT_CONFIG_SYSTEM=${systemConfig}`, 'git', ...args]);
}

/** The `adopt` function exactly as the supervisor wrapper ships it. */
function adoptFunction(): string {
  const lines = buildSupervisorWrapperScript('/p', '/w', ['/x']).split('\n');
  const start = lines.indexOf('adopt() {');
  const end = lines.indexOf('}', start);
  expect(start).toBeGreaterThan(-1);
  return lines.slice(start, end + 1).join('\n');
}

describe.skipIf(!canRun)('root daemon + uid-1000 task container share a worktree', () => {
  let root: string;
  let repo: string;
  let wt: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-guest-own-')));
    repo = join(root, 'repo');
    wt = join(root, 'wt');
    // The guest daemon clones and adds worktrees as root.
    const setup = run(['sudo', 'env', '-u', 'SUDO_UID', 'GIT_CONFIG_GLOBAL=/dev/null', 'sh', '-c',
      `git init -q -b main '${repo}' && cd '${repo}' && ` +
      `git -c user.email=d@x -c user.name=d commit -q --allow-empty -m init && ` +
      `git worktree add -q '${wt}' -b task`]);
    expect(setup.err).toBe('');
    expect(setup.code).toBe(0);
  });

  afterAll(async () => {
    if (root) run(['sudo', 'rm', '-rf', root]);
  });

  test('adopt makes the worktree writable by the agent, and the daemon git still accepts it', async () => {
    // Premise: before adoption the agent cannot write the root-owned worktree.
    await expect(writeFile(join(wt, 'README.md'), 'x')).rejects.toThrow(/EACCES/);

    const gitDir = join(repo, '.git', 'worktrees', 'wt');
    const paths = supervisorWritablePaths({
      protocolDir: join(root, 'no-protocol-dir'),
      worktreePath: wt,
      objectsDir: join(repo, '.git', 'objects'),
      worktreeGitDir: gitDir,
    }).filter((p) => p.startsWith(root));
    const quoted = paths.map((p) => `'${p}'`).join(' ');
    const adopt = run(['sh', '-c', `${adoptFunction()}\nadopt ${quoted}`]);
    expect(adopt.err).toBe('');

    // The agent edits and stages, as it does mid-turn.
    await writeFile(join(wt, 'README.md'), 'edited by the agent\n');
    const add = run(['git', 'add', 'README.md'], wt);
    expect(add.err).toBe('');
    expect(add.code).toBe(0);

    // The bug: a root daemon with no trust configured refuses the adopted worktree.
    const refused = rootGit('/dev/null', ['-C', wt, 'rev-parse', 'HEAD']);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('detected dubious ownership');

    // The fix: with the daemon image's /etc/gitconfig, lazy_commit's commit and
    // lazy_final's HEAD read both work.
    const commit = rootGit(IMAGE_GITCONFIG, ['-C', wt, '-c', 'user.email=d@x', '-c', 'user.name=d',
      'commit', '-q', '-m', 'agent edit']);
    expect(commit.err).toBe('');
    expect(commit.code).toBe(0);
    const head = rootGit(IMAGE_GITCONFIG, ['-C', wt, 'log', '-1', '--format=%s']);
    expect(head.out.trim()).toBe('agent edit');

    // Whether the agent can stage straight after that commit depends on which
    // objects fan-out dirs the root commit happened to create, so no claim is
    // made here — the next test covers daemon writes and the re-adopt.
  });

  // INVARIANT: whatever the root daemon writes into an adopted worktree between
  // supervisor passes (a sync merge, a conflict it leaves for the agent, a new
  // objects fan-out dir) is handed back before the next command runs — or the
  // agent cannot edit the very files it was asked to resolve.
  test('a root merge leaves files the agent cannot write, until the pre-command adopt', async () => {
    // Upstream moves README.md; the task branch changed it too (previous test).
    const onMain = run(['sudo', 'env', '-u', 'SUDO_UID', 'GIT_CONFIG_GLOBAL=/dev/null', `GIT_CONFIG_SYSTEM=${IMAGE_GITCONFIG}`, 'sh', '-c',
      `cd '${repo}' && printf 'upstream\\n' > README.md && git add README.md && ` +
      `git -c user.email=d@x -c user.name=d commit -q -m upstream-readme`]);
    expect(onMain.err).toBe('');
    // The daemon merges it into the task worktree, as root; it conflicts.
    const merge = rootGit(IMAGE_GITCONFIG, ['-C', wt, '-c', 'user.email=d@x', '-c', 'user.name=d',
      'merge', 'main']);
    expect(merge.code).not.toBe(0);
    expect(merge.out + merge.err).toContain('CONFLICT');

    await expect(writeFile(join(wt, 'README.md'), 'resolved\n')).rejects.toThrow(/EACCES/);

    expect(await adoptBeforeCommand(wt)).toBeNull();

    await writeFile(join(wt, 'README.md'), 'resolved\n');
    const add = run(['git', 'add', 'README.md'], wt);
    expect(add.err).toBe('');
    expect(add.code).toBe(0);
    expect(await hasForeignEntries(await taskWritablePaths(wt), process.getuid!())).toBe(false);
  });
});

// INVARIANT: adopt hands back only what lazy's root-run daemon left behind
// (uid 0). A directory a task's own service owns — Postgres's data dir, mode
// 0700, owner postgres — keeps its owner and mode across every turn. The old
// rule chowned -R anything the container user could not write, and on the
// first turn after a Teams engineer moved Postgres data into the worktree
// Postgres lost access to its own files ("could not open file
// global/pg_filenode.map: Permission denied").
describe.skipIf(!canRun)('a service-owned data dir in the worktree survives every turn', () => {
  const PG_UID = 70; // postgres in the official alpine image; any non-root uid that is not ours
  let root: string;
  let repo: string;
  let wt: string;
  let pg: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-pg-own-')));
    repo = join(root, 'repo');
    wt = join(root, 'wt');
    pg = join(wt, '.lazy', 'run-data', 'postgres');
    // The root daemon clones and adds the worktree (a real one, so the
    // supervisor's pass resolves its git dirs); Postgres, as its own uid,
    // writes its data inside it.
    const setup = run(['sudo', 'env', '-u', 'SUDO_UID', 'GIT_CONFIG_GLOBAL=/dev/null', 'sh', '-c',
      `git init -q -b main '${repo}' && cd '${repo}' && ` +
      `git -c user.email=d@x -c user.name=d commit -q --allow-empty -m init && ` +
      `git worktree add -q '${wt}' -b task && ` +
      `mkdir -p '${pg}/global' && echo map > '${pg}/global/pg_filenode.map' && ` +
      `chown -R ${PG_UID}:${PG_UID} '${pg}' && chmod 700 '${pg}' && echo hi > '${wt}/README.md'`]);
    expect(setup.err).toBe('');
    expect(setup.code).toBe(0);
  });

  afterAll(async () => {
    if (root) run(['sudo', 'rm', '-rf', root]);
  });

  function owners(): string {
    return run(['sudo', 'sh', '-c', `stat -c '%u %a' '${pg}' '${pg}/global' '${pg}/global/pg_filenode.map'`]).out;
  }

  test('three turns of adopt, the supervisor pass and a root-daemon realign leave it untouched', async () => {
    const before = owners();
    expect(before).toBe(`${PG_UID} 700\n${PG_UID} 755\n${PG_UID} 644\n`);
    const uid = process.getuid!();
    const gid = process.getgid!();
    // What the wrapper adopts: the worktree and its two git dirs.
    const wrapperPaths = [wt, join(repo, '.git', 'worktrees', 'wt'), join(repo, '.git', 'objects')].map((x) => `'${x}'`).join(' ');
    for (let turn = 0; turn < 3; turn++) {
      // The PID-1 wrapper's adopt, before the supervisor starts.
      const adopt = run(['sh', '-c', `${adoptFunction()}\nadopt ${wrapperPaths}`]);
      expect(adopt.err).toBe('');
      const paths = await taskWritablePaths(wt);
      // The supervisor's pass before each command.
      expect(await adoptBeforeCommand(wt)).toBeNull();
      // The root daemon's realign after a tool call that wrote into the worktree.
      const realign = run(['sudo', ...realignOwnershipArgv(paths, uid, gid, false)]);
      expect(realign.err).toBe('');
      expect(realign.code).toBe(0);
      expect(owners()).toBe(before);
    }
    // The root-owned file lazy's daemon left IS taken back.
    await writeFile(join(wt, 'README.md'), 'agent edit\n');
  });
});

describe('realignment argv', () => {
  // INVARIANT: only entries NOT already owned by the target uid are chowned,
  // and symlinks themselves (-h), never their targets — a root daemon following
  // an agent-planted symlink would chown anything on the machine.
  // Only ROOT-owned entries are taken, and a directory owned by any third
  // user (a postgres data dir) is pruned whole — never chowned, never entered.
  test('root daemon: no sudo, -h, root-owned only, foreign dirs pruned', () => {
    expect(realignOwnershipArgv(['/w', '/g'], 1000, 1000, false)).toEqual(
      ['find', '/w', '/g', '(', '!', '-uid', '0', '!', '-uid', '1000', '-type', 'd', '-prune', ')',
        '-o', '(', '-uid', '0', '-exec', 'chown', '-h', '1000:1000', '{}', '+', ')']);
  });
  test('container user: through sudo -n', () => {
    expect(realignOwnershipArgv(['/w'], 1000, 1000, true).slice(0, 3)).toEqual(['sudo', '-n', 'find']);
  });
});
