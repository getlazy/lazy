/**
 * What a project's machine is doing, over the daemon's real wire
 * (docs/design/project-observability.md): a real daemon process, a project
 * whose Dockerfile.lazy fails, and a branch that fixes it.
 *
 * The admin's complaint this answers: confirming "Use Dockerfile.lazy from…"
 * left the page waiting on a request that exported the branch's whole tree
 * with `git archive` before it returned. The export is now a step of the
 * background build — so the adoption must come back while the export is still
 * running, and the export, verify and build must be readable from the build
 * log as they happen.
 *
 * THE SEAM for "the export is still running": git applies a filter driver's
 * smudge command to every file `git archive` writes, and the fix branch
 * carries a `.gitattributes` naming a filter whose command (defined in this
 * repository's own git config, by the test) waits for a file the test creates.
 * Nothing in lazy is told anything — the export genuinely blocks inside git
 * until the test lets it go.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { DaemonClient } from '../../src/daemon/client';
import { getLogPath } from '../../src/daemon/paths';
import { runGit } from '../../src/utils/git';

const BROKEN = 'FROM debian:bookworm-slim\nRUN exit 1\n';
const WORKING = 'FROM debian:bookworm-slim\nRUN true\n';
/** A credential shaped exactly like one the daemon holds — scrubbed by its format. */
const SEEDED_SECRET = 'sk-ant-api03-seededE2Esecret0123456789abcdefghijklmnop';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function until<T>(read: () => Promise<T>, pred: (v: T) => boolean, ms = 30_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T = await read();
  while (!pred(last)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 200));
    last = await read();
  }
  return last;
}

describe('project observability over the daemon\'s wire', () => {
  let ctx: TestContext;
  let docker: FakeDocker;
  let proofDir: string;
  let release: string;
  let fixCommit: string;
  let client: DaemonClient;

  beforeEach(async () => {
    proofDir = await mkdtemp(join(tmpdir(), 'lazy-obs-e2e-'));
    release = join(proofDir, 'release-export');
    docker = await installFakeDocker(proofDir);
    ctx = await setupTestLazy({ fakeClaude: true });

    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const onDocker = before.replace('type = "dangerously-host-process-without-any-isolation"', 'type = "docker"');
    if (onDocker === before) throw new Error('could not restore [runner] type = "docker" in the generated lazy.toml');
    await writeFile(configPath, onDocker);

    const main = await git(ctx.root, 'symbolic-ref', '--short', 'HEAD');
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), BROKEN);
    await git(ctx.root, 'add', 'Dockerfile.lazy', 'lazy.toml');
    await git(ctx.root, 'commit', '-q', '-m', 'a Dockerfile.lazy that does not build');
    await git(ctx.root, 'checkout', '-q', '-b', 'fix-image');
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), WORKING);
    await writeFile(join(ctx.root, '.gitattributes'), '* filter=held\n');
    await git(ctx.root, 'add', 'Dockerfile.lazy', '.gitattributes');
    await git(ctx.root, 'commit', '-q', '-m', 'a Dockerfile.lazy that builds');
    fixCommit = await git(ctx.root, 'rev-parse', 'HEAD');
    await git(ctx.root, 'checkout', '-q', main);
    // Defined only now, after every checkout: from here on, anything that
    // writes fix-image's files out of git waits for the release file.
    await git(ctx.root, 'config', 'filter.held.smudge', `sh -c 'while [ ! -f "${release}" ]; do sleep 0.05; done; cat'`);

    // The project image fails on this machine; the adoption's build is slow
    // enough to watch and cancel.
    await docker.failBuilds();
    await docker.buildOutput([
      '#4 [1/2] FROM docker.io/library/debian:bookworm-slim',
      '#4 CACHED',
      '#5 [2/2] RUN exit 1',
      `#5 0.120 token=${SEEDED_SECRET}`,
      '#5 ERROR: process "/bin/sh -c exit 1" did not complete successfully: exit code: 1',
    ].join('\n'));
    await ctx.restartDaemon({ PATH: `${docker.binDir}:${process.env.PATH ?? ''}` });
    const c = await DaemonClient.create(ctx.root);
    if (!c) throw new Error('no daemon client for the test project');
    client = c;
    await until(() => imageState(), (s) => s.state === 'failed', 60_000, 'the project image to fail');
  }, 120_000);

  afterEach(async () => {
    // Never leave a filter process waiting on a file that will not come.
    await writeFile(release, '').catch(() => {});
    await ctx.cleanup();
    await rm(proofDir, { recursive: true, force: true });
  });

  async function rpc(command: string, params: Record<string, unknown> = {}): Promise<any> {
    return client.rpc(command, ctx.root, params);
  }
  async function imageState(): Promise<any> {
    return (await rpc('runnerImage')).imageState;
  }

// INVARIANT: concurrent rebuild clicks start one job and the losing click
// names its log, rather than cancelling the first request's work.
test('overlapping cached and uncached rebuild clicks share one running build', async () => {
  await docker.slowBuilds(2);
  const before = (await docker.builds()).length;
  const outcomes = await Promise.allSettled([
    rpc('rebuildRunnerImage', { noCache: false }),
    rpc('rebuildRunnerImage', { noCache: true }),
  ]);
  const successes = outcomes.filter(r => r.status === 'fulfilled');
  const refusals = outcomes.filter(r => r.status === 'rejected');
  expect(successes).toHaveLength(1);
  expect(refusals).toHaveLength(1);
  const reply = successes[0]!.value;
  const buildId = reply.defaultBuild?.id ?? reply.imageState.build.id;
  expect(refusals[0]!.reason).toMatchObject({ status: 409, details: { buildId } });
  const finished = await until(
    () => rpc('imageBuildLog', { buildId }),
    page => page.build.outcome !== 'running', 30_000, 'the winning rebuild to finish',
  );
  expect(finished.build.outcome).not.toBe('cancelled');
  expect((await docker.builds()).length - before).toBe(1);
});

  // INVARIANT: completed image logs and summaries survive daemon restarts;
  // a build URL is a durable record rather than a process-local handle.
  test('completed image build history and full logs survive a daemon restart', async () => {
    await docker.buildOutput(Array.from({ length: 6000 }, (_, i) => '#5 0.1 archive-line-' + i).join('\n'));
    const rebuilding = await rpc('rebuildRunnerImage');
    const newId = rebuilding.imageState.build.id;
    const state = await until(imageState, s => s.build?.id === newId && s.state === 'failed', 60_000, 'the long build to fail');
    const id = state.build.id;
    const before = await rpc('imageBuildLog', { buildId: id });
    expect(before.build.outcome).toBe('failed');
    const allLines = [];
    let cursor = 0;
    while (true) {
      const page = await rpc('imageBuildLog', { buildId: id, after: cursor, limit: 2000 });
      allLines.push(...page.lines);
      if (!page.lines.length || page.next >= page.lastSeq) break;
      cursor = page.next;
    }
    expect(allLines.length).toBeGreaterThan(6000);
    expect(allLines.some(l => l.text.includes('archive-line-0'))).toBe(true);
    expect(allLines.some(l => l.text.includes('archive-line-5999'))).toBe(true);
    expect(JSON.stringify(before)).not.toContain(SEEDED_SECRET);
    await ctx.restartDaemon({ PATH: `${docker.binDir}:${process.env.PATH ?? ''}` });
    client = (await DaemonClient.create(ctx.root))!;
    const after = await rpc('imageBuildLog', { buildId: id });
    expect(after.build.outcome).toBe('failed');
    expect(after.lines).toEqual(before.lines);
    const listing = await rpc('imageBuildLog', { list: true });
    expect(listing.builds.some((b: any) => b.id === id)).toBe(true);
    expect(listing.logsKept).toBe(20);
  }, 120_000);

  // INVARIANT: adoption never blocks the request on the export (engineer,
  // 2026-10-03). The RPC answers while `git archive` is still held inside
  // git, and the export is a running step of the adoption's build log.
  test('adopt returns before the export finishes, and the export, verify and build stream in the log', async () => {
    const failed = await imageState();
    expect(failed.failure.step).toBe('[2/2] RUN exit 1');
    expect(JSON.stringify(failed)).not.toContain(SEEDED_SECRET);
    expect(failed.escalation.to).toBe('admin');

    const preview = await rpc('imageAdoptionPreview', { ref: 'fix-image' });
    expect(preview.candidate.commit).toBe(fixCommit);

    const started = Date.now();
    const adopted = await rpc('adoptImageFromRef', { ref: 'fix-image', commit: fixCommit, contentHash: preview.candidate.contentHash });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(adopted.adoptionBuild.state).toBe('building');
    expect(adopted.adoptionBuild.phase).toBe('exporting');
    // ONE state: the adoption, not the failed project image beside it.
    expect(adopted.imageState.state).toBe('adoption_in_progress');
    for (const noCache of [false, true]) {
      await expect(rpc('rebuildRunnerImage', { noCache })).rejects.toMatchObject({
        status: 409, details: { buildId: adopted.adoptionBuild.buildId },
      });
    }

    // The export really is still running: give it time, it does not finish.
    await new Promise((r) => setTimeout(r, 1_500));
    const held = await rpc('imageBuildLog', { buildId: adopted.adoptionBuild.buildId });
    expect(held.build.steps.find((s: any) => s.id === 'export').status).toBe('running');
    expect(held.build.progress.label).toContain('Export fix-image');
    expect((await imageState()).adoption.phase).toBe('exporting');

    // Let git finish; the adoption moves on to verify and the build, and a
    // reader holding a cursor sees only what is new.
    await rm(join(docker.stateDir, 'fail-build'));
    await rm(join(docker.stateDir, 'build-output'));
    await docker.slowBuilds(20);
    await writeFile(release, '');
    const building = await until(
      () => rpc('imageBuildLog', { buildId: adopted.adoptionBuild.buildId, after: held.next, waitMs: 2_000 }),
      (p) => p.build.steps.some((s: any) => s.id === 'verify' && s.status === 'done'),
      30_000, 'the verify step',
    );
    expect(building.lines.every((l: any) => l.seq > held.next)).toBe(true);
    expect(building.build.steps.find((s: any) => s.id === 'export').status).toBe('done');
    expect(building.build.steps.find((s: any) => s.id === 'export').durationMs).toBeGreaterThan(1_000);

    // Cancel: the docker build dies and the project is back to deciding what
    // to adopt — the failed project image, alone.
    await until(() => docker.buildPid(), (pid) => pid !== null, 20_000, 'the adoption\'s docker build');
    const cancelled = await rpc('cancelImageBuild', { buildId: adopted.adoptionBuild.buildId });
    expect(cancelled.cancelled).toBe(adopted.adoptionBuild.buildId);
    expect(cancelled.imageState.state).toBe('failed');
    const log = await rpc('imageBuildLog', { buildId: adopted.adoptionBuild.buildId });
    expect(log.build.outcome).toBe('cancelled');

    // Rebuild is non-blocking too, and the CLI streams the same log.
    const rebuilt = await rpc('rebuildRunnerImage');
    expect(rebuilt.imageState.state).toBe('building');
    const cli = await ctx.lazy(['system', 'runner-image', 'log', '--json']);
    expect(cli.exitCode, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout).build.id).toBe(rebuilt.imageState.build.id);
    const cancelCli = await ctx.lazy(['system', 'runner-image', 'cancel', '--json']);
    expect(cancelCli.exitCode, cancelCli.stderr).toBe(0);
    expect(JSON.parse(cancelCli.stdout).imageState.state).toBe('failed');
  }, 120_000);

  // INVARIANT: the machine's state is answered by the daemon, read-only, and
  // a secret in a service log never leaves it.
  test('machine state names the services and redacts their logs', async () => {
    await appendFile(getLogPath(ctx.root), `[proxy] seq=9 leaked ${SEEDED_SECRET}\n`);
    const machine = await rpc('machineState', { lines: 400 });
    const names = machine.services.map((s: any) => s.name);
    expect(names).toEqual(['dockerd', 'forwarder', 'daemon', 'proxy']);
    const byName = Object.fromEntries(machine.services.map((s: any) => [s.name, s]));
    expect(byName.daemon.state).toBe('running');
    expect(byName.proxy.state).toBe('running');
    expect(byName.dockerd.state).toBe('running');
    expect(byName.forwarder.state).toBe('not_applicable');
    expect(byName.proxy.log.lines.some((l: string) => l.includes('leaked <redacted>'))).toBe(true);
    expect(JSON.stringify(machine)).not.toContain(SEEDED_SECRET);
    expect(machine.resources.memory.totalBytes).toBeGreaterThan(0);

    // Off a Teams microVM there is nothing of lazy's to restart.
    await expect(rpc('restartMachineService', { service: 'dockerd' })).rejects.toThrow(/not a Lazy Teams microVM/);

    const cli = await ctx.lazy(['system', 'machine']);
    expect(cli.exitCode, cli.stderr).toBe(0);
    expect(cli.stdout).toContain('Task proxy: running');
  }, 60_000);
});
